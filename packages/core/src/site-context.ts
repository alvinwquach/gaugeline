import { Parser } from "htmlparser2";
import type { Fetcher, Hop } from "./fetcher.js";
import { LIMITS, type Budget } from "./limits.js";
import { getOrNull, probe } from "./probe.js";
import { parseLlmsTxt, type LlmsFile } from "./llms.js";
import { parseRobots, type RobotsFile } from "./robots.js";
import { isFrameworkUrl } from "./next/framework-urls.js";
import { dedupeUrls } from "./sample.js";
import { inKind } from "./request-log.js";
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
  /** The body was cut at the fetcher's size cap: the file was only partly read. */
  truncated?: boolean;
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
  /** Framework addresses (build output, payloads) the sitemaps list: counted as ignored, kept only to be named. */
  sitemapFrameworkUrls?: string[];
  /** xhtml:link hreflang alternates the sitemaps list, by page. */
  sitemapAlternates: { loc: string; hreflang: string; href: string }[];
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

/** One <url> or <sitemap> of a sitemap file: its address and the dates the file gives for it, as written. */
export interface SitemapEntry {
  loc: string;
  /** <lastmod>, as written (a date or a date and time); not checked here. */
  lastmod?: string;
  /** A Google News sitemap's <news:publication_date>, as written. */
  published?: string;
}

interface SitemapScan {
  kind: SitemapKind;
  locs: string[];
  entries: SitemapEntry[];
  alternates: { loc: string; hreflang: string; href: string }[];
}

/**
 * The one sitemap reader: the root element, every <loc> under <url> or <sitemap> in document order,
 * the dates beside each, and the hreflang alternates. htmlparser2 in XML mode decodes only the five
 * XML entities and numeric references; it never expands a DOCTYPE's own entities, so an entity bomb
 * is read as the plain text it is.
 */
function scanSitemap(xml: string): SitemapScan {
  let root: string | undefined;
  const locs: string[] = [];
  const entries: SitemapEntry[] = [];
  // xhtml:link rel="alternate" hreflang inside a <url>: the page's language versions.
  const alternates: { loc: string; hreflang: string; href: string }[] = [];
  let pending: { hreflang: string; href: string }[] = [];
  let current: SitemapEntry | undefined;
  const stack: string[] = [];
  let text: string | undefined;
  let dateOf: "lastmod" | "published" | undefined;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = local(name);
        root ??= tag;
        const parent = stack.at(-1);
        if (tag === "loc" && (parent === "url" || parent === "sitemap")) text = "";
        if (tag === "lastmod" && (parent === "url" || parent === "sitemap")) {
          text = "";
          dateOf = "lastmod";
        }
        if (tag === "publication_date") {
          text = "";
          dateOf = "published";
        }
        if (
          tag === "link" &&
          parent === "url" &&
          attribs.hreflang &&
          attribs.href &&
          (attribs.rel ?? "alternate") === "alternate"
        )
          pending.push({ hreflang: attribs.hreflang, href: attribs.href });
        if (tag === "url") pending = [];
        if (tag === "url" || tag === "sitemap") current = { loc: "" };
        stack.push(tag);
      },
      ontext(chunk) {
        if (text !== undefined) text += chunk;
      },
      onclosetag() {
        const tag = stack.pop();
        if (tag === "loc" && text !== undefined) {
          const loc = text.trim();
          if (loc !== "") {
            locs.push(loc);
            if (current) current.loc = loc;
          }
          text = undefined;
        }
        if ((tag === "lastmod" || tag === "publication_date") && text !== undefined) {
          const value = text.trim();
          const which = dateOf ?? "lastmod";
          if (current && value !== "" && current[which] === undefined) current[which] = value;
          text = undefined;
          dateOf = undefined;
        }
        if (tag === "url") {
          const loc = locs.at(-1);
          if (loc) for (const a of pending) alternates.push({ loc, ...a });
          pending = [];
        }
        if ((tag === "url" || tag === "sitemap") && current) {
          if (current.loc !== "") entries.push(current);
          current = undefined;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml.replace(/^\uFEFF/, ""));
  parser.end();
  const kind: SitemapKind =
    root === "urlset" ? "urlset" : root === "sitemapindex" ? "sitemapindex" : "unknown";
  return kind === "unknown"
    ? { kind, locs: [], entries: [], alternates: [] }
    : { kind, locs, entries, alternates };
}

/** The root element and every <loc> under <url> or <sitemap>, in document order. */
export function parseSitemap(xml: string): {
  kind: SitemapKind;
  locs: string[];
  alternates?: { loc: string; hreflang: string; href: string }[];
} {
  const { kind, locs, alternates } = scanSitemap(xml);
  if (kind === "unknown") return { kind, locs: [] };
  return alternates.length > 0 ? { kind, locs, alternates } : { kind, locs };
}

/** The same read, with each address's dates: for the sitemap and feed adapter. */
export function parseSitemapEntries(xml: string): { kind: SitemapKind; entries: SitemapEntry[] } {
  const { kind, entries } = scanSitemap(xml);
  return { kind, entries };
}

/** One <item> of an RSS feed or <entry> of an Atom feed, with what it says about when, as written. */
export interface FeedEntry {
  /** Every link the entry gives, resolved against the feed's address (RSS: <link>; Atom: rel="alternate"). */
  links: string[];
  /** RSS <guid>, or Atom <id>: used as the address only when it is one and the entry has no link. */
  guid?: string;
  /** RSS <pubDate> or <dc:date>; Atom <published>. */
  published?: string;
  /** Atom <updated>. */
  updated?: string;
  /** The first <category> (RSS text, Atom term). */
  category?: string;
}

type FeedLeaf = "link" | "guid" | "published" | "updated" | "category";

/**
 * Entries of an RSS (<item>), RSS 1.0 or Atom (<entry>) feed, in order. Only addresses, dates and a
 * category are collected: titles, descriptions and content are never read.
 */
export function parseFeed(
  xml: string,
  base: string,
): { kind: "rss" | "atom" | "unknown"; entries: FeedEntry[] } {
  const entries: FeedEntry[] = [];
  const stack: string[] = [];
  let root: string | undefined;
  let current: FeedEntry | undefined;
  let text: string | undefined;
  let into: FeedLeaf | undefined;
  const resolveHref = (href: string): string | undefined => {
    try {
      return new URL(href.trim(), base).href;
    } catch {
      return undefined; // not an address: skip it
    }
  };
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = local(name);
        root ??= tag;
        const parent = stack.at(-1);
        if (tag === "item" || tag === "entry") current = { links: [] };
        else if (current && (parent === "item" || parent === "entry")) {
          const atom = parent === "entry";
          if (tag === "link" && !atom) into = "link";
          else if (tag === "link" && attribs.href !== undefined) {
            const rel = (attribs.rel ?? "alternate").toLowerCase();
            const href = rel === "alternate" ? resolveHref(attribs.href) : undefined;
            if (href !== undefined) current.links.push(href);
          } else if (tag === "guid" || (atom && tag === "id")) into = "guid";
          else if ((tag === "pubdate" || tag === "date") && !atom) into = "published";
          else if (tag === "published" && atom) into = "published";
          else if (tag === "updated" && atom) into = "updated";
          else if (tag === "category") {
            if (atom) {
              const term = (attribs.term ?? "").trim();
              if (current.category === undefined && term !== "") current.category = term;
            } else into = "category";
          }
          if (into !== undefined) text = "";
        }
        stack.push(tag);
      },
      ontext(chunk) {
        if (text !== undefined) text += chunk;
      },
      onclosetag() {
        const tag = stack.pop();
        if (into !== undefined && text !== undefined && current) {
          const value = text.trim();
          if (value !== "") {
            if (into === "link") {
              const href = resolveHref(value);
              if (href !== undefined) current.links.push(href);
            } else current[into] ??= value;
          }
          text = undefined;
          into = undefined;
        }
        if (tag === "item" || tag === "entry") {
          if (current) entries.push(current);
          current = undefined;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml.replace(/^\uFEFF/, ""));
  parser.end();
  const kind = root === "rss" || root === "rdf" ? "rss" : root === "feed" ? "atom" : "unknown";
  return { kind, entries };
}

/** Item links of an RSS (<item><link>) or Atom (<entry><link href>) feed, resolved, in order. */
export function parseFeedLinks(xml: string, base: string): string[] {
  return parseFeed(xml, base).entries.flatMap((e) => e.links);
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
): Promise<{ body: string | null; state: RobotsState; truncated?: boolean }> {
  const hops = await getOrNull(fetcher, url);
  const last = hops.at(-1);
  if (!last || last.status >= 500) return { body: null, state: "unknown" };
  if (last.status < 200 || last.status >= 300 || looksLikeHtml(last)) {
    return { body: null, state: "missing" };
  }
  return { body: last.body ?? "", state: "found", ...(last.truncated ? { truncated: true } : {}) };
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
): Promise<{
  sitemaps: SitemapRead[];
  urls: string[];
  alternates: { loc: string; hreflang: string; href: string }[];
}> {
  const sitemaps: SitemapRead[] = [];
  const urls: string[] = [];
  const alternates: { loc: string; hreflang: string; href: string }[] = [];
  const seen = new Set<string>();
  const read = async (url: string): Promise<ReturnType<typeof parseSitemap>> => {
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
    alternates.push(...(top.alternates ?? []));
    if (top.kind !== "sitemapindex") continue;
    for (const child of dedupeUrls(top.locs, start)) {
      if (enough()) break;
      if (seen.has(child)) continue;
      const sub = await read(child);
      // One level only: an index inside an index is recorded and not followed.
      if (sub.kind === "urlset") urls.push(...sub.locs);
      alternates.push(...(sub.alternates ?? []));
    }
  }
  return { sitemaps, urls: dedupeUrls(urls), alternates };
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
      .map((u) => inKind("feed", () => readFeed(fetcher, u))),
  );
  const llmsUrl = `${origin}/llms.txt`;
  const llmsRead = readRootText(fetcher, llmsUrl);
  const { robots, state } = await readRobots(fetcher, robotsUrl);
  const named = (robots?.sitemaps ?? []).flatMap((s) => dedupeUrls([s], robotsUrl));
  const starts = named.length > 0 ? named : [`${origin}/sitemap.xml`];
  const { sitemaps, urls, alternates } = await readSitemaps(
    fetcher,
    starts,
    budget.remaining("sitemapPages"),
  );
  // A sitemap that lists framework addresses: counted as ignored, never sampled, and left out of
  // sitemapUrls so each sample lines up with the address it was taken from.
  const frameworkUrls = urls.filter(isFrameworkUrl);
  budget.take("frameworkAddresses", frameworkUrls);
  const pageUrls = urls.filter((u) => !isFrameworkUrl(u));
  const sampled = budget.take("sitemapPages", pageUrls);
  const sitemapSample = await Promise.all(
    sampled.map((u) => inKind("sitemap", () => probe(u, fetcher))),
  );
  return {
    robotsUrl,
    robots,
    robotsState: state,
    sitemaps,
    sitemapUrls: pageUrls,
    sitemapFrameworkUrls: frameworkUrls,
    sitemapAlternates: alternates,
    sitemapSample,
    feeds: await feedsRead,
    llms: await llmsRead.then(({ body, state: llmsState, truncated }) => ({
      url: llmsUrl,
      state: llmsState,
      file: body === null ? null : parseLlmsTxt(body),
      ...(truncated ? { truncated: true } : {}),
    })),
  };
}

/** Build on first use and share the result: a run that needs no site context requests nothing. */
export function lazySiteContext(opts: SiteContextOptions): () => Promise<SiteContext> {
  let pending: Promise<SiteContext> | undefined;
  return () => (pending ??= buildSiteContext(opts));
}
