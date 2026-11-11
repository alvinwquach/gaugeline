import { ResponseTooLargeError, getJson, isRecord } from "../connectors/get-json.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
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
import {
  UMBRACO_API_KEY,
  UMBRACO_DESCRIPTION,
  UMBRACO_ENV_VARS,
  UMBRACO_LIMITS,
  UMBRACO_PAGE_SIZE,
  UMBRACO_URL,
} from "./umbraco.entry.js";
export {
  UMBRACO_API_KEY,
  UMBRACO_DESCRIPTION,
  UMBRACO_ENV_VARS,
  UMBRACO_LIMITS,
  UMBRACO_PAGE_SIZE,
  UMBRACO_URL,
};

/** The Content Delivery API's list route (Umbraco 13 and newer, version 2 of the API). [docs] */
export const UMBRACO_CONTENT_PATH = "/umbraco/delivery/api/v2/content";

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A content type's alias. It goes into a filter, so nothing outside these characters is ever sent. */
const TYPE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A property alias (the first part of a field name). */
const FIELD_ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A node id: the GUID the API gives, or any id of this shape. */
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** What a route path may be made of: unreserved and sub-delimiter characters, ":" and "@", "/" and well-formed "%" escapes. */
const ROUTE_CHARS = /^\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/;
/** A start item's path: a short run of path characters (it may be empty). */
const ROOT_PATH = /^[A-Za-z0-9._~/-]{0,200}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/**
 * A route path from an answer, or undefined when it is not a plain path on the site: one leading "/", never
 * "//" (a host), a scheme, a backslash, a query or a fragment, a "." or ".." segment, or an escaped dot, slash or
 * backslash ("%2e", "%2f", "%5c"). Linear-time (one anchored pass), and a lone surrogate is simply not a match.
 */
export function safeRoutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  if (value.startsWith("//") || !ROUTE_CHARS.test(value)) return undefined;
  if (/%2[eEfF]|%5[cC]/.test(value)) return undefined;
  for (const part of value.split("/")) if (part === "." || part === "..") return undefined;
  return value;
}

/**
 * The site's own address from UMBRACO_URL, or undefined: https only, a host, no sign-in details, no path beyond "/",
 * no query and no fragment. Anything else is not the Umbraco site's origin, and a key is never sent to it.
 */
export function umbracoOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname === "") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
  return url.origin;
}

/**
 * What an anonymous visitor (no key) is told by the Delivery API's list route:
 * - `public`: it answered with a list. `total` is how many nodes the API says it has.
 * - `protected`: it answered 401 or 403, which is what a protected API does.
 * - `closed`: it answered 404: the API is off, or this is not where it is.
 * - `unread`: the answer could not be read; `reason` says why.
 */
export type UmbracoPublicState = "public" | "protected" | "closed" | "unread";

export interface UmbracoPublicApi {
  state: UmbracoPublicState;
  /** The node count the API reported to a visitor with no key. Only when `public`. */
  total?: number;
  reason?: string;
}

/** The Umbraco adapter: ContentAdapter, plus the reads the two Umbraco checks need. */
export interface UmbracoAdapter extends ContentAdapter {
  /** The content types the settings name (under `urls` or `fingerprint`), in order. The API lists none. */
  collections(): string[];
  /** How many different start items (root nodes) the published nodes read so far were routed from. More than one means a route path cannot be tied to one site. */
  rootsSeen(): number;
  /** Aliases in the settings that are not valid content type aliases (so were not asked). */
  invalidAliases(): string[];
  /** Whether the settings say (`expectPrivate: true`) that the Delivery API is meant to be private. A key being set says nothing of it. */
  privacyExpected(): boolean;
  /**
   * What a visitor with NO key is told by the Delivery API's list route: one GET, sent with no key, no cookie and
   * nothing the fetcher adds per address. It asks a route a visitor is not meant to be sent to when the API is
   * private, so a caller runs it only with the owner's consent (CLAUDE.md rule 14).
   */
  publicApi(): Promise<UmbracoPublicApi>;
}

export interface UmbracoAdapterOptions {
  /** UMBRACO_URL and, optionally, UMBRACO_API_KEY, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry. Its `urls` and `fingerprint` keys name the content types to read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces UMBRACO_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
  /** Replaces UMBRACO_LIMITS.requestsPerList. For tests. */
  maxRequestsPerList?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by name; a dotted name goes into objects. */
function valueAt(data: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(data, path)) return data[path];
  let at: unknown = data;
  for (const part of path.split(".")) {
    if (!isRecord(at) || !Object.hasOwn(at, part)) return undefined;
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

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** A node as the adapter keeps it: ids, times and its path, and the property values only until they are hashed or counted. */
interface RawItem {
  id: string;
  type: string;
  slug?: string;
  /** The node's route path from the API, when it is a plain path. */
  path?: string;
  /** The route's start item path: the root node `path` is relative to. Absent when the API gave none. */
  root?: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

/** The first part of each field name: the property alias the API is asked for. */
function aliasesOf(fields: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of fields) {
    const first = f.split(".")[0] ?? "";
    if (FIELD_ALIAS.test(first)) out.add(first);
  }
  return [...out].sort();
}

/**
 * One node of a list. The Delivery API's item has `id`, `contentType`, `name`, `createDate`, `updateDate`,
 * `route.path` and `properties`. Only the id, the type, the update time, the route and the requested
 * properties are kept: the name and every other property are dropped here. [docs]
 */
function parseItem(raw: unknown, aliases: readonly string[]): RawItem {
  const r = isRecord(raw) ? raw : {};
  const updatedAt = isoOf(r.updateDate);
  if (typeof r.id !== "string" || !ITEM_ID.test(r.id) || updatedAt === undefined)
    throw new AdapterCouldNotCheck(
      "Umbraco answered with nodes that have no usable id or no update time.",
    );
  if (typeof r.contentType !== "string" || !TYPE_ALIAS.test(r.contentType))
    throw new AdapterCouldNotCheck("Umbraco answered with a node that has no content type.");
  const route = isRecord(r.route) ? r.route : {};
  const path = safeRoutePath(route.path);
  const last =
    path === undefined
      ? undefined
      : path
          .split("/")
          .filter((s) => s !== "")
          .at(-1);
  const start = isRecord(route.startItem) ? route.startItem.path : undefined;
  const root = typeof start === "string" && ROOT_PATH.test(start) ? start : undefined;
  const props = isRecord(r.properties) ? r.properties : {};
  const data: Record<string, unknown> = {};
  for (const a of aliases) if (Object.hasOwn(props, a)) data[a] = props[a];
  return {
    id: r.id,
    type: r.contentType,
    ...(last !== undefined && SLUG.test(last) ? { slug: last } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(root !== undefined ? { root } : {}),
    updatedAt,
    data,
  };
}

export function createUmbracoAdapter(options: UmbracoAdapterOptions): UmbracoAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? UMBRACO_PAGE_SIZE, UMBRACO_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? UMBRACO_LIMITS.itemsPerType;
  const requestBudget = options.maxRequestsPerList ?? UMBRACO_LIMITS.requestsPerList;
  const settings = options.settings;
  const redact = createRedactor(env, [UMBRACO_API_KEY]);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? `Umbraco did not accept the request (HTTP 401). If the Delivery API is protected, check that ${UMBRACO_API_KEY} is the key in the site's DeliveryApi ApiKey setting.`
          : "Umbraco did not let the key read this (HTTP 403).",
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Umbraco answered HTTP 404: the Delivery API is not at this address. It may be switched off, or ${UMBRACO_URL} is not the Umbraco site.`
          : `Umbraco answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The site's origin, or could-not-check naming the variable (never its value). */
  const originOrThrow = (): string => {
    const raw = (env[UMBRACO_URL] ?? "").trim();
    if (raw === "")
      throw new AdapterCouldNotCheck(
        `${UMBRACO_URL} is not set. Set it to the Umbraco site's address, such as https://example.com.`,
      );
    const origin = umbracoOrigin(raw);
    if (origin === undefined)
      throw new AdapterCouldNotCheck(
        `${UMBRACO_URL} must be the site's address with https and no path, such as https://example.com.`,
      );
    return origin;
  };

  const keyOrUndefined = (): string | undefined => {
    const key = (env[UMBRACO_API_KEY] ?? "").trim();
    return key === "" ? undefined : key;
  };

  /**
   * One GET of the list route, parsed as a JSON object, to the site's origin and no other. The key, when there is
   * one, goes in the Api-Key header, never in the address; `preview` adds the Preview header, which the API honours
   * only with the key. `visitor` sends neither (and nothing the fetcher adds per address).
   */
  const rawGet = async (
    query: string,
    mode: { preview?: boolean; visitor?: boolean },
  ): Promise<unknown> => {
    const origin = originOrThrow();
    const key = mode.visitor === true ? undefined : keyOrUndefined();
    if (mode.preview === true && key === undefined)
      throw new AdapterCouldNotCheck(
        `${UMBRACO_API_KEY} is not set. Umbraco shows unpublished work only to a request that carries the Delivery API key and asks for preview.`,
      );
    const { body } = await getJson(
      {
        fetcher,
        request: {
          headers: {
            accept: "application/json",
            ...(key !== undefined ? { "api-key": key } : {}),
            ...(mode.preview === true ? { preview: "true" } : {}),
          },
          ...(mode.visitor === true ? { anonymous: true } : {}),
        },
        sleep,
        system: "Umbraco",
      },
      `${origin}${UMBRACO_CONTENT_PATH}${query}`,
    );
    return body;
  };

  const get = async (
    query: string,
    mode: { preview?: boolean; visitor?: boolean },
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    try {
      const body = await rawGet(query, mode);
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Umbraco answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial());
    }
  };

  /** The query for one page of one type: the type filter, a stable order, the window, only the properties asked for, nothing expanded. */
  const listQuery = (type: string, aliases: readonly string[], skip: number, take: number) =>
    `?filter=${encodeURIComponent(`contentType:${type}`)}&sort=${encodeURIComponent("createDate:asc")}` +
    `&skip=${skip}&take=${take}&fields=${encodeURIComponent(`properties[${aliases.join(",")}]`)}&expand=none`;

  const collections = (): string[] => {
    const names = new Set<string>([
      ...Object.keys(settings?.urls ?? {}),
      ...Object.keys(settings?.fingerprint ?? {}),
    ]);
    return [...names].filter((n) => TYPE_ALIAS.test(n)).sort();
  };

  const invalidAliases = (): string[] =>
    [
      ...new Set([
        ...Object.keys(settings?.urls ?? {}),
        ...Object.keys(settings?.fingerprint ?? {}),
      ]),
    ]
      .filter((n) => !TYPE_ALIAS.test(n))
      .sort();

  const roots = new Set<string>();

  const named = (): string[] => {
    if (invalidAliases().length > 0)
      throw new AdapterCouldNotCheck(
        'A name in gaugeline.adapters.json (under "urls" or "fingerprint") is not a valid content type alias, so nothing was read.',
      );
    const all = collections();
    if (all.length === 0)
      throw new AdapterCouldNotCheck(
        'No content type is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and the Umbraco Delivery API does not list its content types, so nothing was read.',
      );
    return all;
  };

  const typeOrThrow = (type: string): string => {
    if (!TYPE_ALIAS.test(type))
      throw new AdapterCouldNotCheck("That is not a content type alias Gaugeline will ask for.");
    return type;
  };

  const totalOf = (total: unknown): number => {
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Umbraco answered with something that is not a count of nodes.",
      );
    return total;
  };

  const pageOf = async (
    type: string,
    mode: { preview?: boolean },
    skip: number,
    take: number,
    aliases: readonly string[],
    partial: () => unknown,
  ): Promise<{ items: unknown[]; total: number }> => {
    const body = await get(listQuery(typeOrThrow(type), aliases, skip, take), mode, partial);
    if (!Array.isArray(body.items))
      throw new AdapterCouldNotCheck(
        "Umbraco answered with something that is not a list of nodes.",
      );
    return { items: body.items, total: totalOf(body.total) };
  };

  /** How many nodes a type has: a one-node page and its total. */
  const countOf = async (
    type: string,
    mode: { preview?: boolean },
    partial: () => unknown,
  ): Promise<number> => (await pageOf(type, mode, 0, 1, [], partial)).total;

  /**
   * The nodes of one type, a window at a time, until every one is read. The window moves by the number of nodes
   * that came back (the API may give fewer than asked), never by the number asked for. A list is complete only
   * when the position reaches the total it reports: an empty window, a window with nothing new in it, or a
   * list that needs more requests than the budget is could-not-check, never a short list taken for the whole.
   */
  async function* nodesOfType(
    type: string,
    o: {
      preview: boolean;
      enforceCap: boolean;
      aliases: readonly string[];
      partial: () => unknown;
    },
  ): AsyncGenerator<RawItem> {
    let skip = 0;
    let size = pageSize;
    let requests = 0;
    const seen = new Set<string>();
    for (;;) {
      if (++requests > requestBudget)
        throw new AdapterCouldNotCheck(
          `Umbraco's list of this type needed more than ${requestBudget} requests, so the rest was not read.`,
        );
      let page: { items: unknown[]; total: number };
      try {
        page = await pageOf(type, { preview: o.preview }, skip, size, o.aliases, o.partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Umbraco's answer for ${size} nodes is larger than Gaugeline reads at once, even after asking for fewer nodes at a time (down to ${MIN_PAGE_SIZE}). The type was not read.`,
        );
      }
      if (o.enforceCap && page.total > cap)
        throw new AdapterCouldNotCheck(
          `The type has ${page.total} nodes, more than ${cap} node${cap === 1 ? "" : "s"}, which is as many as Gaugeline reads from one type.`,
        );
      let fresh = 0;
      for (const raw of page.items) {
        const item = parseItem(raw, o.aliases);
        if (item.type !== type)
          throw new AdapterCouldNotCheck(
            "Umbraco answered with a node of another content type than the one asked for.",
          );
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        fresh++;
        yield item;
      }
      skip += page.items.length;
      if (skip >= page.total) {
        // The position reached the total, but a window that repeated a node leaves another one out.
        if (seen.size < page.total)
          throw new AdapterCouldNotCheck(
            "Umbraco's list repeated nodes and did not give all of them, so the rest was not read.",
          );
        return;
      }
      if (page.items.length === 0)
        throw new AdapterCouldNotCheck(
          `Umbraco's list stopped after ${skip} of ${page.total} nodes, so the rest was not read.`,
        );
      if (fresh === 0)
        throw new AdapterCouldNotCheck(
          "Umbraco's list gave the same nodes again instead of the next ones, so the rest was not read.",
        );
    }
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of named())
      out.push({ name, count: await countOf(name, {}, () => out.slice()) });
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    const aliases = aliasesOf(fields);
    for await (const item of nodesOfType(typeOrThrow(type), {
      preview: false,
      enforceCap: true,
      aliases,
      partial: () => out,
    })) {
      for (const f of fields) if (hasValue(valueAt(item.data, f))) out[f] = (out[f] ?? 0) + 1;
    }
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
    const wanted = opts.types === undefined ? named() : opts.types.map(typeOrThrow);
    for (const type of wanted) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const read = nodesOfType(type, {
        preview: false,
        enforceCap: opts.limit === undefined,
        aliases: aliasesOf(fields),
        partial: () => delivered,
      });
      for await (const item of read) {
        if (since !== undefined && Date.parse(item.updatedAt) < Date.parse(since)) continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(item.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        // The settings' pattern wins; without one, the route the API gave the node.
        const given = resolveUrl({
          id: item.id,
          type,
          ...(item.slug !== undefined ? { slug: item.slug } : {}),
        });
        if (item.root !== undefined) roots.add(item.root);
        // A route is an address only with its start item: without one it cannot be tied to a root.
        const url = given !== "" ? given : item.root !== undefined ? (item.path ?? "") : "";
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

  /**
   * True when a request with the key that asks for preview is shown more nodes than the published list holds: a
   * draft, or a node never published. Two counts per type and no node is asked for beyond the first.
   */
  const draftsReachable = async (): Promise<boolean> => {
    const every = named();
    if (keyOrUndefined() === undefined)
      throw new AdapterCouldNotCheck(
        `${UMBRACO_API_KEY} is not set. Umbraco shows unpublished work only to a request that carries the Delivery API key and asks for preview.`,
      );
    for (const name of every) {
      const live = await countOf(name, {}, () => undefined);
      const preview = await countOf(name, { preview: true }, () => undefined);
      if (preview > live) return true;
    }
    // No more nodes with preview than without does not show that nothing is unpublished: the server may ignore
    // Preview, and a draft may be an edit to a published node. Not false.
    throw new AdapterCouldNotCheck(
      "Umbraco showed no more nodes with preview than without, which does not show whether unpublished work is reachable (the Preview header may be ignored, or the drafts may be edits to published nodes).",
    );
  };

  const publicApi = async (): Promise<UmbracoPublicApi> => {
    try {
      const body = await rawGet(
        `?take=1&fields=${encodeURIComponent("properties[]")}&expand=none`,
        {
          visitor: true,
        },
      );
      if (!isRecord(body) || !Array.isArray(body.items) || typeof body.total !== "number")
        return {
          state: "unread",
          reason: "the route answered, but not with the Delivery API's list of nodes",
        };
      return Number.isSafeInteger(body.total) && body.total >= 0
        ? { state: "public", total: body.total }
        : {
            state: "unread",
            reason: "the route answered with a count that is not a number of nodes",
          };
    } catch (err) {
      if (err instanceof AdapterCouldNotCheck) throw err;
      if (err instanceof ConnectorRefusedError) return { state: "protected" };
      if (err instanceof ConnectorRateLimitedError)
        throw new AdapterRateLimitedError([], err.retry);
      if (err instanceof ConnectorStatusError)
        return err.status === 404
          ? { state: "closed" }
          : { state: "unread", reason: `the route answered HTTP ${err.status}` };
      if (err instanceof ResponseTooLargeError)
        return { state: "unread", reason: "the answer was larger than a response may be" };
      return { state: "unread", reason: redact(err instanceof Error ? err.message : String(err)) };
    }
  };

  return {
    id: "umbraco",
    describe: () => UMBRACO_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    collections,
    rootsSeen: () => roots.size,
    invalidAliases,
    privacyExpected: () => settings?.expectPrivate === true,
    publicApi,
  };
}
