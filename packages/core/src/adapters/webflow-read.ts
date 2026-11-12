import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import type { WebflowAdapter, WebflowStagedItem } from "./webflow.js";

/** Bounds a Webflow read keeps to. There are no flags to raise them. */
export const WEBFLOW_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/** How the live site answered for one published item's page. */
export type PageAnswer =
  | { kind: "page"; status: number }
  | { kind: "missing"; status: number }
  | { kind: "unread"; reason: string };

export interface PageRead {
  id: string;
  type: string;
  slug?: string;
  /** The address asked for, in full. */
  url: string;
  /** Its path, for the words a finding uses. */
  path: string;
  answer: PageAnswer;
}

/** An item that is staged but not published, with the address its page has (or will have) when the settings give one. */
export interface StagedRead extends WebflowStagedItem {
  state: "staged" | "changed";
  url?: string;
}

/**
 * What the two Webflow checks need, read once: every item that is staged or changed, how the live
 * site answered for each published item that has an address, and what could not be read. Ids, slugs,
 * times, addresses and statuses only: never a name or a field.
 */
export interface WebflowReading {
  /** The origin of the live site that was asked. */
  site: string;
  staged: StagedRead[];
  pages: PageRead[];
  /** Collections whose items the platform would not give, with why (a closed collection, a missing scope). */
  unreadable: { type: string; reason: string }[];
  /** Collections with published items and no address pattern in the settings: their pages were not asked. */
  withoutPattern: string[];
  /** Published items in a collection with a pattern that could not be given an address (no slug, or a slug the pattern cannot use). */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Published items with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  /** The page budget this read kept to. */
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadWebflowOptions {
  adapter: WebflowAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://saltmarsh-supper.example. */
  site: string;
  /** Only these collections. Default: all. */
  types?: readonly string[];
  /** Replaces WEBFLOW_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

/** The address a pattern made, or undefined when it made none (no slug) or something that is not an address. */
export function addressOf(raw: string, origin: string): URL | undefined {
  if (raw === "") return undefined;
  try {
    return new URL(raw, origin);
  } catch {
    return undefined;
  }
}

export const bare = (host: string): string => host.toLowerCase().replace(/^www\./, "");

/** An address on the site being checked, or undefined: a finding never shows an address on another site. */
export function onSite(raw: string, origin: string): URL | undefined {
  const url = addressOf(raw, origin);
  return url !== undefined && bare(url.host) === bare(new URL(origin).host) ? url : undefined;
}

/** One page, asked with GET through the fetcher: a 2xx is there, 404 and 410 are gone, anything else is not an answer. */
export async function askPage(
  fetcher: Fetcher,
  url: string,
  options: {
    /**
     * The address is the page: an answer reached through a redirect to another path (not just a trailing slash)
     * is not that page, so it is "unread". Without it a redirect is followed and its final answer counts.
     */
    sameAddress?: boolean;
  } = {},
): Promise<PageAnswer> {
  try {
    const hops = await fetcher.get(url);
    const last = hops.at(-1);
    if (!last) return { kind: "unread", reason: "no answer" };
    if (options.sameAddress === true && hops.length > 1) {
      const trim = (u: string): string => new URL(u).pathname.replace(/\/+$/, "") || "/";
      if (trim(last.url) !== trim(url))
        return { kind: "unread", reason: `the address redirects to ${new URL(last.url).pathname}` };
    }
    if (last.status >= 200 && last.status < 300) return { kind: "page", status: last.status };
    if (last.status === 404 || last.status === 410) return { kind: "missing", status: last.status };
    return { kind: "unread", reason: `the site answered ${last.status}` };
  } catch (err) {
    return { kind: "unread", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read a Webflow site for the Webflow checks: the staged list of each collection (ids, states, times),
 * the live list (what the CMS says is published) and, for each published item the settings give an
 * address for, one GET of that page on the live site. A collection the token may not read is recorded
 * with its reason and the others are still read; a rate limit that stays ends the read and marks it
 * partial. A token with no cms:read stops the whole read with the reason (the adapter throws it), so
 * it can never come back as a clean result.
 */
export async function readWebflow(options: ReadWebflowOptions): Promise<WebflowReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? WEBFLOW_READ_LIMITS.pages;
  const reading: WebflowReading = {
    site: origin,
    staged: [],
    pages: [],
    unreadable: [],
    withoutPattern: [],
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  const todo: Omit<PageRead, "answer">[] = [];
  const resolve = adapter.resolveUrl;

  let names: string[] = [];
  try {
    names = (await adapter.collections())
      .map((c) => c.slug)
      .filter((s) => options.types === undefined || options.types.includes(s));
  } catch (err) {
    // A token that may not read the CMS stops the read with its reason; a rate limit is a partial reading.
    if (!(err instanceof AdapterRateLimitedError)) throw err;
    reading.partial = {
      reason: "rate-limited",
      ...(err.retry !== undefined ? { retry: err.retry } : {}),
      delivered: 0,
    };
  }
  let readItems = 0;
  for (const type of names) {
    try {
      const stagedHere: StagedRead[] = [];
      for await (const s of adapter.staged({ types: [type] })) {
        readItems++;
        if (s.state === "staged" || s.state === "changed") {
          const url = onSite(
            resolve?.({ id: s.id, type, ...(s.slug !== undefined ? { slug: s.slug } : {}) }) ?? "",
            origin,
          );
          stagedHere.push({
            ...s,
            state: s.state,
            ...(url !== undefined ? { url: url.href } : {}),
          });
        }
      }
      const got = await collectPublished(adapter, { types: [type] });
      const live = got.docs;
      const patterned = (resolve?.({ id: "probe", type, slug: "probe" }) ?? "") !== "";
      reading.staged.push(...stagedHere);
      if (live.length > 0 && !patterned) reading.withoutPattern.push(type);
      if (!patterned) continue;
      for (const d of live) {
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
      if (err instanceof AdapterRateLimitedError) {
        reading.partial = {
          reason: "rate-limited",
          ...(err.retry !== undefined ? { retry: err.retry } : {}),
          delivered: readItems,
        };
        break;
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
  return reading;
}
