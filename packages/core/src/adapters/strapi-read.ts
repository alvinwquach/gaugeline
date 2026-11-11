import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import type { StrapiAdapter, StrapiPublicDrafts } from "./strapi.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { addressOf, askPage, bare, type PageRead } from "./webflow-read.js";

/** Bounds a Strapi read keeps to. There are no flags to raise them. */
export const STRAPI_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/**
 * What the two Strapi checks need, read once: how the live site answered for each published entry
 * that has an address, what a visitor with no token can list of the unpublished (only when the owner
 * consented), and what could not be read. Ids, slugs, addresses, statuses and counts only: never a
 * field.
 */
export interface StrapiReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: PageRead[];
  /** The owner agreed to probing checks. Without it nothing was asked of the draft routes. */
  ownerConsent: boolean;
  /** What a visitor with no token can list, by collection. Empty without consent. */
  publicDrafts: StrapiPublicDrafts[];
  /** Collections the token would not give, with why. */
  unreadable: { type: string; reason: string }[];
  /** Collections with published entries and no address pattern in the settings: their pages were not asked. */
  withoutPattern: string[];
  /** Published entries in a collection with a pattern that could not be given an address. */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Published entries with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadStrapiOptions {
  adapter: StrapiAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://brass-anchor.example. */
  site: string;
  /** Only these collections. Default: all the settings name. */
  types?: readonly string[];
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces STRAPI_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/**
 * Read a Strapi site for the Strapi checks: the published list of each collection (what the CMS says
 * is live) and, for each entry the settings give an address for, one GET of that page on the live
 * site. With the owner's consent, also what a visitor with no token can list of the unpublished. A
 * collection the token may not read is recorded with its reason and the others are still read; a rate
 * limit that stays ends the read and marks it partial.
 */
export async function readStrapi(options: ReadStrapiOptions): Promise<StrapiReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? STRAPI_READ_LIMITS.pages;
  const reading: StrapiReading = {
    site: origin,
    pages: [],
    ownerConsent: options.ownerConsent === true,
    publicDrafts: [],
    unreadable: [],
    withoutPattern: [],
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  const todo: Omit<PageRead, "answer">[] = [];
  const resolve = adapter.resolveUrl;
  const names = adapter
    .collections()
    .filter((s) => options.types === undefined || options.types.includes(s));

  for (const type of names) {
    try {
      const got = await collectPublished(adapter, { types: [type] });
      const patterned = (resolve?.({ id: "probe", type, slug: "probe" }) ?? "") !== "";
      if (got.docs.length > 0 && !patterned) reading.withoutPattern.push(type);
      if (patterned)
        for (const d of got.docs) {
          const raw =
            resolve?.({ id: d.id, type, ...(d.slug !== undefined ? { slug: d.slug } : {}) }) ?? "";
          const url = addressOf(raw, origin);
          if (url === undefined) {
            reading.unaddressed.push({
              type,
              id: d.id,
              reason:
                d.slug === undefined
                  ? "it has no slug, and the address pattern needs one"
                  : "the address pattern did not make a usable address from its slug",
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
        reading.unreadable.push({ type, reason: err.reason });
        continue;
      }
      throw err;
    }
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

  // The one read that asks for what the owner did not publish: only with consent (CLAUDE.md rule 14).
  if (reading.ownerConsent && !reading.partial) {
    try {
      reading.publicDrafts = await adapter.publicDrafts({ types: names });
    } catch (err) {
      if (!(err instanceof AdapterRateLimitedError)) throw err;
      reading.publicDrafts = err.partial as StrapiPublicDrafts[];
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: reading.publicDrafts.length,
      };
    }
  }
  return reading;
}
