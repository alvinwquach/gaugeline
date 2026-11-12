import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import type { DirectusAdapter, DirectusPublicCollection } from "./directus.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { addressOf, askPage, bare, type PageRead } from "./webflow-read.js";

/** Bounds a Directus read keeps to. There are no flags to raise them. */
export const DIRECTUS_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/**
 * What the two Directus checks need, read once: how the live site answered for each published item that has an
 * address, what a visitor with no token can list of the collections the settings mark private (only when the
 * owner consented), and what could not be read. Ids, slugs, addresses, statuses and counts only: never a field.
 */
export interface DirectusReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: PageRead[];
  /** The owner agreed to probing checks. Without it nothing was asked as a visitor. */
  ownerConsent: boolean;
  /** The collections the settings mark private (`privateCollections`). */
  markedPrivate: string[];
  /** What a visitor with no token can list of them. Empty without consent. */
  publicCollections: DirectusPublicCollection[];
  /** Collections the token would not give, with why. */
  unreadable: { type: string; reason: string }[];
  /** The settings name no collection to read, so no item was read: the page check is could-not-check, not a pass. */
  nothingNamed: boolean;
  /** Collections with published items and no address pattern in the settings: their pages were not asked. */
  withoutPattern: string[];
  /** Published items in a collection with a pattern that could not be given an address. */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Published items with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadDirectusOptions {
  adapter: DirectusAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://larkspur-yoga.example. */
  site: string;
  /** Only these collections. Default: all the settings name. */
  types?: readonly string[];
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces DIRECTUS_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/**
 * Read a Directus site for the Directus checks: the published list of each named collection (what the CMS says is
 * live) and, for each item the settings give an address for, one GET of that page on the live site. With the
 * owner's consent, also one tokenless GET per collection the settings mark private. A collection the token may
 * not read is recorded with its reason and the others are still read; a rate limit that stays ends the read and
 * marks it partial.
 */
export async function readDirectus(options: ReadDirectusOptions): Promise<DirectusReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? DIRECTUS_READ_LIMITS.pages;
  const reading: DirectusReading = {
    site: origin,
    pages: [],
    ownerConsent: options.ownerConsent === true,
    markedPrivate: adapter.privateCollections(),
    publicCollections: [],
    unreadable: [],
    nothingNamed: adapter.collections().length === 0,
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

  // The one read that asks for what the owner marked private, as a visitor: only with consent (CLAUDE.md rule 14).
  if (reading.ownerConsent && reading.markedPrivate.length > 0 && !reading.partial) {
    try {
      reading.publicCollections = await adapter.publicCollections();
    } catch (err) {
      if (!(err instanceof AdapterRateLimitedError)) throw err;
      reading.publicCollections = err.partial as DirectusPublicCollection[];
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: reading.publicCollections.length,
      };
    }
  }
  return reading;
}
