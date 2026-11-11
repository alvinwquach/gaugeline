import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import type { UmbracoAdapter, UmbracoPublicApi } from "./umbraco.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { addressOf, askPage, bare, type PageRead } from "./webflow-read.js";

/** Bounds an Umbraco read keeps to. There are no flags to raise them. */
export const UMBRACO_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/**
 * What the two Umbraco checks need, read once: how the live site answered for each published node that has an
 * address, and (only with the owner's consent) what a visitor with no key is told by the Delivery API. Ids,
 * slugs, addresses, statuses and counts only: never a name or a property.
 */
export interface UmbracoReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: PageRead[];
  /** The owner agreed to probing checks. Without it nothing was asked of the Delivery API as a visitor. */
  ownerConsent: boolean;
  /** The settings say (`expectPrivate`) the Delivery API is meant to be private. Without it the visitor read is not made. */
  expectedPrivate: boolean;
  /** What a visitor with no key is told. Absent without consent, or when the read stopped before it. */
  publicApi?: UmbracoPublicApi;
  /** Content types the API would not give, with why. */
  unreadable: { type: string; reason: string }[];
  /** The settings name no content type (the API lists none), so nothing was read: both checks are could-not-check, not a pass. */
  nothingNamed: boolean;
  /** Published nodes that could not be given an address (no route from the API and no pattern in the settings). */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Published nodes with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadUmbracoOptions {
  adapter: UmbracoAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://marigold-lane.example. */
  site: string;
  /** Only these content types. Default: all the settings name. */
  types?: readonly string[];
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces UMBRACO_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/**
 * Read an Umbraco site for the Umbraco checks: the published list of each content type (what the CMS says is
 * live) and, for each node that has an address (the route the API gave, or the settings' pattern), one GET of that
 * page on the live site. With the owner's consent, also one anonymous GET of the Delivery API's list route. A type
 * the key may not read is recorded with its reason and the others are still read; a rate limit that stays ends the
 * read and marks it partial.
 */
export async function readUmbraco(options: ReadUmbracoOptions): Promise<UmbracoReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? UMBRACO_READ_LIMITS.pages;
  const reading: UmbracoReading = {
    site: origin,
    pages: [],
    ownerConsent: options.ownerConsent === true,
    expectedPrivate: adapter.privacyExpected(),
    unreadable: [],
    nothingNamed: adapter.collections().length === 0,
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  // Nothing is asked of the CMS or the site when there is nothing to ask about.
  if (reading.nothingNamed) return reading;

  const todo: Omit<PageRead, "answer">[] = [];
  const names = adapter
    .collections()
    .filter((s) => options.types === undefined || options.types.includes(s));

  for (const type of names) {
    try {
      const got = await collectPublished(adapter, { types: [type] });
      for (const d of got.docs) {
        const url = d.url === undefined ? undefined : addressOf(d.url, origin);
        if (url === undefined) {
          reading.unaddressed.push({
            type,
            id: d.id,
            reason:
              "the Delivery API gave it no route, and the settings have no address pattern for its type",
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

  // The one read that asks the API as a visitor: only with consent (CLAUDE.md rule 14), and only when the owner has
  // said so in the settings (a key being set does not say it: Umbraco's preview needs the key on a public API).
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
