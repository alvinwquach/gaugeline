import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  describeRetry,
  retryAfterSeconds,
} from "../connectors/http.js";
import { MAX_RETRY_SECONDS, isRecord } from "../connectors/get-json.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import { registerQueryAllow } from "../fetch/query-registry.js";
import { QueryRefusedError } from "../fetch/read-only-query.js";
import { FetchError, type Fetcher } from "../fetcher.js";
import { fillUrlTemplate, hasValue, hashValue, valueAt } from "./fingerprint.js";
import { createSitemapFeedAdapter } from "./sitemap-feed.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

import {
  WIX_API_KEY,
  WIX_DESCRIPTION,
  WIX_ENV_VARS,
  WIX_LIMITS,
  WIX_PAGE_SIZE,
} from "./wix.entry.js";
export { WIX_API_KEY, WIX_DESCRIPTION, WIX_ENV_VARS, WIX_LIMITS, WIX_PAGE_SIZE };

const WIX_HOST = "www.wixapis.com";
const WIX_QUERY_PATH = "/wix-data/v2/items/query";

/**
 * The one POST this adapter may send (ADR-0006): Wix Data's Query Data Items, which answers a read with a POST
 * because the filter travels in the body. The entry is written once, here, registered and frozen; the fetcher
 * sends to it by id and refuses any other address, any body key that is not a query key, any `$` operator
 * (none is on the list: Gaugeline sends no filter), and any key or text that reads as a write. The body is
 * `{ dataCollectionId, query: { cursorPaging, fields } }` and nothing else. The page was not reachable when
 * this was built (the build session's network policy refused dev.wix.com), so the entry is marked
 * `checked: null`: the endpoint, its body and its read-only nature are from memory of Wix's reference and are
 * uncited until someone reads the page and puts the date here.
 */
export const WIX_QUERY_ALLOW = registerQueryAllow({
  id: "wix-data-query",
  host: WIX_HOST,
  path: WIX_QUERY_PATH,
  body: { kind: "json-query", keys: ["dataCollectionId", "query"] },
  docs: {
    url: "https://dev.wix.com/docs/rest/business-solutions/cms/data-items/items/query-data-items",
    checked: null,
  },
});

/**
 * What the live-site read says about the CMS collections, in one place so the answer, the docs page and the
 * tests say the same thing. Without `WIX_API_KEY` the adapter reads only what the site publishes, and a sitemap
 * has no fields. It names the endpoint and carries no request verb: no adapter file holds a verb literal
 * (ADR-0006, Amendment 1), and the verb is the allowlist entry's business, not this object's.
 */
export const WIX_CMS_READ_PATH = Object.freeze({
  host: WIX_HOST,
  path: WIX_QUERY_PATH,
  reason:
    "Not applicable to what Gaugeline can read from the live Wix site: a sitemap has no fields. To read the CMS collections, set WIX_API_KEY to a Wix API key with only the Wix Data read permission, set siteId, and name the collections under urls or fingerprint in gaugeline.adapters.json (docs/integrations/wix.md).",
});

export interface WixAdapterOptions {
  fetcher: Fetcher;
  /**
   * WIX_API_KEY, already copied (see freezeEnv). With no key, or with a key and no `siteId` or no named
   * collection, the adapter reads the live site only, and `cmsNote()` says why the CMS was skipped.
   */
  env?: Env | undefined;
  /** The site's address, from the run. The settings entry's `site` wins. */
  site?: string | undefined;
  /** The settings entry: `site`, `sitemaps`, `feeds` for the live read; `siteId`, `urls` and `fingerprint` for the CMS. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces WIX_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

/** How a collection read: its item count, or why it could not be read. */
export type WixCollectionRead = { type: string; count: number } | { type: string; reason: string };

/** The Wix adapter, plus the per-collection view that keeps one refused collection from hiding the others. */
export interface WixAdapter extends ContentAdapter {
  /** The collections the settings name (under `urls` or `fingerprint`), sorted. Empty when the CMS is not read. */
  collections(): string[];
  /**
   * Why the CMS was not read although `WIX_API_KEY` is set (no `siteId`, or no collection named), in plain
   * words with no key in them. Undefined when the CMS is read, and when there is no key (nothing was skipped).
   */
  cmsNote(): string | undefined;
  /**
   * Each named collection's item count, or the reason it could not be read: a key that may not read one
   * collection is could-not-check for that collection only, and the others are still counted. A rate limit
   * that stays throws AdapterRateLimitedError with what was read.
   */
  readCollections(): Promise<WixCollectionRead[]>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** Collection ids, item ids and slugs: ASCII, one leading letter or digit. Nothing else goes into a body, an address or a message. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,4}$/;
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const KEY_SHAPE = /^[\x21-\x7e]{1,4096}$/;
/** Wix's cursors are opaque tokens; this is every character one may hold. A cursor with anything else is not sent back. */
const CURSOR = /^[A-Za-z0-9+/=_.-]{1,2048}$/;

function isoOf(value: unknown): string | undefined {
  const text = isRecord(value) ? value.$date : value;
  if (typeof text !== "string" || text === "") return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** An item as the adapter keeps it: its ids and times, and the field data only until it is hashed or counted. */
interface RawItem {
  id: string;
  slug: string | undefined;
  updatedAt: string;
  data: Record<string, unknown>;
}

function parseItem(raw: unknown): RawItem {
  const r = isRecord(raw) ? raw : {};
  const data = isRecord(r.data) ? r.data : {};
  const id = typeof r.id === "string" ? r.id : typeof data._id === "string" ? data._id : undefined;
  if (id === undefined || !SAFE_NAME.test(id))
    throw new AdapterCouldNotCheck("Wix answered with items that have no usable id.");
  const updatedAt = isoOf(data._updatedDate) ?? isoOf(data._createdDate);
  if (updatedAt === undefined)
    throw new AdapterCouldNotCheck("Wix answered with items that have no update time.");
  const slug = typeof data.slug === "string" && SAFE_NAME.test(data.slug) ? data.slug : undefined;
  return { id, slug, updatedAt, data };
}

/**
 * The Wix adapter. With no `WIX_API_KEY` it reads what a Wix site publishes, from the files the live site hands
 * every visitor (the sitemap, through the sitemap and feed adapter's reader), and the CMS collections are
 * could-not-check with the reason. With the key it reads the collections the settings name, through Wix Data's
 * Query Data Items (the one POST, ADR-0006): counts, field counts and fingerprints, never a value. The key is
 * sent in the Authorization header with the `wix-site-id` header, to www.wixapis.com only, and never to the
 * checked site: the live-site read carries no key.
 */
export function createWixAdapter(options: WixAdapterOptions): WixAdapter {
  const { fetcher } = options;
  const settings = options.settings;
  const site = settings?.site ?? options.site;
  const sleep = options.sleep ?? wait;
  const key = (options.env?.[WIX_API_KEY] ?? "").trim();
  const siteIdSet = (settings?.siteId ?? "") !== "";
  const candidates = [
    ...new Set([...Object.keys(settings?.urls ?? {}), ...Object.keys(settings?.fingerprint ?? {})]),
  ].sort();
  // The CMS is read only when the key, the site id and at least one collection are all there. A key set for
  // another reason (a script that also uses Wix) must not take away the live-site read.
  const native = key !== "" && siteIdSet && candidates.length > 0;
  const redact = createRedactor(options.env ?? {}, [WIX_API_KEY]);
  const pageSize = Math.max(1, Math.min(options.pageSize ?? WIX_PAGE_SIZE, WIX_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? WIX_LIMITS.itemsPerType;
  const named = native ? candidates : [];
  const skipped: string[] = [];
  if (!siteIdSet) skipped.push('"siteId" is not set on the wix entry in gaugeline.adapters.json');
  if (candidates.length === 0)
    skipped.push(
      'no collection is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Gaugeline does not ask Wix to list them',
    );
  const cmsNote =
    key !== "" && !native
      ? `${WIX_API_KEY} is set but the CMS collections were not read, because ${skipped.join(" and ")}. Gaugeline read what the live site publishes instead, as it does with no key (docs/integrations/wix.md).`
      : undefined;
  /** The run-wide wait for Retry-After, in milliseconds: every collection and page draws on one budget. */
  let waitedMs = 0;

  const pages = createSitemapFeedAdapter({
    fetcher,
    site,
    settings,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  /** The run must name a web address before anything is asked, in this adapter's own words. */
  const requireSite = (): void => {
    let url: URL | undefined;
    try {
      url = site === undefined || site.trim() === "" ? undefined : new URL(site.trim());
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:"))
      throw new AdapterCouldNotCheck(
        'No site address to read the Wix site\'s sitemap from. Give the site on the command line, or set "site" on the wix entry in gaugeline.adapters.json.',
      );
  };

  /** Before anything is asked of Wix: the key and the site id are usable (the collections are named, or the CMS is not read). */
  const ready = (): void => {
    if (!KEY_SHAPE.test(key))
      throw new AdapterCouldNotCheck(
        `${WIX_API_KEY} holds characters an API key does not have: it must be one line of printable characters, with no spaces.`,
      );
    const siteId = settings?.siteId;
    if (siteId === undefined || !SITE_ID.test(siteId))
      throw new AdapterCouldNotCheck(
        "The \"siteId\" on the wix entry in gaugeline.adapters.json is not a Wix site id (the site's id, a UUID, shown in the Wix dashboard's address).",
      );
    if (fetcher.query === undefined)
      throw new AdapterCouldNotCheck("This fetcher cannot send a read-only query.");
  };

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check, in fixed words. */
  const translate = (err: unknown, type: string, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        `Wix did not accept ${WIX_API_KEY} for the "${type}" collection, or the key may not read it (HTTP ${err.status}). Check it is a current API key for this site, and that its permissions include reading Wix Data items.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Wix answered HTTP 404: it has no collection "${type}" on this site. Check the collection ID (the name under "urls" or "fingerprint") and "siteId".`
          : `Wix answered HTTP ${err.status} for the "${type}" collection.`,
      );
    if (err instanceof QueryRefusedError)
      return new AdapterCouldNotCheck(
        "Gaugeline refused to send the Wix query because it is not a read-only query.",
      );
    if (err instanceof FetchError)
      return new AdapterCouldNotCheck(`Wix could not be reached (${err.reason}).`);
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /**
   * One query: the list page of one collection. The key goes in the Authorization header and the site id in
   * `wix-site-id`, never in the address or the body; `fetcher.query` sends to the allowlisted address only and
   * never follows a redirect, so neither goes anywhere else. A 429 (or a 403 that says Retry-After) with a wait
   * of a minute or less is waited out and asked again once, while the run's total wait stays within
   * WIX_LIMITS.retryWaitSeconds; a second one, or one that would pass the budget, is the rate limit.
   */
  async function queryPage(
    type: string,
    cursor: string | undefined,
    size: number,
    select: readonly string[],
  ): Promise<{ items: unknown[]; next: string | undefined; hasNext: boolean | undefined }> {
    const body = {
      dataCollectionId: type,
      query: {
        cursorPaging: { limit: size, ...(cursor === undefined ? {} : { cursor }) },
        // A cursor holds the query it began with; the projection is sent on the first page only.
        ...(cursor === undefined ? { fields: [...select] } : {}),
      },
    };
    for (let attempt = 0; ; attempt++) {
      const hop = await (fetcher.query as NonNullable<Fetcher["query"]>)(
        `https://${WIX_HOST}${WIX_QUERY_PATH}`,
        {
          allow: WIX_QUERY_ALLOW.id,
          body,
          headers: { authorization: key, "wix-site-id": settings?.siteId ?? "" },
        },
      );
      const limited =
        hop.status === 429 || (hop.status === 403 && hop.headers["retry-after"] !== undefined);
      if (limited) {
        const seconds = retryAfterSeconds(hop.headers);
        if (
          attempt === 0 &&
          seconds !== undefined &&
          seconds <= MAX_RETRY_SECONDS &&
          waitedMs + seconds * 1000 <= WIX_LIMITS.retryWaitSeconds * 1000
        ) {
          waitedMs += seconds * 1000;
          await sleep(seconds * 1000);
          continue;
        }
        throw new ConnectorRateLimitedError(describeRetry(hop.headers), seconds);
      }
      if (hop.status === 401 || hop.status === 403) throw new ConnectorRefusedError(hop.status);
      if (hop.status < 200 || hop.status >= 300) throw new ConnectorStatusError(hop.status);
      if (hop.truncated === true)
        throw new TooLarge("Wix's answer is larger than one page should be.");
      let json: unknown;
      try {
        json = JSON.parse(hop.body ?? "");
      } catch {
        throw new AdapterCouldNotCheck("Wix answered with something that is not JSON.");
      }
      if (!isRecord(json) || !Array.isArray(json.dataItems))
        throw new AdapterCouldNotCheck("Wix answered with something that is not a list of items.");
      const meta = json.pagingMetadata;
      if (!isRecord(meta)) {
        // No paging information at all: a page shorter than the limit asked for is the end, a full one could
        // be the first of many and is never reported as the whole list.
        if (json.dataItems.length >= size)
          throw new AdapterCouldNotCheck(
            `Wix answered for the "${type}" collection with a full page and no paging information, so it was not read to the end.`,
          );
        return { items: json.dataItems as unknown[], next: undefined, hasNext: undefined };
      }
      const cursors = isRecord(meta.cursors) ? meta.cursors : {};
      const next =
        typeof cursors.next === "string" && cursors.next !== "" ? cursors.next : undefined;
      return {
        items: json.dataItems as unknown[],
        next,
        hasNext: typeof meta.hasNext === "boolean" ? meta.hasNext : undefined,
      };
    }
  }

  /**
   * The items of one collection, a page at a time, until the server says there are no more: the cursor it
   * returns is followed, and the read ends only when it gives none (or says `hasNext: false`). A page that
   * says there is more and gives no cursor, a repeated cursor, an empty page that is not the end, a cursor
   * that is not a token, more items than `maxRead` and more requests than that many items could need are each
   * could-not-check, never the end of the list. An answer over the size limit is asked again with half as many
   * items, down to ten. A repeated id is the same item and is counted once.
   */
  async function* itemsOf(
    type: string,
    select: readonly string[],
    maxRead: number,
    partial: () => unknown,
  ): AsyncGenerator<RawItem> {
    if (!SAFE_NAME.test(type))
      throw new AdapterCouldNotCheck(
        `"${type}" is not a Wix collection ID (letters, digits, dots, hyphens and underscores, up to 128).`,
      );
    const maxPages = Math.ceil(maxRead / MIN_PAGE_SIZE) + 12;
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let size = pageSize;
    let asked = 0;
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `Wix needed more than ${maxPages} requests to list one collection, so it was not read to the end.`,
        );
      let page;
      try {
        page = await queryPage(type, cursor, size, select);
      } catch (err) {
        if (err instanceof TooLarge && size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw translate(err, type, partial());
      }
      for (const raw of page.items) {
        let item: RawItem;
        try {
          item = parseItem(raw);
        } catch (err) {
          throw translate(err, type, partial());
        }
        if (ids.has(item.id)) continue;
        ids.add(item.id);
        if (ids.size > maxRead)
          throw new AdapterCouldNotCheck(
            `The collection has more than ${maxRead} items, which is as many as Gaugeline reads from one collection.`,
          );
        yield item;
      }
      if (page.next === undefined || page.hasNext === false) {
        if (page.next === undefined && page.hasNext === true)
          throw new AdapterCouldNotCheck(
            `Wix said the "${type}" collection has more items and gave no way to read them, so it was not read to the end.`,
          );
        return;
      }
      if (!CURSOR.test(page.next) || cursors.has(page.next) || page.items.length === 0)
        throw new AdapterCouldNotCheck(
          `Wix's list of the "${type}" collection did not come to an end (an unusable or repeated cursor, or an empty page), so it was not read to the end.`,
        );
      cursors.add(page.next);
      cursor = page.next;
    }
  }

  const topLevel = (fields: readonly string[]): string[] => fields.map((f) => f.split(".")[0] ?? f);

  const checkedFields = (fields: readonly string[]): string[] => {
    for (const f of fields)
      if (!FIELD_PATH.test(f))
        throw new AdapterCouldNotCheck("A field name is not letters, digits and underscores.");
    return [...fields];
  };

  const selectFor = (fields: readonly string[]): string[] => [
    ...new Set(["_id", "_updatedDate", "_createdDate", "slug", ...topLevel(fields)]),
  ];

  const countOf = async (type: string, partial: () => unknown): Promise<number> => {
    let n = 0;
    for await (const item of itemsOf(type, selectFor([]), cap, partial)) {
      void item;
      n++;
    }
    return n;
  };

  const types = async (): Promise<TypeCount[]> => {
    ready();
    const out: TypeCount[] = [];
    for (const name of named) out.push({ name, count: await countOf(name, () => out.slice()) });
    return out;
  };

  const readCollections = async (): Promise<WixCollectionRead[]> => {
    ready();
    const out: WixCollectionRead[] = [];
    for (const type of named) {
      try {
        out.push({ type, count: await countOf(type, () => out.slice()) });
      } catch (err) {
        if (!(err instanceof AdapterCouldNotCheck)) throw err;
        out.push({ type, reason: err.reason });
      }
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    ready();
    const names = checkedFields(fields);
    // A type that was not named is not an empty type: nothing was read for it, so it is never a count of 0.
    if (!named.includes(type))
      throw new AdapterCouldNotCheck(
        `${SAFE_NAME.test(type) ? `"${type}"` : "That type"} is not one of the collections named in gaugeline.adapters.json (under "urls" or "fingerprint"), so it was not read.`,
      );
    const out: Record<string, number> = Object.fromEntries(names.map((f) => [f, 0]));
    for await (const item of itemsOf(type, selectFor(names), cap, () => ({})))
      for (const f of names) if (hasValue(valueAt(item.data, f))) out[f] = (out[f] ?? 0) + 1;
    return out;
  };

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    const url = template === undefined ? "" : fillUrlTemplate(template, doc);
    // One leading slash, or an https address: "//other.example/x" would name another site.
    return /^\/(?![/\\])/.test(url) || url.startsWith("https://") ? url : "";
  };

  async function* publishedNative(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    ready();
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const type of named.filter((n) => opts.types === undefined || opts.types.includes(n))) {
      if (remaining <= 0) return;
      const fields = checkedFields(opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? []);
      for await (const item of itemsOf(type, selectFor(fields), cap, () => delivered)) {
        if (since !== undefined && item.updatedAt < since) continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(item.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({
          id: item.id,
          type,
          ...(item.slug !== undefined ? { slug: item.slug } : {}),
        });
        remaining--;
        delivered++;
        yield {
          id: item.id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(item.slug !== undefined ? { slug: item.slug } : {}),
          updatedAt: item.updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  async function* publishedPages(opts?: PublishedOptions): AsyncGenerator<PublishedDoc> {
    requireSite();
    yield* pages.published(opts);
  }

  return {
    id: "wix",
    readsPages: !native,
    describe: () => WIX_DESCRIPTION,
    types: native
      ? types
      : async () => {
          requireSite();
          return pages.types();
        },
    fieldCounts: native
      ? fieldCounts
      : () => Promise.reject(new AdapterCouldNotCheck(cmsNote ?? WIX_CMS_READ_PATH.reason)),
    published: native ? publishedNative : publishedPages,
    // Draft items are never asked for (the query has no option for them), so there is nothing to look at.
    draftsReachable: () => Promise.resolve("not-applicable"),
    ...(native ? { resolveUrl } : pages.resolveUrl ? { resolveUrl: pages.resolveUrl } : {}),
    collections: () => [...named],
    cmsNote: () => cmsNote,
    readCollections: native
      ? readCollections
      : () => Promise.reject(new AdapterCouldNotCheck(cmsNote ?? WIX_CMS_READ_PATH.reason)),
  };
}
