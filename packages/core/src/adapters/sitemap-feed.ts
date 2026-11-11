import { load } from "cheerio/slim";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  connectorGet,
} from "../connectors/http.js";
import { MAX_RETRY_SECONDS } from "../connectors/get-json.js";
import { NetworkError } from "../errors.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import { parseRobots } from "../robots.js";
import { isSameSite } from "../sample.js";
import {
  parseFeed,
  parseSitemapEntries,
  type FeedEntry,
  type SitemapEntry,
} from "../site-context.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

import { SITEMAP_FEED_DESCRIPTION } from "./meta.js";
export { SITEMAP_FEED_DESCRIPTION };

/**
 * What one read may cost. They are promises to the site being read, like LIMITS, and a read that
 * would pass one is could-not-check rather than a quiet cut: a list with the end missing would make
 * every "not in the list" finding wrong.
 */
export const SITEMAP_FEED_LIMITS = Object.freeze({
  /** Sitemap files (an index and its children, however nested) and feeds, read in one run: 50 and 5. */
  sitemapFiles: 50,
  feeds: 5,
  /** Addresses listed by every file together. 50,000 is the sitemap protocol's own limit for one file. */
  entries: 50_000,
  /** One file, after gzip is undone. A decompression bomb stops here and the file is refused. */
  fileBytes: LIMITS.bodyBytes,
});

/** The group for an address with no folder and no feed category: /about, /menu, /. */
export const TOP_LEVEL = "top-level";

/** The usual places, asked only when robots.txt and the settings name none. They are listed on the docs page. */
export const SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"] as const;
export const FEED_PATHS = ["/feed", "/feed.xml", "/rss.xml", "/atom.xml", "/feed.json"] as const;
const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
]);
const ACCEPT =
  "application/xml, text/xml, application/rss+xml, application/atom+xml, application/feed+json, */*";

export interface SitemapFeedOptions {
  fetcher: Fetcher;
  /** The site's address, from the run. The settings entry's `site` wins. */
  site?: string | undefined;
  /** The settings entry (`site`, `sitemaps`, `feeds`). `fingerprint` and `urls` mean nothing here. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A time from a sitemap or a feed, as milliseconds, or undefined when it is not one. A date and time
 * with no zone is read as UTC, so the same file gives the same answer on every machine.
 */
function toMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  let text = value.trim();
  if (text === "") return undefined;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) text += "Z";
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A group name from a folder or a category: lower case, letters, digits and . _ - only, 64 at most. */
function groupName(text: string): string {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // keep it as written
  }
  return decoded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The type of an address: its folder, else the feed's category for it, else TOP_LEVEL. */
function typeOf(url: URL, category: string | undefined): string {
  const segments = url.pathname.split("/").filter((s) => s !== "");
  if (segments.length >= 2) {
    const folder = groupName(segments[0] ?? "");
    if (folder !== "") return folder;
  }
  const fromCategory = category === undefined ? "" : groupName(category);
  return fromCategory !== "" ? fromCategory : TOP_LEVEL;
}

/** The last path segment, decoded, when there is one. */
function slugOf(url: URL): string | undefined {
  const last = url.pathname
    .split("/")
    .filter((s) => s !== "")
    .at(-1);
  if (last === undefined) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** One address, whatever the scheme, www, trailing slash or fragment: how a sitemap and a feed meet. */
function keyOf(url: URL): string {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path}${url.search}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** JSON Feed (jsonfeed.org): items with url or id, date_published, date_modified and tags. */
function parseJsonFeed(text: string, base: string): FeedEntry[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || !Array.isArray(data.items)) return undefined;
  if (typeof data.version !== "string" || !data.version.includes("jsonfeed.org")) return undefined;
  const out: FeedEntry[] = [];
  for (const item of data.items as unknown[]) {
    if (!isRecord(item)) continue;
    const entry: FeedEntry = { links: [] };
    const address = typeof item.url === "string" ? item.url : undefined;
    try {
      if (address !== undefined && address.trim() !== "")
        entry.links.push(new URL(address.trim(), base).href);
    } catch {
      // not an address: the entry has none
    }
    if (typeof item.id === "string") entry.guid = item.id;
    if (typeof item.date_published === "string") entry.published = item.date_published;
    if (typeof item.date_modified === "string") entry.updated = item.date_modified;
    const tag = Array.isArray(item.tags) ? item.tags.find((t) => typeof t === "string") : undefined;
    if (typeof tag === "string" && tag.trim() !== "") entry.category = tag.trim();
    out.push(entry);
  }
  return out;
}

/** What is known about one address after reading the sitemaps and feeds. Times are milliseconds. */
interface Draft {
  url: string;
  parsed: URL;
  updated?: number;
  published?: number;
  category?: string;
}

interface Gathered {
  items: Map<string, Draft>;
  files: number;
  feeds: number;
  entries: number;
  /** Sitemap files and feeds that were read and understood. */
  read: number;
  /** Why a file that was only guessed at could not be used; said when nothing at all could be read. */
  problems: string[];
}

const newest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * Published items from what nearly every CMS already publishes: sitemap.xml (and an index of them),
 * RSS, Atom and JSON Feed. Read only, with no key, through the fetcher. An item is an address with the
 * dates the files give for it; titles, descriptions and content are never read. There are no fields,
 * so fieldCounts is could-not-check and fieldHashes is always empty.
 *
 * Where it looks: the settings entry's `sitemaps` and `feeds`, else robots.txt's `Sitemap:` lines (the
 * same site only), else /sitemap.xml, /sitemap_index.xml and /wp-sitemap.xml; for feeds, the ones the
 * home page advertises, else a few conventional paths. A file that robots.txt, an index or the
 * settings name must answer and be readable, or the run is could-not-check: a list with a hole in it
 * is never returned as the list. A file that was only guessed at may be missing.
 */
export function createSitemapFeedAdapter(options: SitemapFeedOptions): ContentAdapter {
  const { fetcher } = options;
  const settings = options.settings;
  const sleep = options.sleep ?? wait;
  const site = settings?.site ?? options.site;

  const origin = (): URL => {
    let url: URL | undefined;
    try {
      url = site === undefined || site.trim() === "" ? undefined : new URL(site.trim());
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:"))
      throw new AdapterCouldNotCheck(
        'No site address to read the sitemap of. Give the site on the command line, or set "site" on the sitemap-feed entry in gaugeline.adapters.json.',
      );
    return new URL(url.origin);
  };

  /** A GET that returns the 2xx answer, undefined for "not found", and throws what the contract says. */
  const get = async (url: string): Promise<Hop | undefined> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const hop = await connectorGet(fetcher, url, {
          headers: { accept: ACCEPT },
          // The fetcher remembers answers: a retry must not be handed the 429 it already got.
          ...(attempt > 0 ? { fresh: true } : {}),
        });
        if (hop.truncated === true || (hop.bytes ?? 0) > SITEMAP_FEED_LIMITS.fileBytes)
          throw new AdapterCouldNotCheck(
            `${url} is larger than ${SITEMAP_FEED_LIMITS.fileBytes / (1024 * 1024)} MB once unpacked, which is more than a sitemap or feed should be. Gaugeline refused to read it.`,
          );
        return hop;
      } catch (err) {
        if (err instanceof ConnectorRateLimitedError) {
          if (
            attempt === 0 &&
            err.retrySeconds !== undefined &&
            err.retrySeconds <= MAX_RETRY_SECONDS
          ) {
            await sleep(err.retrySeconds * 1000);
            continue;
          }
          throw err;
        }
        if (err instanceof ConnectorRefusedError)
          throw new AdapterCouldNotCheck(
            `${url} answered HTTP ${err.status}: it asks for a login or does not let Gaugeline read it.`,
          );
        if (err instanceof ConnectorStatusError) {
          if (err.status === 404 || err.status === 410) return undefined;
          throw new AdapterCouldNotCheck(`${url} answered HTTP ${err.status}.`);
        }
        if (err instanceof NetworkError) throw new AdapterCouldNotCheck(err.message);
        throw err;
      }
    }
  };

  /** Like get, for a file that was only guessed at: a problem is noted and the read goes on. */
  const tryGet = async (state: Gathered, url: string): Promise<Hop | undefined> => {
    try {
      return await get(url);
    } catch (err) {
      if (!(err instanceof AdapterCouldNotCheck)) throw err;
      state.problems.push(err.reason);
      return undefined;
    }
  };

  const addEntries = (state: Gathered, count: number, where: string): void => {
    state.entries += count;
    if (state.entries > SITEMAP_FEED_LIMITS.entries)
      throw new AdapterCouldNotCheck(
        `${where} brings the sitemaps and feeds past ${SITEMAP_FEED_LIMITS.entries.toLocaleString("en-US")} addresses, which is more than Gaugeline reads. A shorter list would make every "not in the list" answer wrong, so nothing is returned.`,
      );
  };

  const addSitemapEntry = (state: Gathered, entry: SitemapEntry, home: URL): void => {
    let parsed: URL;
    try {
      parsed = new URL(entry.loc);
    } catch {
      return;
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      !isSameSite(parsed.href, home.href)
    )
      return;
    parsed.hash = "";
    const key = keyOf(parsed);
    const existing = state.items.get(key);
    const updated = toMs(entry.lastmod);
    const published = toMs(entry.published);
    if (existing) {
      const u = newest(existing.updated, updated);
      if (u !== undefined) existing.updated = u;
      if (existing.published === undefined && published !== undefined)
        existing.published = published;
      return;
    }
    state.items.set(key, {
      url: parsed.href,
      parsed,
      ...(updated !== undefined ? { updated } : {}),
      ...(published !== undefined ? { published } : {}),
    });
  };

  /** Read sitemap files, following an index's children (the same site only, each file once). */
  const readSitemaps = async (
    state: Gathered,
    starts: readonly { url: string; listed: boolean }[],
    home: URL,
  ): Promise<void> => {
    const queue = [...starts];
    const seen = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i];
      if (next === undefined) break;
      let at: URL;
      try {
        at = new URL(next.url);
      } catch {
        continue;
      }
      at.hash = "";
      if (seen.has(at.href)) continue;
      seen.add(at.href);
      if (state.files >= SITEMAP_FEED_LIMITS.sitemapFiles)
        throw new AdapterCouldNotCheck(
          `The sitemaps name more than ${SITEMAP_FEED_LIMITS.sitemapFiles} files, which is more than Gaugeline reads. A partial list would make every "not in the list" answer wrong, so nothing is returned.`,
        );
      state.files++;
      const hop = next.listed ? await get(at.href) : await tryGet(state, at.href);
      if (hop === undefined) {
        if (next.listed)
          throw new AdapterCouldNotCheck(
            `${at.href} is named as a sitemap but answers "not found", so the list would have a hole in it.`,
          );
        continue;
      }
      const parsed = parseSitemapEntries(hop.body ?? "");
      if (parsed.kind === "unknown") {
        const why = `${at.href} is not a sitemap: it is not XML with a urlset or a sitemapindex.`;
        if (next.listed) throw new AdapterCouldNotCheck(why);
        state.problems.push(why);
        continue;
      }
      state.read++;
      addEntries(state, parsed.entries.length, at.href);
      if (parsed.kind === "sitemapindex") {
        for (const entry of parsed.entries) {
          let child: URL;
          try {
            child = new URL(entry.loc);
          } catch {
            continue;
          }
          if (isSameSite(child.href, home.href)) queue.push({ url: child.href, listed: true });
        }
        continue;
      }
      for (const entry of parsed.entries) addSitemapEntry(state, entry, home);
    }
  };

  const addFeedEntry = (state: Gathered, entry: FeedEntry, home: URL): void => {
    const address =
      entry.links[0] ??
      (entry.guid !== undefined && /^https?:\/\//i.test(entry.guid) ? entry.guid : undefined);
    if (address === undefined) return;
    let parsed: URL;
    try {
      parsed = new URL(address.trim());
    } catch {
      return;
    }
    if (!isSameSite(parsed.href, home.href)) return;
    parsed.hash = "";
    const key = keyOf(parsed);
    const published = toMs(entry.published);
    const updated = toMs(entry.updated);
    const category = entry.category?.trim() === "" ? undefined : entry.category?.trim();
    const existing = state.items.get(key);
    if (existing) {
      if (existing.published === undefined && published !== undefined)
        existing.published = published;
      // A sitemap's lastmod that is older than the feed's own date is stale: the newer one is kept.
      const u = newest(existing.updated, updated);
      if (u !== undefined) existing.updated = u;
      if (existing.category === undefined && category !== undefined) existing.category = category;
      return;
    }
    state.items.set(key, {
      url: parsed.href,
      parsed,
      ...(updated !== undefined ? { updated } : {}),
      ...(published !== undefined ? { published } : {}),
      ...(category !== undefined ? { category } : {}),
    });
  };

  /** The feeds the home page advertises (not comment feeds), same site only. */
  const advertisedFeeds = (html: string, page: string, home: URL): string[] => {
    const out: string[] = [];
    load(html)("link[rel][href]").each((_, el) => {
      const rels = (el.attribs.rel ?? "").toLowerCase().split(/\s+/);
      const type = (el.attribs.type ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
      if (!rels.includes("alternate") || !FEED_TYPES.has(type)) return;
      if (/comment/i.test(el.attribs.title ?? "")) return;
      try {
        const href = new URL((el.attribs.href ?? "").trim(), page);
        if (/comment/i.test(href.pathname) || !isSameSite(href.href, home.href)) return;
        href.hash = "";
        if (!out.includes(href.href)) out.push(href.href);
      } catch {
        // not an address
      }
    });
    return out;
  };

  const readFeeds = async (state: Gathered, home: URL): Promise<void> => {
    let targets: { url: string; listed: boolean }[];
    if (settings?.feeds !== undefined) {
      targets = settings.feeds.map((f) => ({ url: new URL(f, home).href, listed: true }));
    } else {
      const page = await tryGet(state, `${home.origin}/`);
      const advertised = page ? advertisedFeeds(page.body ?? "", page.url, home) : [];
      targets = (
        advertised.length > 0 ? advertised : FEED_PATHS.map((path) => `${home.origin}${path}`)
      ).map((url) => ({ url, listed: false }));
    }
    for (const target of targets.slice(0, SITEMAP_FEED_LIMITS.feeds)) {
      if (!isSameSite(target.url, home.href)) {
        state.problems.push(`${target.url} is not on ${home.host}, so it was not read.`);
        continue;
      }
      state.feeds++;
      const hop = target.listed ? await get(target.url) : await tryGet(state, target.url);
      if (hop === undefined) {
        if (target.listed)
          throw new AdapterCouldNotCheck(
            `${target.url} is named as a feed but answers "not found".`,
          );
        continue;
      }
      const text = (hop.body ?? "").replace(/^\uFEFF/, "");
      let entries: FeedEntry[] | undefined;
      if (text.trimStart().startsWith("{")) entries = parseJsonFeed(text, hop.url);
      else {
        const parsed = parseFeed(text, hop.url);
        entries = parsed.kind === "unknown" ? undefined : parsed.entries;
      }
      if (entries === undefined) {
        const why = `${target.url} is not a feed (RSS, Atom or JSON Feed).`;
        if (target.listed) throw new AdapterCouldNotCheck(why);
        state.problems.push(why);
        continue;
      }
      state.read++;
      addEntries(state, entries.length, target.url);
      for (const entry of entries) addFeedEntry(state, entry, home);
    }
  };

  /** Read everything into `state`. A rate limit that stays is thrown with what was read kept in `state`. */
  const gather = async (state: Gathered): Promise<void> => {
    const home = origin();
    let starts: { url: string; listed: boolean }[] = [];
    if (settings?.sitemaps !== undefined) {
      starts = settings.sitemaps.map((s) => ({ url: new URL(s, home).href, listed: true }));
      for (const s of starts)
        if (!isSameSite(s.url, home.href))
          throw new AdapterCouldNotCheck(
            `${s.url} is not on ${home.host}: only the site's own sitemaps are read.`,
          );
    } else {
      const robots = await tryGet(state, `${home.origin}/robots.txt`);
      if (robots !== undefined)
        for (const line of parseRobots(robots.body ?? "").sitemaps) {
          try {
            const url = new URL(line, home);
            // The sitemap protocol keeps a sitemap to its own site: another host is not followed.
            if (isSameSite(url.href, home.href)) starts.push({ url: url.href, listed: true });
          } catch {
            // not an address
          }
        }
    }
    if (starts.length > 0) await readSitemaps(state, starts, home);
    else
      for (const guess of SITEMAP_PATHS) {
        await readSitemaps(state, [{ url: `${home.origin}${guess}`, listed: false }], home);
        if (state.read > 0) break;
      }
    await readFeeds(state, home);
    if (state.read === 0) {
      const shown = state.problems.slice(0, 3).join(" ");
      throw new AdapterCouldNotCheck(
        `No sitemap or feed could be read from ${home.host}.${shown !== "" ? ` ${shown}` : " Gaugeline looked at robots.txt, /sitemap.xml, the feeds the home page advertises and a few usual feed paths, and found none."} A site with neither needs a native adapter, or the live-site checks alone.`,
      );
    }
  };

  const start = (): Gathered => ({
    items: new Map(),
    files: 0,
    feeds: 0,
    entries: 0,
    read: 0,
    problems: [],
  });

  const countTypes = (state: Gathered): TypeCount[] => {
    const into = new Map<string, number>();
    for (const draft of state.items.values()) {
      const name = typeOf(draft.parsed, draft.category);
      into.set(name, (into.get(name) ?? 0) + 1);
    }
    return [...into]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  const types = async (): Promise<TypeCount[]> => {
    const state = start();
    try {
      await gather(state);
    } catch (err) {
      if (err instanceof ConnectorRateLimitedError)
        throw new AdapterRateLimitedError(countTypes(state), err.retry);
      throw err;
    }
    return countTypes(state);
  };

  const fieldCounts = (): Promise<Record<string, number>> =>
    Promise.reject(
      new AdapterCouldNotCheck(
        "Not applicable: a sitemap or a feed lists addresses and dates, not fields, so there is nothing to count. Field counts need a native adapter for the content system.",
      ),
    );

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: number | undefined;
    if (opts.since !== undefined) {
      since = toMs(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    const state = start();
    let limited: ConnectorRateLimitedError | undefined;
    try {
      await gather(state);
    } catch (err) {
      if (!(err instanceof ConnectorRateLimitedError)) throw err;
      limited = err;
    }
    const wanted = opts.types === undefined ? undefined : new Set(opts.types);
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    let delivered = 0;
    for (const draft of state.items.values()) {
      if (remaining <= 0) break;
      const type = typeOf(draft.parsed, draft.category);
      if (wanted !== undefined && !wanted.has(type)) continue;
      // The newest date there is. An item with no date at all is kept: nothing says it is old.
      const when = draft.updated ?? draft.published;
      if (since !== undefined && when !== undefined && when < since) continue;
      const slug = slugOf(draft.parsed);
      remaining--;
      delivered++;
      yield {
        id: draft.url,
        type,
        url: draft.url,
        ...(slug !== undefined ? { slug } : {}),
        ...(draft.published !== undefined
          ? { publishedAt: new Date(draft.published).toISOString() }
          : {}),
        ...(draft.updated !== undefined
          ? { updatedAt: new Date(draft.updated).toISOString() }
          : {}),
        fieldHashes: {},
      };
    }
    if (limited) throw new AdapterRateLimitedError(delivered, limited.retry);
  }

  const draftsReachable = (): Promise<"not-applicable"> => Promise.resolve("not-applicable");

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) =>
    /^https?:\/\//i.test(doc.id) ? doc.id : "";

  return {
    id: "sitemap-feed",
    describe: () => SITEMAP_FEED_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
  };
}
