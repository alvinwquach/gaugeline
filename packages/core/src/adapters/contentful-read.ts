import type { Fetcher } from "../fetcher.js";
import { collectPublished, type PartialRead } from "./collect.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError, type ContentAdapter } from "./types.js";

/** Bounds a Contentful read keeps to. There are no flags to raise them. */
export const CONTENTFUL_READ_LIMITS = {
  /** Live pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 300,
} as const;

/** How the live site answered for one published entry's page. */
export type ContentfulPageAnswer =
  | { kind: "page"; status: number }
  | { kind: "missing"; status: number }
  | { kind: "unread"; reason: string };

export interface ContentfulPageRead {
  id: string;
  type: string;
  slug?: string;
  /** The address asked for, in full. */
  url: string;
  /** Its path, for the words a finding uses. */
  path: string;
  answer: ContentfulPageAnswer;
}

/**
 * What the Contentful check needs, read once: how the live site answered for each published entry
 * that has an address, and what could not be read. Ids, slugs, addresses and statuses only: never a
 * field value.
 */
export interface ContentfulReading {
  /** The origin of the live site that was asked. */
  site: string;
  pages: ContentfulPageRead[];
  /** Content types whose entries the platform would not give, with why. */
  unreadable: { type: string; reason: string }[];
  /** Content types with published entries and no address pattern in the settings: their pages were not asked. */
  withoutPattern: string[];
  /** Published entries in a type with a pattern that could not be given an address (no slug, or one the pattern cannot use). */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Published entries with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadContentfulOptions {
  adapter: ContentAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://ash-and-ember.example. */
  site: string;
  /** Only these content types. Default: all. */
  types?: readonly string[];
  /** Replaces CONTENTFUL_READ_LIMITS.pages. For tests. */
  maxPages?: number;
}

const bare = (host: string): string => host.toLowerCase().replace(/^www\./, "");

function addressOf(raw: string, origin: string): URL | undefined {
  if (raw === "") return undefined;
  try {
    return new URL(raw, origin);
  } catch {
    return undefined;
  }
}

/** One page, asked with GET through the fetcher: a 2xx is there, 404 and 410 are gone, anything else is not an answer. */
async function askPage(fetcher: Fetcher, url: string): Promise<ContentfulPageAnswer> {
  try {
    const last = (await fetcher.get(url)).at(-1);
    if (!last) return { kind: "unread", reason: "no answer" };
    if (last.status >= 200 && last.status < 300) return { kind: "page", status: last.status };
    if (last.status === 404 || last.status === 410) return { kind: "missing", status: last.status };
    return { kind: "unread", reason: `the site answered ${last.status}` };
  } catch (err) {
    return { kind: "unread", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read a Contentful site for the page check: the published entries of each content type (what the
 * CMS says is live) and, for each one the settings give an address for, one GET of that page on the
 * live site. A content type the token may not read is recorded with its reason and the others are
 * still read; a rate limit that stays ends the read and marks it partial. A token the platform
 * refuses stops the whole read with the reason (the adapter throws it), never a clean result.
 */
export async function readContentful(options: ReadContentfulOptions): Promise<ContentfulReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? CONTENTFUL_READ_LIMITS.pages;
  const reading: ContentfulReading = {
    site: origin,
    pages: [],
    unreadable: [],
    withoutPattern: [],
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  const todo: Omit<ContentfulPageRead, "answer">[] = [];
  const resolve = adapter.resolveUrl;

  let names: string[] = [];
  try {
    names = (await adapter.types())
      .map((t) => t.name)
      .filter((n) => options.types === undefined || options.types.includes(n));
  } catch (err) {
    if (!(err instanceof AdapterRateLimitedError)) throw err;
    reading.partial = {
      reason: "rate-limited",
      ...(err.retry !== undefined ? { retry: err.retry } : {}),
      delivered: 0,
    };
  }
  for (const type of names) {
    try {
      const got = await collectPublished(adapter, { types: [type] });
      const patterned = (resolve?.({ id: "probe", type, slug: "probe" }) ?? "") !== "";
      if (got.docs.length > 0 && !patterned) reading.withoutPattern.push(type);
      if (patterned)
        for (const d of got.docs) {
          const url = addressOf(
            resolve?.({ id: d.id, type, ...(d.slug !== undefined ? { slug: d.slug } : {}) }) ?? "",
            origin,
          );
          if (url === undefined) {
            reading.unaddressed.push({
              type,
              id: d.id,
              reason:
                d.slug === undefined
                  ? "it has no slug (or one that is not a plain address part: letters, digits, dot, hyphen and underscore), and the address pattern needs one"
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
    asked.map(async (p): Promise<ContentfulPageRead> => {
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
