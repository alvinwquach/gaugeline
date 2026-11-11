import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import { safePath } from "./craft.js";
import type { SitecoreAdapter, SitecorePreview } from "./sitecore.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError, type PublishedDoc } from "./types.js";
import { addressOf, askPage, bare, type PageRead } from "./webflow-read.js";

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
  /** Routes that could not be given an address (a language with no urls prefix that is not the first, an address on another site). */
  unaddressed: { type: string; id: string; reason: string }[];
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

/** The route path inside a doc's id (`<language>:<path>`). */
const pathOfId = (id: string, language: string): string => id.slice(language.length + 1);

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
      const path = pathOfId(d.id, language);
      const url = d.url === undefined ? undefined : addressOf(d.url, origin);
      if (url === undefined) {
        reading.unaddressed.push({
          type: language,
          id: path,
          reason:
            "its address in this language is not known: the settings have no urls prefix for it (add one, such as /fr-ca)",
        });
        continue;
      }
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username !== "" ||
        bare(url.host) !== bare(new URL(origin).host)
      ) {
        reading.unaddressed.push({
          type: language,
          id: path,
          reason: `its address prefix points to another site (${url.host}), which is not the site being checked`,
        });
        continue;
      }
      // The address is built again from the checked site's own origin and a path that passed the same rules as every path.
      const plain = safePath(url.pathname);
      if (plain === undefined) {
        reading.unaddressed.push({
          type: language,
          id: path,
          reason: "its address is not a plain path on the site",
        });
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
  for (const [reason, languages] of failures)
    reading.unreadable.push({ type: languages.join(", "), reason });

  const asked = todo.slice(0, budget);
  reading.pagesSkipped = todo.length - asked.length;
  reading.pages = await Promise.all(
    asked.map(async (p): Promise<PageRead> => ({ ...p, answer: await askPage(fetcher, p.url) })),
  );

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
