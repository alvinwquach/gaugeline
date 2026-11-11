import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import type { JoomlaAdapter, JoomlaPublicApi, JoomlaSkipped } from "./joomla.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { addressOf, askPage, bare, type PageRead } from "./webflow-read.js";

/** Bounds a Joomla read keeps to. There are no flags to raise them. */
export const JOOMLA_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/**
 * What the two Joomla checks need, read once: how the live site answered for each published article that has an
 * address, and (only with the owner's consent) what a visitor with no token is told by the article list route. Ids,
 * aliases, addresses, statuses and counts only: never a title or any text.
 */
export interface JoomlaReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: PageRead[];
  /** The owner agreed to probing checks. Without it nothing was asked of the Web Services API as a visitor. */
  ownerConsent: boolean;
  /** The settings say (`expectPrivate`) the Web Services API is meant to be private. Without it the visitor read is not made. */
  expectedPrivate: boolean;
  /** What a visitor with no token is told. Absent without consent, or when the read stopped before it. */
  publicApi?: JoomlaPublicApi;
  /** Why the articles could not be read (the token was refused, the list was too big), when they could not. */
  unreadable?: string;
  /** Names in the settings that are not articles: the adapter reads nothing else. */
  unknownTypes: string[];
  /** The read worked and no published article came back: never a pass. */
  noArticles: boolean;
  /** The settings give no address pattern for articles (`urls`), and the API gives no address, so no page was asked. */
  noPattern: boolean;
  /** Published articles that could not be given an address (no usable alias for the pattern). */
  unaddressed: { id: string; reason: string }[];
  /** Published articles with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Published articles left out because no page is expected for a visitor, or the address is not known. */
  skipped: JoomlaSkipped;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadJoomlaOptions {
  adapter: JoomlaAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://larkspur-yoga.example. */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces JOOMLA_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/**
 * Read a Joomla site for the Joomla checks: the Published list of articles (what the CMS says is live) and, for
 * each article that has an address (the settings' `urls` pattern; the API gives none), one GET of that page on the
 * live site. With the owner's consent, also one anonymous GET of the article list route. A read the token is
 * refused is recorded with its reason; a rate limit that stays ends the read and marks it partial.
 */
export async function readJoomla(options: ReadJoomlaOptions): Promise<JoomlaReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? JOOMLA_READ_LIMITS.pages;
  const reading: JoomlaReading = {
    site: origin,
    pages: [],
    ownerConsent: options.ownerConsent === true,
    expectedPrivate: adapter.privacyExpected(),
    unknownTypes: adapter.unknownTypes(),
    noArticles: false,
    noPattern: false,
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
    skipped: { notPublic: 0, scheduled: 0, expired: 0, otherLanguage: 0 },
  };
  const todo: Omit<PageRead, "answer">[] = [];
  const patterned =
    (adapter.resolveUrl?.({ id: "1", type: "articles", slug: "probe" }) ?? "") !== "";
  reading.noPattern = !patterned;

  try {
    const got = await collectPublished(adapter, { types: ["articles"] });
    if (got.partial) reading.partial = got.partial;
    reading.skipped = adapter.skipped();
    for (const d of got.docs) {
      const url = d.url === undefined ? undefined : addressOf(d.url, origin);
      if (url === undefined) {
        if (patterned)
          reading.unaddressed.push({
            id: d.id,
            reason:
              "its alias cannot be put in the address pattern (it has none, or it has characters a path may not)",
          });
        continue;
      }
      todo.push({
        id: d.id,
        type: d.type,
        ...(d.slug !== undefined ? { slug: d.slug } : {}),
        url: url.href,
        path: url.pathname,
      });
    }
    reading.noArticles =
      got.docs.length === 0 &&
      !got.partial &&
      reading.skipped.notPublic +
        reading.skipped.scheduled +
        reading.skipped.expired +
        reading.skipped.otherLanguage ===
        0;
  } catch (err) {
    if (!(err instanceof AdapterCouldNotCheck)) throw err;
    reading.unreadable = err.reason;
  }

  const asked = todo.slice(0, budget);
  reading.pagesSkipped = todo.length - asked.length;
  reading.pages = await Promise.all(
    asked.map(async (p): Promise<PageRead> => {
      if (bare(new URL(p.url).host) !== bare(new URL(origin).host))
        return {
          ...p,
          answer: {
            kind: "unread",
            reason: `its address pattern points to another site (${new URL(p.url).host}), which is not the site being checked`,
          },
        };
      return { ...p, answer: await askPage(fetcher, p.url) };
    }),
  );

  // The one read that asks the API as a visitor: only with consent (CLAUDE.md rule 14), and only when the owner has
  // said so in the settings (a token being set does not say it).
  if (reading.ownerConsent && reading.expectedPrivate && !reading.partial) {
    try {
      reading.publicApi = await adapter.publicApi();
    } catch (err) {
      if (err instanceof AdapterCouldNotCheck) {
        reading.publicApi = { state: "unread", reason: err.reason };
      } else if (err instanceof AdapterRateLimitedError) {
        reading.partial = {
          reason: "rate-limited",
          ...(err.retry !== undefined ? { retry: err.retry } : {}),
          delivered: reading.pages.length,
        };
      } else throw err;
    }
  }
  return reading;
}
