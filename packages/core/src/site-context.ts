import { Parser } from "htmlparser2";
import { NetworkError } from "./errors.js";
import type { Fetcher, Hop } from "./fetcher.js";
import { LIMITS, type Budget } from "./limits.js";
import { parseLlmsTxt, type LlmsFile } from "./llms.js";
import { parseRobots, type RobotsFile } from "./robots.js";
import { dedupeUrls } from "./sample.js";
import type { PageSnapshot } from "./snapshot.js";

/** One advertised feed, as read. itemLinks are kept for G12c, which compares feeds by them. */
export interface FeedRead {
  url: string;
  /** Every hop; [] when the feed could not be reached at all. */
  hops: Hop[];
  /** Bytes of body received (after decompression). */
  bytes: number;
  itemLinks: string[];
}

/** One sitemap file read: from robots.txt, the /sitemap.xml fallback, or a sitemap index. */
export interface SitemapRead {
  url: string;
  /** The final status, or null when it could not be reached. */
  status: number | null;
  kind: SitemapKind;
  /** How many <loc> entries it listed. */
  entries: number;
}

export type SitemapKind = "urlset" | "sitemapindex" | "unknown";

/**
 * How robots.txt answered:
 * - found: 2xx with a plain-text body (robots is set)
 * - missing: 4xx, or a body that is an HTML page; crawlers treat both as "everything allowed"
 * - unknown: 5xx or no answer; nothing can be said about the rules
 */
export type RobotsState = "found" | "missing" | "unknown";

/** /llms.txt, read like robots.txt: found, missing (4xx or an HTML page) or unknown (5xx). */
export interface LlmsRead {
  url: string;
  state: RobotsState;
  file: LlmsFile | null;
}

/** Read once per run, before the checks that need it, and shared by all of them. */
export interface SiteContext {
  robotsUrl: string;
  robots: RobotsFile | null;
  robotsState: RobotsState;
  /** Every sitemap file read, in the order read. */
  sitemaps: SitemapRead[];
  /** Page addresses listed by the sitemaps read, deduplicated, in document order. */
  sitemapUrls: string[];
  /** The sampled entries, in sitemapUrls order; [] for one that could not be reached. */
  sitemapSample: Hop[][];
  feeds: FeedRead[];
  llms: LlmsRead;
}

/** Strip a namespace prefix: <s:loc> reads as loc. */
function local(name: string): string {
  const i = name.indexOf(":");
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

/** The root element and every <loc> under <url> or <sitemap>, in document order. */
export function parseSitemap(xml: string): { kind: SitemapKind; locs: string[] } {
  let root: string | undefined;
  const locs: string[] = [];
  const stack: string[] = [];
  let text: string | undefined;
  const parser = new Parser(
    {
      onopentag(name) {
        const tag = local(name);
        root ??= tag;
        const parent = stack.at(-1);
        if (tag === "loc" && (parent === "url" || parent === "sitemap")) text = "";
        stack.push(tag);
      },
      ontext(chunk) {
        if (text !== undefined) text += chunk;
      },
      onclosetag() {
        const tag = stack.pop();
        if (tag === "loc" && text !== undefined) {
          const loc = text.trim();
          if (loc !== "") locs.push(loc);
          text = undefined;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml.replace(/^\uFEFF/, ""));
  parser.end();
  const kind: SitemapKind =
    root === "urlset" ? "urlset" : root === "sitemapindex" ? "sitemapindex" : "unknown";
  return { kind, locs: kind === "unknown" ? [] : locs };
}

/** Item links of an RSS (<item><link>) or Atom (<entry><link href>) feed, resolved, in order. */
export function parseFeedLinks(xml: string, base: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let text: string | undefined;
  const push = (href: string) => {
    try {
      out.push(new URL(href.trim(), base).href);
    } catch {
      // not an address: skip it
    }
  };
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = local(name);
        const parent = stack.at(-1);
        if (tag === "link" && parent === "item") text = "";
        if (tag === "link" && parent === "entry" && attribs.href !== undefined) {
          const rel = (attribs.rel ?? "alternate").toLowerCase();
          if (rel === "alternate") push(attribs.href);
        }
        stack.push(tag);
      },
      ontext(chunk) {
        if (text !== undefined) text += chunk;
      },
      onclosetag() {
        const tag = stack.pop();
        if (tag === "link" && text !== undefined) {
          if (text.trim() !== "") push(text);
          text = undefined;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml.replace(/^\uFEFF/, ""));
  parser.end();
  return out;
}

/** Enough of a body to see "<!doctype" or "<html" after a BOM and whitespace. */
const HTML_SNIFF_CHARS = 16;

/** True when a robots.txt body is an HTML page (a catch-all route), not a robots file. */
function looksLikeHtml(hop: Hop): boolean {
  const type = hop.headers["content-type"] ?? "";
  const start = (hop.body ?? "")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .slice(0, HTML_SNIFF_CHARS)
    .toLowerCase();
  return /html/i.test(type) || start.startsWith("<!doctype") || start.startsWith("<html");
}

/** A plain-text file at the site root (robots.txt, llms.txt): found, missing or unknown. */
async function readRootText(
  fetcher: Fetcher,
  url: string,
): Promise<{ body: string | null; state: RobotsState }> {
  const hops = await getOrNull(fetcher, url);
  const last = hops.at(-1);
  if (!last || last.status >= 500) return { body: null, state: "unknown" };
  if (last.status < 200 || last.status >= 300 || looksLikeHtml(last)) {
    return { body: null, state: "missing" };
  }
  return { body: last.body ?? "", state: "found" };
}

async function getOrNull(fetcher: Fetcher, url: string, method?: "HEAD"): Promise<Hop[]> {
  try {
    return await fetcher.get(url, method ? { method } : undefined);
  } catch (err) {
    if (err instanceof NetworkError) return [];
    throw err;
  }
}

/** HEAD first; a server that refuses HEAD (405, 501) is asked again with GET. */
export async function probe(fetcher: Fetcher, url: string): Promise<Hop[]> {
  const head = await getOrNull(fetcher, url, "HEAD");
  const status = head.at(-1)?.status;
  if (status === 405 || status === 501) return getOrNull(fetcher, url);
  return head;
}

async function readRobots(
  fetcher: Fetcher,
  robotsUrl: string,
): Promise<{ robots: RobotsFile | null; state: RobotsState }> {
  const { body, state } = await readRootText(fetcher, robotsUrl);
  return { robots: body === null ? null : parseRobots(body), state };
}

/**
 * Read sitemaps: the ones robots.txt names, or /sitemap.xml. A sitemap index is followed one
 * level. Files are read in order until there are enough entries to fill the sample, and never
 * more than LIMITS.sitemapFiles of them; an address is read once, so an index that lists
 * itself does not loop.
 */
async function readSitemaps(
  fetcher: Fetcher,
  starts: string[],
  want: number,
): Promise<{ sitemaps: SitemapRead[]; urls: string[] }> {
  const sitemaps: SitemapRead[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();
  const read = async (url: string): Promise<{ kind: SitemapKind; locs: string[] }> => {
    seen.add(url);
    const hops = await getOrNull(fetcher, url);
    const last = hops.at(-1);
    const ok = last !== undefined && last.status >= 200 && last.status < 300;
    const parsed = ok ? parseSitemap(last.body ?? "") : { kind: "unknown" as const, locs: [] };
    sitemaps.push({
      url,
      status: last?.status ?? null,
      kind: parsed.kind,
      entries: parsed.locs.length,
    });
    return parsed;
  };
  const enough = () => urls.length >= want || sitemaps.length >= LIMITS.sitemapFiles;
  for (const start of dedupeUrls(starts)) {
    if (enough()) break;
    if (seen.has(start)) continue;
    const top = await read(start);
    if (top.kind === "urlset") urls.push(...top.locs);
    if (top.kind !== "sitemapindex") continue;
    for (const child of dedupeUrls(top.locs, start)) {
      if (enough()) break;
      if (seen.has(child)) continue;
      const sub = await read(child);
      // One level only: an index inside an index is recorded and not followed.
      if (sub.kind === "urlset") urls.push(...sub.locs);
    }
  }
  return { sitemaps, urls: dedupeUrls(urls) };
}

async function readFeed(fetcher: Fetcher, url: string): Promise<FeedRead> {
  const hops = await getOrNull(fetcher, url);
  const last = hops.at(-1);
  const body = last?.body ?? "";
  const ok = last !== undefined && last.status >= 200 && last.status < 300;
  return {
    url,
    hops,
    bytes: last?.bytes ?? Buffer.byteLength(body),
    itemLinks: ok ? parseFeedLinks(body, last.url) : [],
  };
}

export interface SiteContextOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/**
 * Read robots.txt, the sitemaps and the advertised feeds through the run's fetcher. Samples come
 * from the run's budget, first ones in document order, so the same site gives the same sample.
 */
export async function buildSiteContext({
  page,
  fetcher,
  budget,
}: SiteContextOptions): Promise<SiteContext> {
  const origin = new URL(page.finalUrl).origin;
  const robotsUrl = `${origin}/robots.txt`;
  const feedsRead = Promise.all(
    budget
      .take("feeds", dedupeUrls(page.feeds.map((f) => f.href)))
      .map((u) => readFeed(fetcher, u)),
  );
  const llmsUrl = `${origin}/llms.txt`;
  const llmsRead = readRootText(fetcher, llmsUrl);
  const { robots, state } = await readRobots(fetcher, robotsUrl);
  const named = (robots?.sitemaps ?? []).flatMap((s) => dedupeUrls([s], robotsUrl));
  const starts = named.length > 0 ? named : [`${origin}/sitemap.xml`];
  const { sitemaps, urls } = await readSitemaps(fetcher, starts, budget.remaining("sitemapPages"));
  const sampled = budget.take("sitemapPages", urls);
  const sitemapSample = await Promise.all(sampled.map((u) => probe(fetcher, u)));
  return {
    robotsUrl,
    robots,
    robotsState: state,
    sitemaps,
    sitemapUrls: urls,
    sitemapSample,
    feeds: await feedsRead,
    llms: await llmsRead.then(({ body, state: llmsState }) => ({
      url: llmsUrl,
      state: llmsState,
      file: body === null ? null : parseLlmsTxt(body),
    })),
  };
}

/** Build on first use and share the result: a run that needs no site context requests nothing. */
export function lazySiteContext(opts: SiteContextOptions): () => Promise<SiteContext> {
  let pending: Promise<SiteContext> | undefined;
  return () => (pending ??= buildSiteContext(opts));
}
