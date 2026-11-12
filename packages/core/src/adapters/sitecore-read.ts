import { retryAfterSeconds } from "../connectors/http.js";
import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import { safePath } from "./craft.js";
import type { SitecoreAdapter, SitecorePreview } from "./sitecore.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError, type PublishedDoc } from "./types.js";
import { addressOf, bare, type PageAnswer, type PageRead } from "./webflow-read.js";

/** Bounds a Sitecore read keeps to. There are no flags to raise them. */
export const SITECORE_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/**
 * What the two Sitecore checks need, read once: how the live site answered for each route Experience Edge says is
 * published, and (only with the owner's consent) what the preview endpoint's path does on the public site. Paths,
 * languages, addresses, statuses and counts only: never a page's text or a field.
 */
export interface SitecoreReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: PageRead[];
  /** The owner agreed to probing checks. Without it nothing was asked of the preview path. */
  ownerConsent: boolean;
  /** The settings say (`expectPrivate`) the preview endpoint is not meant to answer on the public site. Without it the preview read is not made. */
  expectedPrivate: boolean;
  /** What the preview path did. Absent without consent or the setting, or when the read stopped before it. */
  preview?: SitecorePreview;
  /** Languages Experience Edge would not give, with why (identical reasons are one entry naming every language). */
  unreadable: { type: string; reason: string }[];
  /** Languages that gave no published route at all: a mistyped site name or language, or nothing published to Edge. Never a pass. */
  emptyLanguages: string[];
  /** Routes that could not be given an address (a language with no urls prefix that is not the first, an address on another site), counted by language and reason. */
  unaddressed: { type: string; count: number; reason: string }[];
  /** The live site answered 429 (slow down): the pages after that were not asked. */
  liveSlowDown?: { notAsked: number; retry?: string };
  /** Routes with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadSitecoreOptions {
  adapter: SitecoreAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://larkspur-yoga.example. */
  site: string;
  /** Only these languages. Default: all the settings name. */
  types?: readonly string[];
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces SITECORE_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/** Pages asked at the same moment. The fetcher itself never has more than five in flight. */
const PAGE_GROUP = 5;

/** What one live page said, and whether the site asked Gaugeline to slow down. */
async function askLivePage(
  fetcher: Fetcher,
  url: string,
  origin: string,
): Promise<{ answer: PageAnswer; slow: boolean; retry?: string }> {
  try {
    const hops = await fetcher.get(url);
    const last = hops.at(-1);
    if (!last) return { answer: { kind: "unread", reason: "no answer" }, slow: false };
    if (last.status === 429) {
      const wait = retryAfterSeconds(last.headers);
      return {
        answer: { kind: "unread", reason: "the site asked Gaugeline to slow down (429)" },
        slow: true,
        ...(wait !== undefined ? { retry: `in ${wait} seconds` } : {}),
      };
    }
    if (last.status >= 200 && last.status < 300)
      return { answer: { kind: "page", status: last.status }, slow: false };
    if (last.status === 404 || last.status === 410) {
      // A page that redirected to another site and is missing there is that site's missing page, not this site's.
      let finalHost = "";
      try {
        finalHost = new URL(last.url).host;
      } catch {
        finalHost = "";
      }
      if (hops.length > 1 && bare(finalHost) !== bare(new URL(origin).host))
        return {
          answer: {
            kind: "unread",
            reason: `the page redirected to another site (${finalHost}), which answered ${last.status}`,
          },
          slow: false,
        };
      return { answer: { kind: "missing", status: last.status }, slow: false };
    }
    return { answer: { kind: "unread", reason: `the site answered ${last.status}` }, slow: false };
  } catch (err) {
    return {
      answer: { kind: "unread", reason: err instanceof Error ? err.message : String(err) },
      slow: false,
    };
  }
}

/**
 * For each language that has a page the live site did not have, ask Experience Edge for that language's routes
 * again. A route still listed keeps its finding. A route no longer listed, and any language whose second read fails
 * or stops, becomes could-not-check: Gaugeline reports "published" only with a second answer that says so.
 */
async function confirmMissing(adapter: SitecoreAdapter, reading: SitecoreReading): Promise<void> {
  const languages = new Set(
    reading.pages.filter((p) => p.answer.kind === "missing").map((p) => p.type),
  );
  for (const language of languages) {
    let still: Set<string> | undefined;
    let why = "";
    try {
      const got = await collectPublished(adapter, { types: [language] });
      if (got.partial) why = "Experience Edge asked Gaugeline to slow down";
      else still = new Set(got.docs.map((d) => d.id));
    } catch (err) {
      why = err instanceof AdapterCouldNotCheck ? err.reason : "it could not be read";
    }
    for (const p of reading.pages) {
      if (p.type !== language || p.answer.kind !== "missing") continue;
      if (still === undefined)
        p.answer = {
          kind: "unread",
          reason: `Experience Edge could not be asked again to confirm the route is still published (${why})`,
        };
      else if (!still.has(p.id))
        p.answer = {
          kind: "unread",
          reason: "the route was no longer published when Experience Edge was asked again",
        };
    }
  }
}

/**
 * Read a Sitecore site for the Sitecore checks: the published routes of each language (what Experience Edge says
 * is live) and, for each route that has an address, one GET of that page on the live site. A language the token
 * may not read is recorded with its reason and the others are still read; a rate limit that stays ends the read
 * and marks it partial. With the owner's consent and the `expectPrivate` setting, also one GET, with no key, of the
 * preview endpoint's path on the live site's host.
 */
export async function readSitecore(options: ReadSitecoreOptions): Promise<SitecoreReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? SITECORE_READ_LIMITS.pages;
  const reading: SitecoreReading = {
    site: origin,
    pages: [],
    ownerConsent: options.ownerConsent === true,
    expectedPrivate: adapter.privacyExpected(),
    unreadable: [],
    emptyLanguages: [],
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };

  const todo: Omit<PageRead, "answer">[] = [];
  const unaddressed = new Map<string, { type: string; count: number; reason: string }>();
  const noAddress = (type: string, reason: string): void => {
    const key = `${type}\u0000${reason}`;
    const known = unaddressed.get(key);
    if (known) known.count++;
    else unaddressed.set(key, { type, count: 1, reason });
  };
  const failures = new Map<string, string[]>();
  for (const language of adapter
    .languages()
    .filter((l) => options.types === undefined || options.types.includes(l))) {
    let docs: PublishedDoc[];
    try {
      const got = await collectPublished(adapter, { types: [language] });
      docs = got.docs;
      if (got.partial) reading.partial = got.partial;
      if (docs.length === 0 && !got.partial) reading.emptyLanguages.push(language);
    } catch (err) {
      if (!(err instanceof AdapterCouldNotCheck)) throw err;
      failures.set(err.reason, [...(failures.get(err.reason) ?? []), language]);
      continue;
    }
    for (const d of docs) {
      const url = d.url === undefined ? undefined : addressOf(d.url, origin);
      if (url === undefined) {
        noAddress(
          language,
          "its address in this language is not known: the settings have no urls prefix for it (add one, such as /fr-ca)",
        );
        continue;
      }
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username !== "" ||
        bare(url.host) !== bare(new URL(origin).host)
      ) {
        noAddress(
          language,
          `its address prefix points to another site (${url.host}), which is not the site being checked`,
        );
        continue;
      }
      // The address is built again from the checked site's own origin and a path that passed the same rules as every path.
      const plain = safePath(url.pathname);
      if (plain === undefined) {
        noAddress(language, "its address is not a plain path on the site");
        continue;
      }
      todo.push({
        id: d.id,
        type: language,
        url: new URL(plain, origin).href,
        path: plain,
      });
    }
    if (reading.partial) break;
  }
  reading.unaddressed.push(...unaddressed.values());
  for (const [reason, languages] of failures)
    reading.unreadable.push({ type: languages.join(", "), reason });

  const asked = todo.slice(0, budget);
  reading.pagesSkipped = todo.length - asked.length;
  // Pages are asked a few at a time. When the live site says to slow down (429) no later group is asked: the pages
  // left are named, never sent in a burst at a site that has already asked for less.
  const answered: PageRead[] = [];
  for (let at = 0; at < asked.length; at += PAGE_GROUP) {
    const group = await Promise.all(
      asked
        .slice(at, at + PAGE_GROUP)
        .map(async (p) => ({ p, got: await askLivePage(fetcher, p.url, origin) })),
    );
    for (const { p, got } of group) answered.push({ ...p, answer: got.answer });
    const slow = group.find((g) => g.got.slow);
    if (slow) {
      reading.liveSlowDown = {
        notAsked: asked.length - answered.length,
        ...(slow.got.retry !== undefined ? { retry: slow.got.retry } : {}),
      };
      break;
    }
  }
  reading.pages = answered;

  // A page that is missing is reported as "published to Edge" only if Edge still says so: the list was read before
  // the pages, and a route unpublished in between would otherwise be reported as published.
  await confirmMissing(adapter, reading);

  // The one read that asks a path a visitor is not meant to be sent to: only with consent (CLAUDE.md rule 14), and
  // only when the owner has said in the settings that the endpoint is meant to be private.
  if (reading.ownerConsent && reading.expectedPrivate && !reading.partial)
    try {
      reading.preview = await adapter.previewEndpoint(origin);
    } catch (err) {
      if (err instanceof AdapterRateLimitedError)
        reading.partial = {
          reason: "rate-limited",
          ...(err.retry !== undefined ? { retry: err.retry } : {}),
          delivered: reading.pages.length,
        };
      else throw err;
    }
  return reading;
}
