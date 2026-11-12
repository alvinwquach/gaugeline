import { createHash } from "node:crypto";
import { ResponseTooLargeError, MAX_RETRY_SECONDS, isRecord } from "../connectors/get-json.js";
import { describeRetry, retryAfterSeconds } from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { isAuthorHost } from "./shared/aem-author.js";
import {
  AEM_CONFIG,
  AEM_DESCRIPTION,
  AEM_LIMITS,
  AEM_PAGE_SIZE,
  AEM_PUBLISH_URL,
} from "./aem.entry.js";
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

export { AEM_DESCRIPTION, AEM_LIMITS, AEM_PAGE_SIZE };

/**
 * Adobe Experience Manager, read through the PUBLISH tier and nothing else. The site's developers publish
 * persisted GraphQL queries for their Content Fragments; a persisted query is run with a GET:
 * `/graphql/execute.json/<config>/<query>` (a `;name=value` suffix passes a variable). That GET is the only
 * request this adapter sends: no key, no POST, no author tier, and no persisted query is ever created (that
 * is a write). A "type" in the settings is the NAME of a persisted query.
 *
 * Adobe's documentation (experienceleague.adobe.com) was not reachable when this was written, so the URL
 * form, the paginated shape (`edges`, `pageInfo { hasNextPage endCursor }`, variables `first` and `after`)
 * and the list shape (`items`) are from memory and marked uncited on the docs page.
 */

/** The publish tier's address: an https origin. */
const ORIGIN_VARIABLE = AEM_PUBLISH_URL;

/** One path segment of a configuration or a query name. No dots, so no `..`; no slash, so no second segment. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A page cursor: the characters a base64 or opaque token uses, and no more than 512 of them. */
const CURSOR = /^[A-Za-z0-9+/=_.~:-]{1,512}$/;

/** One segment of a fragment's path in the DAM: no dot first (so never `..`), no `%`, no slash, no space. */
const SEGMENT = /^[A-Za-z0-9_@~+-][A-Za-z0-9_.@~+-]{0,127}$/;
const DAM = "/content/dam/";
const MAX_SEGMENTS = 12;
/** Hex characters of a path hash kept at the end of an id that had to be shortened. */
const ID_HASH_CHARS = 12;

/** The fragment's modification time, where the query returns it (`_metadata { calendarMetadata { name value } }`). Uncited. */
const MODIFIED_NAMES: readonly string[] = ["jcr:lastModified", "cq:lastModified"];

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by name; a dotted name goes into objects. */
function valueAt(data: Record<string, unknown>, path: string): unknown {
  if (path in data) return data[path];
  let at: unknown = data;
  for (const part of path.split(".")) {
    if (!isRecord(at)) return undefined;
    at = at[part];
  }
  return at;
}

/** A field counts as present when it has a value: not missing, null, an empty string, an empty list or an empty object. */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * A fragment's path, checked: `/content/dam/` and then 1 to 12 plain segments. Anything else (a second
 * leading slash, a host, `..`, `%2e`, a space, a lone surrogate) is undefined, so it never reaches an
 * address, an id or a report. Pure ASCII test: it cannot throw on any string.
 */
export function damPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith(DAM)) return undefined;
  const segments = value.slice(DAM.length).split("/");
  if (segments.length < 1 || segments.length > MAX_SEGMENTS) return undefined;
  return segments.every((s) => SEGMENT.test(s)) ? value : undefined;
}

/** An id from a DAM path: the part after /content/dam/ with "/" as ".", inside the id charset, 128 characters at most. */
function idOfPath(path: string): string {
  let id = path
    .slice(DAM.length)
    .replace(/\//g, ".")
    .replace(/[^A-Za-z0-9._-]/g, "-");
  if (!/^[A-Za-z0-9]/.test(id)) id = `x${id}`;
  if (id.length <= 128) return id;
  return `${id.slice(0, 115)}-${createHash("sha256").update(path).digest("hex").slice(0, ID_HASH_CHARS)}`;
}

/** The fragment's slug: its last path segment. */
const slugOfPath = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** An item as the adapter keeps it: its address, its time if the query gave one, and the data until it is hashed or counted. */
interface RawItem {
  id: string;
  slug: string;
  updatedAt?: string;
  data: Record<string, unknown>;
}

function modifiedOf(item: Record<string, unknown>): string | undefined {
  const meta = item._metadata;
  const list = isRecord(meta) ? meta.calendarMetadata : undefined;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list)
    if (isRecord(entry) && typeof entry.name === "string" && MODIFIED_NAMES.includes(entry.name))
      return isoOf(entry.value);
  return undefined;
}

/** An answer over the size limit. */
class TooLarge extends AdapterCouldNotCheck {}

interface Page {
  items: unknown[];
  /** Present when the query is paginated: whether there is another page, and where it starts. */
  next?: { has: boolean; cursor: string | undefined };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AemAdapterOptions {
  /** Reads AEM_PUBLISH_URL and AEM_CONFIG. Neither is a key; there is no key. */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry: its `urls` and `fingerprint` keys name the persisted queries to read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces AEM_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
  /** Replaces AEM_LIMITS.pagesPerType. For tests. */
  maxPagesPerType?: number | undefined;
}

export function createAemAdapter(options: AemAdapterOptions): ContentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? AEM_PAGE_SIZE, AEM_PAGE_SIZE));
  const itemCap = options.maxItemsPerType ?? AEM_LIMITS.itemsPerType;
  const pageCap = options.maxPagesPerType ?? AEM_LIMITS.pagesPerType;
  const settings = options.settings;
  const redact = createRedactor(env, []);

  /** The publish tier's origin, or a could-not-check that names the variable. https only; never an author host. */
  const origin = (): string => {
    const text = (env[ORIGIN_VARIABLE] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${ORIGIN_VARIABLE} is not set.`);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new AdapterCouldNotCheck(
        `${ORIGIN_VARIABLE} is not an address (expected https://www.client.example).`,
      );
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname.replace(/\/+$/, "") !== ""
    )
      throw new AdapterCouldNotCheck(
        `${ORIGIN_VARIABLE} must be an https address with a host only (no path, query, user name or password).`,
      );
    if (isAuthorHost(url.hostname))
      throw new AdapterCouldNotCheck(
        `${ORIGIN_VARIABLE} is an author-tier address. Gaugeline reads the publish tier only, which needs no login.`,
      );
    return url.origin;
  };

  const config = (): string => {
    const name = (env[AEM_CONFIG] ?? "").trim();
    if (name === "") throw new AdapterCouldNotCheck(`${AEM_CONFIG} is not set.`);
    if (!NAME.test(name))
      throw new AdapterCouldNotCheck(
        `${AEM_CONFIG} must be one name of letters, digits, hyphens and underscores (the part after /graphql/execute.json/).`,
      );
    return name;
  };

  /** The persisted queries named in the settings (under `urls` or `fingerprint`), sorted. */
  const named = (): string[] => {
    const names = new Set([
      ...Object.keys(settings?.urls ?? {}),
      ...Object.keys(settings?.fingerprint ?? {}),
    ]);
    if (names.size === 0)
      throw new AdapterCouldNotCheck(
        'No persisted query is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and the publish tier does not list its persisted queries, so nothing was read.',
      );
    for (const n of names)
      if (!NAME.test(n))
        throw new AdapterCouldNotCheck(
          "A persisted query name in gaugeline.adapters.json has characters a persisted query name cannot have (letters, digits, hyphens and underscores only).",
        );
    return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };

  const chosen = (wanted: readonly string[] | undefined): string[] => {
    const all = named();
    return wanted === undefined ? all : all.filter((n) => wanted.includes(n));
  };

  /** What a failed fetch becomes: could-not-check, with the message blanked of anything secret. */
  const translate = (err: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** One GET to the publish origin: anonymous, no redirect followed, a 429 waited out once. */
  const send = async (address: string, partial: () => unknown): Promise<Hop> => {
    for (let attempt = 0; ; attempt++) {
      let hop: Hop | undefined;
      try {
        const hops = await fetcher.get(address, {
          headers: { accept: "application/json" },
          anonymous: true,
          maxRedirects: 0,
          ...(attempt > 0 ? { fresh: true } : {}),
        });
        hop = hops.at(-1);
      } catch (err) {
        throw translate(err);
      }
      if (!hop) throw new AdapterCouldNotCheck("Adobe Experience Manager did not answer.");
      if (hop.status === 429) {
        const seconds = retryAfterSeconds(hop.headers);
        if (attempt === 0 && seconds !== undefined && seconds <= MAX_RETRY_SECONDS) {
          await sleep(seconds * 1000);
          continue;
        }
        throw new AdapterRateLimitedError(partial(), describeRetry(hop.headers));
      }
      return hop;
    }
  };

  const get = async (address: string, partial: () => unknown): Promise<Record<string, unknown>> => {
    const hop = await send(address, partial);
    if (hop.status === 401 || hop.status === 403)
      throw new AdapterCouldNotCheck(
        `The publish tier asked for a login (HTTP ${hop.status}) for this persisted query, and this adapter sends none. The query or its fragments are not public, so they were not read.`,
      );
    if (hop.status === 404)
      throw new AdapterCouldNotCheck(
        "The publish tier answered HTTP 404 for this persisted query: it is not published to the publish tier under that configuration and name.",
      );
    if (hop.status >= 300 && hop.status < 400)
      throw new AdapterCouldNotCheck(
        `The publish tier answered with a redirect (HTTP ${hop.status}) instead of the query's result, and a redirect is not followed.`,
      );
    if (hop.status < 200 || hop.status >= 300)
      throw new AdapterCouldNotCheck(`The publish tier answered HTTP ${hop.status}.`);
    if (hop.truncated === true)
      throw new TooLarge("The publish tier's answer is larger than a page should be.");
    let body: unknown;
    try {
      body = JSON.parse(hop.body ?? "");
    } catch {
      throw new AdapterCouldNotCheck("The publish tier answered with something that is not JSON.");
    }
    if (!isRecord(body))
      throw new AdapterCouldNotCheck(
        "The publish tier answered with something that is not an object.",
      );
    return body;
  };

  /** The persisted query's address, built from the validated origin, configuration and name only. */
  const address = (query: string, after: string | undefined): string => {
    const params =
      after === undefined ? "" : `;first=${pageSize};after=${encodeURIComponent(after)}`;
    return `${origin()}/graphql/execute.json/${config()}/${query}${params}`;
  };

  /** The one list in a persisted query's answer: `items` (a list) or `edges` (paginated). */
  const pageOf = (body: Record<string, unknown>): Page => {
    if (Array.isArray(body.errors) && body.errors.length > 0)
      throw new AdapterCouldNotCheck(
        `The persisted query answered with ${body.errors.length} GraphQL error${body.errors.length === 1 ? "" : "s"}, so its list was not read.`,
      );
    if (!isRecord(body.data))
      throw new AdapterCouldNotCheck("The persisted query's answer has no data.");
    const roots = Object.values(body.data).filter(
      (v): v is Record<string, unknown> =>
        isRecord(v) && (Array.isArray(v.items) || Array.isArray(v.edges)),
    );
    if (roots.length !== 1)
      throw new AdapterCouldNotCheck(
        "The persisted query must return exactly one list of fragments (an `items` list or `edges`).",
      );
    const root = roots[0] as Record<string, unknown>;
    let items: unknown[];
    if (Array.isArray(root.edges)) {
      items = root.edges.map((e) => (isRecord(e) ? e.node : undefined));
    } else {
      items = root.items as unknown[];
    }
    const info = root.pageInfo;
    if (info === undefined || info === null) return { items };
    if (!isRecord(info) || typeof info.hasNextPage !== "boolean")
      throw new AdapterCouldNotCheck("The persisted query's `pageInfo` has no `hasNextPage`.");
    const cursor = info.endCursor;
    if (info.hasNextPage && (typeof cursor !== "string" || !CURSOR.test(cursor)))
      throw new AdapterCouldNotCheck(
        "The persisted query says there is another page and gives no usable `endCursor`.",
      );
    return {
      items,
      next: { has: info.hasNextPage, cursor: typeof cursor === "string" ? cursor : undefined },
    };
  };

  const parseItem = (raw: unknown): RawItem => {
    const r = isRecord(raw) ? raw : {};
    const path = damPath(r._path);
    if (path === undefined)
      throw new AdapterCouldNotCheck(
        "A fragment in the persisted query has no usable `_path` (it must be /content/dam/ and plain path segments). Add `_path` to the query.",
      );
    const updatedAt = modifiedOf(r);
    return {
      id: idOfPath(path),
      slug: slugOfPath(path),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      data: r,
    };
  };

  /**
   * The fragments of one persisted query, a page at a time until every one is read. A paginated query is
   * followed by its `endCursor` (`;first=<n>;after=<cursor>`); the same cursor twice, an empty page that
   * promises another, a repeated fragment, more pages than the bound or more fragments than the cap are
   * could-not-check, never a short list taken for the whole. A list with no `pageInfo` that answers
   * AEM_LIMITS.unpagedList fragments or more may have been cut short by a default limit: could-not-check.
   */
  async function* itemsOfType(
    query: string,
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawItem> {
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let after: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= pageCap)
        throw new AdapterCouldNotCheck(
          `The persisted query has more than ${pageCap} pages, which is as many as Gaugeline reads for one query.`,
        );
      const page = pageOf(await get(address(query, after), partial));
      if (page.next === undefined && page.items.length >= AEM_LIMITS.unpagedList)
        throw new AdapterCouldNotCheck(
          `The persisted query returned ${page.items.length} fragments with no \`pageInfo\`, so the platform's own default limit may have cut the list short. Use the paginated form of the query (edges and pageInfo).`,
        );
      for (const raw of page.items) {
        const item = parseItem(raw);
        if (seenIds.has(item.id))
          throw new AdapterCouldNotCheck(
            "The persisted query listed the same fragment twice, so its list is not trusted.",
          );
        seenIds.add(item.id);
        if (enforceCap && seenIds.size > itemCap)
          throw new AdapterCouldNotCheck(
            `The persisted query has more than ${itemCap} fragment${itemCap === 1 ? "" : "s"}, which is as many as Gaugeline reads from one query.`,
          );
        yield item;
      }
      if (page.next === undefined || !page.next.has) return;
      const cursor = page.next.cursor as string;
      if (page.items.length === 0 || seenCursors.has(cursor) || cursor === after)
        throw new AdapterCouldNotCheck(
          "The persisted query's pages do not move on (an empty page or a cursor it already gave), so the rest was not read.",
        );
      seenCursors.add(cursor);
      after = cursor;
    }
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of named()) {
      let count = 0;
      for await (const item of itemsOfType(name, true, () => out.slice())) {
        void item;
        count++;
      }
      out.push({ name, count });
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    if (!named().includes(type))
      throw new AdapterCouldNotCheck(
        `"${type}" is not a persisted query named in gaugeline.adapters.json, so it was not read.`,
      );
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for await (const item of itemsOfType(type, true, () => ({})))
      for (const f of fields) if (hasValue(valueAt(item.data, f))) out[f] = (out[f] ?? 0) + 1;
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const type of chosen(opts.types)) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      for await (const item of itemsOfType(type, opts.limit === undefined, () => delivered)) {
        // A fragment with no time cannot be placed before `since`; the reader counts it as undated.
        if (
          since !== undefined &&
          item.updatedAt !== undefined &&
          Date.parse(item.updatedAt) < Date.parse(since)
        )
          continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(item.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({ id: item.id, type, slug: item.slug });
        remaining--;
        delivered++;
        yield {
          id: item.id,
          type,
          ...(url !== "" ? { url } : {}),
          slug: item.slug,
          ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  /** The publish tier serves only what is published, and no author tier is asked: there is no question to ask. */
  const draftsReachable = (): Promise<"not-applicable"> => Promise.resolve("not-applicable");

  return {
    id: "aem",
    describe: () => AEM_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
  };
}
