import type { Fetcher } from "../fetcher.js";
import { type PartialRead } from "./collect.js";
import type { CraftAdapter, CraftLiveEntry } from "./craft.js";
import { safePath } from "./craft.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { askPage, bare, type PageRead } from "./webflow-read.js";

/** Bounds a Craft read keeps to. There are no flags to raise them. */
export const CRAFT_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/** One live entry's page and how the live site answered for it. */
export interface CraftPageRead extends PageRead {
  /** The Craft site the entry is live on. */
  siteHandle: string;
}

/**
 * What the Craft check needs, read once: how the live site answered for each entry that is live on this site,
 * and what could not be read. Ids, site handles, slugs, addresses and statuses only: never a field.
 */
export interface CraftReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: CraftPageRead[];
  /** The key was refused before anything was read (a schema that can write): why. Nothing else was read. */
  keyRefused?: string;
  /** The settings name no section (Craft lists none to a token that did not opt in), so nothing was read. */
  nothingNamed: boolean;
  /** Sections Craft would not give, with why (a schema without the section, a refused key, a rate limit). */
  unreadable: { type: string; reason: string }[];
  /** Sections that returned no live entry. Craft does not say a section is missing from a schema: it may be empty, or closed to this key. */
  empty: string[];
  /** Live entries that could not be given an address, and why. */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Live entries whose page is on another site (another domain): they belong to that site's check and are not counted here. */
  otherSites: number;
  /** Live entries with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadCraftOptions {
  adapter: CraftAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site being checked, such as https://fernlight-studio.example. */
  site: string;
  /**
   * The Craft site handle this live site is. With it only that site's entries are read. Without it every site
   * is read and an entry counts for this site only when its own address is on this site's host.
   */
  craftSite?: string;
  /** Only these sections. Default: all the settings name. */
  types?: readonly string[];
  /** Replaces CRAFT_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/** The address an entry's page has on `origin`, or why it has none, or that it belongs to another site. */
function addressFor(
  e: CraftLiveEntry,
  origin: string,
): { url: URL } | { other: true } | { reason: string } {
  if (e.url === undefined)
    return {
      reason:
        "Craft gave it no address (its section has no URLs, or it is a headless site: add a urls pattern for the section in gaugeline.adapters.json)",
    };
  let url: URL;
  try {
    url = new URL(e.url, origin);
  } catch {
    return { reason: "its address is not one" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "")
    return { reason: "its address is not an http or https address" };
  if (bare(url.host) !== bare(new URL(origin).host))
    return e.patterned
      ? { reason: `the address pattern points to another site (${url.host})` }
      : { other: true };
  // The address is built again from the checked site's own origin and a path that passed the same rules as every path.
  const path = safePath(url.pathname);
  if (path === undefined) return { reason: "its address is not a plain path on the site" };
  return { url: new URL(path, origin) };
}

/**
 * Read a Craft install for the Craft check: the live entries of each named section (what the CMS says is
 * live, with the address each page should have) and, for each one on this site, one GET of that page on the
 * live site. A section Craft would not give is recorded with its reason and the others are still read; a
 * rate limit that stays ends the read and marks it partial; a token whose schema can write stops the read
 * before any content is asked for.
 */
export async function readCraft(options: ReadCraftOptions): Promise<CraftReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? CRAFT_READ_LIMITS.pages;
  const names = adapter
    .sections()
    .filter((s) => options.types === undefined || options.types.includes(s));
  const reading: CraftReading = {
    site: origin,
    pages: [],
    nothingNamed: adapter.sections().length === 0,
    unreadable: [],
    empty: [],
    unaddressed: [],
    otherSites: 0,
    pagesSkipped: 0,
    pageBudget: budget,
  };
  // Nothing is asked of the CMS or the site when there is nothing to ask about.
  if (reading.nothingNamed) return reading;

  try {
    await adapter.checkKey();
  } catch (err) {
    if (err instanceof AdapterRateLimitedError) {
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: 0,
      };
      return reading;
    }
    if (err instanceof AdapterCouldNotCheck) {
      reading.keyRefused = err.reason;
      return reading;
    }
    throw err;
  }

  const todo: Omit<CraftPageRead, "answer">[] = [];
  for (const type of names) {
    let seen = 0;
    try {
      for await (const e of adapter.liveEntries({
        types: [type],
        ...(options.craftSite !== undefined ? { site: options.craftSite } : {}),
      })) {
        seen++;
        const at = addressFor(e, origin);
        if ("other" in at) {
          reading.otherSites++;
          continue;
        }
        if ("reason" in at) {
          reading.unaddressed.push({ type, id: e.id, reason: at.reason });
          continue;
        }
        todo.push({
          id: e.id,
          type,
          siteHandle: e.siteHandle,
          ...(e.slug !== undefined ? { slug: e.slug } : {}),
          url: at.url.href,
          path: at.url.pathname,
        });
      }
      if (seen === 0) reading.empty.push(type);
    } catch (err) {
      if (err instanceof AdapterRateLimitedError) {
        reading.partial = {
          reason: "rate-limited",
          ...(err.retry !== undefined ? { retry: err.retry } : {}),
          delivered: todo.length + reading.otherSites + reading.unaddressed.length,
        };
        break;
      }
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
    asked.map(async (p): Promise<CraftPageRead> => ({
      ...p,
      answer: await askPage(fetcher, p.url),
    })),
  );
  return reading;
}
