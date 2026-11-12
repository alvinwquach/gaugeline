import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import type { PrismicAdapter, PrismicMasterReading, PrismicReleaseReading } from "./prismic.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { addressOf, askPage, bare, type PageRead } from "./webflow-read.js";

/** Bounds a Prismic read keeps to. There are no flags to raise them. */
export const PRISMIC_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/**
 * What the three Prismic checks need, read once: how the live site answered for each published document that has
 * an address, what the master ref is at the public cache and at the origin, and (only with the owner's consent and
 * the settings entry) what the releases hold. Ids, types, addresses, times and counts only: never a field.
 */
export interface PrismicReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: PageRead[];
  /** The owner agreed to probing checks. Without it no release was read. */
  ownerConsent: boolean;
  /** The settings say `checkReleases: true`. Without it no release was read. */
  releasesEnabled: boolean;
  /** The two hosts' master refs. `unread` when they could not be read (`reason` says why). */
  master: PrismicMasterReading | { state: "unread"; reason: string };
  /** What each release holds. Empty unless consent and the settings entry were both given. */
  releases: PrismicReleaseReading[];
  /** Set when the releases could not be read at all. */
  releasesError?: string;
  /** Set when the repository's document types could not be read: nothing else about documents was asked. */
  unreadable?: string;
  /** No page pattern is in the settings (`urls`), so no document's page was asked for. */
  nothingNamed: boolean;
  /** Types with published documents and no address pattern in the settings: their pages were not asked. */
  withoutPattern: string[];
  /** Types the repository could not list, with why. */
  unreadableTypes: { type: string; reason: string }[];
  /** Published documents in a type with a pattern that could not be given an address. */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Published documents with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadPrismicOptions {
  adapter: PrismicAdapter;
  /** The fetcher for the live site's own pages (the adapter has its own for the repository). */
  fetcher: Fetcher;
  /** The address of the live site, such as https://larkspur-yoga.example. */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces PRISMIC_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/**
 * Read a Prismic site for the Prismic checks: the published list of each type that has an address pattern, one GET of
 * that page on the live site for each document, the master ref at the cache and at the origin and, with the owner's
 * consent and `checkReleases`, what each release holds. A type the repository would not list is recorded with its
 * reason and the others are still read; a rate limit that stays ends the read and marks it partial.
 */
export async function readPrismic(options: ReadPrismicOptions): Promise<PrismicReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? PRISMIC_READ_LIMITS.pages;
  const reading: PrismicReading = {
    site: origin,
    pages: [],
    ownerConsent: options.ownerConsent === true,
    releasesEnabled: adapter.checkReleases(),
    master: { state: "unread", reason: "not asked" },
    releases: [],
    nothingNamed: adapter.patternTypes().length === 0,
    withoutPattern: [],
    unreadableTypes: [],
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  const todo: Omit<PageRead, "answer">[] = [];

  try {
    const counts = await adapter.types();
    for (const { name: type, count } of counts) {
      const patterned = (adapter.resolveUrl?.({ id: "probe", type, slug: "probe" }) ?? "") !== "";
      if (!patterned) {
        if (count > 0) reading.withoutPattern.push(type);
        continue;
      }
      if (count === 0) continue;
      try {
        const got = await collectPublished(adapter, { types: [type] });
        for (const d of got.docs) {
          const url = d.url === undefined ? undefined : addressOf(d.url, origin);
          if (url === undefined) {
            reading.unaddressed.push({
              type,
              id: d.id,
              reason:
                "it has no address: the pattern needs a uid it does not have (or its uid cannot be put in an address), or it is in a language other than the repository's main one (Gaugeline does not guess locale paths)",
            });
            continue;
          }
          todo.push({
            id: d.id,
            type,
            ...(d.slug !== undefined ? { slug: d.slug } : {}),
            url: url.href,
            path: url.pathname,
          });
        }
        if (got.partial) {
          reading.partial = got.partial;
          break;
        }
      } catch (err) {
        if (err instanceof AdapterCouldNotCheck) {
          reading.unreadableTypes.push({ type, reason: err.reason });
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof AdapterCouldNotCheck) reading.unreadable = err.reason;
    else if (err instanceof AdapterRateLimitedError)
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: 0,
      };
    else throw err;
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

  // The refs are metadata of the published repository, not content: always read.
  try {
    reading.master = await adapter.masterRefs();
  } catch (err) {
    if (err instanceof AdapterCouldNotCheck)
      reading.master = { state: "unread", reason: err.reason };
    else if (err instanceof AdapterRateLimitedError) {
      reading.master = { state: "unread", reason: "the platform asked Gaugeline to slow down" };
      reading.partial ??= {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: reading.pages.length,
      };
    } else throw err;
  }

  // The one read of unpublished content: only with consent and the settings entry (CLAUDE.md rule 14).
  if (reading.ownerConsent && reading.releasesEnabled && !reading.partial) {
    try {
      reading.releases = await adapter.releaseReadings({ ownerConsent: reading.ownerConsent });
    } catch (err) {
      if (err instanceof AdapterCouldNotCheck) reading.releasesError = err.reason;
      else if (err instanceof AdapterRateLimitedError)
        reading.partial = {
          reason: "rate-limited",
          ...(err.retry !== undefined ? { retry: err.retry } : {}),
          delivered: 0,
        };
      else throw err;
    }
  }
  return reading;
}
