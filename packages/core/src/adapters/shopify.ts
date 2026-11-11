import { MAX_RETRY_SECONDS, ResponseTooLargeError, isRecord } from "../connectors/get-json.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  describeRetry,
  retryAfterSeconds,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import {
  DEFAULT_SHOPIFY_API_VERSION,
  SHOPIFY_API_VERSION,
  SHOPIFY_SHOP_DOMAIN,
} from "../connectors/shopify.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { registerQueryAllow } from "../fetch/query-registry.js";
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import { SHOPIFY_DESCRIPTION, SHOPIFY_STOREFRONT_TOKEN } from "./shopify.entry.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

export { SHOPIFY_DESCRIPTION, SHOPIFY_STOREFRONT_TOKEN };
export { SHOPIFY_API_VERSION, SHOPIFY_SHOP_DOMAIN };

/**
 * The one POST this adapter sends (ADR-0006): a Storefront API GraphQL QUERY to the shop's own
 * address. The Storefront API answers POST only. The host is the shop the person set (validated by
 * `shopHost`), the path is the documented endpoint with the API version as its one free segment, and
 * the body must parse as a single `query` (a mutation or a subscription is refused by the fetcher).
 * `checked: null`: the shopify.dev page could not be reached when this was written, so the endpoint
 * is from memory and marked uncited.
 */
export const SHOPIFY_STOREFRONT_QUERY = registerQueryAllow({
  id: "shopify-storefront-query",
  method: "POST",
  host: { configured: SHOPIFY_SHOP_DOMAIN },
  path: "/api/*/graphql.json",
  body: { kind: "graphql-query" },
  docs: { url: "https://shopify.dev/docs/api/storefront", checked: null },
});

/** Items asked for in one request: the Storefront API's own maximum (250) is not used, 50 keeps an answer small. */
export const SHOPIFY_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const MIN_PAGE_SIZE = 10;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const SHOPIFY_LIMITS = {
  /** Items read from one type. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** The longest cursor taken from an answer. */
  cursorChars: 512,
} as const;

/** The header the Storefront API reads its token from. */
const TOKEN_HEADER = "x-shopify-storefront-access-token";

/** A shop address: the spec's rule. Nothing else is ever a host the token is sent to. */
const SHOP = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const VERSION = /^\d{4}-(?:01|04|07|10)$/;
const GID = /^gid:\/\/shopify\/(Product|Collection|Page|Blog|Article)\/(\d{1,20})$/;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~%-]{0,200}$/;

/** The shop's myshopify.com host from what a person set (the bare handle works too), or undefined. */
export function shopHost(input: string): string | undefined {
  const t = input.trim().toLowerCase();
  const host = /^[a-z0-9][a-z0-9-]{0,60}$/.test(t) ? `${t}.myshopify.com` : t;
  return SHOP.test(host) ? host : undefined;
}

/** A path from an address the platform gave: one leading "/", no "//", no "..", plain segments. Else undefined. */
export function safePath(address: unknown): string | undefined {
  if (typeof address !== "string" || address.length > 2000) return undefined;
  // Judged on the text as sent: a URL parser would quietly resolve a dot segment away.
  if (!/^https:\/\/[^/?#]+(?:[/?#]|$)/.test(address)) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/\.\.|%2e|%2f|%5c|\\|[\u0000-\u001f\u007f]/i.test(address)) return undefined;
  const afterHost = address.replace(/^https:\/\/[^/?#]+/, "");
  if (afterHost.startsWith("//")) return undefined;
  let path: string;
  try {
    const u = new URL(address, "https://shop.invalid");
    if (u.protocol !== "https:") return undefined;
    path = u.pathname;
  } catch {
    return undefined;
  }
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  const segments = path.slice(1).split("/");
  if (segments.length === 1 && segments[0] === "") return "/";
  for (const s of segments) if (s === ".." || s === "." || !SEGMENT.test(s)) return undefined;
  return path;
}

/** What each type reads: the connection's root field and the fields that may be fingerprinted (the only ones ever asked for). */
interface TypeSpec {
  root: string;
  /** Times the platform gives. A blog has none. */
  times: readonly ("updatedAt" | "publishedAt")[];
  /** Field paths a settings entry may name; a dotted one goes into an object. A name not here is never asked for. */
  fields: readonly string[];
}

const SEO = ["seo.title", "seo.description"] as const;
export const SHOPIFY_TYPES: Readonly<Record<string, TypeSpec>> = Object.freeze({
  articles: {
    root: "articles",
    times: ["publishedAt"],
    fields: ["title", "content", "excerpt", "tags", "image.url", ...SEO],
  },
  blogs: { root: "blogs", times: [], fields: ["title", ...SEO] },
  collections: {
    root: "collections",
    times: ["updatedAt"],
    fields: ["title", "description", "image.url", ...SEO],
  },
  pages: { root: "pages", times: ["updatedAt"], fields: ["title", "body", "bodySummary", ...SEO] },
  products: {
    root: "products",
    times: ["updatedAt", "publishedAt"],
    fields: [
      "title",
      "description",
      "vendor",
      "productType",
      "tags",
      "availableForSale",
      "featuredImage.url",
      "priceRange.minVariantPrice.amount",
      "priceRange.minVariantPrice.currencyCode",
      ...SEO,
    ],
  },
});

/** The selection set for field paths: ["seo.title", "seo.description"] is `seo { title description }`. */
function selection(paths: readonly string[]): string {
  const tree: Record<string, unknown> = {};
  for (const p of paths) {
    let at = tree;
    const parts = p.split(".");
    parts.forEach((part, i) => {
      if (i === parts.length - 1) at[part] = true;
      else {
        const next = at[part];
        at = isRecord(next) ? next : (at[part] = {});
      }
    });
  }
  const render = (node: Record<string, unknown>): string =>
    Object.entries(node)
      .map(([k, v]) => (isRecord(v) ? `${k} { ${render(v)} }` : k))
      .join(" ");
  return render(tree);
}

/** The query document for one type and the fields asked for. Built only from names in SHOPIFY_TYPES. */
export function readQuery(type: string, fields: readonly string[]): string {
  const spec = SHOPIFY_TYPES[type];
  if (spec === undefined) throw new Error("No such Shopify type.");
  const inner = ["id", "handle", "onlineStoreUrl", ...spec.times, selection(fields)]
    .filter((s) => s !== "")
    .join(" ");
  return `query Read($first: Int!, $after: String) { ${spec.root}(first: $first, after: $after) { nodes { ${inner} } pageInfo { hasNextPage endCursor } } }`;
}

export interface ShopifyAdapterOptions {
  /** SHOPIFY_STOREFRONT_TOKEN and SHOPIFY_SHOP_DOMAIN (and SHOPIFY_API_VERSION when set), already copied. */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces SHOPIFY_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by dotted name. */
function valueAt(data: Record<string, unknown>, path: string): unknown {
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

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** The platform said "THROTTLED" inside a 200 answer. */
class Throttled extends Error {}

/** An item as the adapter keeps it: ids, state and times, and the field data only until it is hashed or counted. */
interface RawItem {
  id: string;
  slug: string;
  /** Published to the Online Store: the platform gave it an address there. */
  published: boolean;
  /** Its path on the live site, from the platform. */
  path?: string;
  publishedAt?: string;
  updatedAt?: string;
  data: Record<string, unknown>;
}

/** The kind of id each type's items have: a product id in the pages list is not an id of this type. */
const KIND: Readonly<Record<string, string>> = {
  articles: "Article",
  blogs: "Blog",
  collections: "Collection",
  pages: "Page",
  products: "Product",
};

function parseItem(raw: unknown, type: string): RawItem {
  const r = isRecord(raw) ? raw : {};
  const gid = typeof r.id === "string" ? GID.exec(r.id) : null;
  if (gid === null || gid[2] === undefined || gid[1] !== KIND[type])
    throw new AdapterCouldNotCheck("Shopify answered with an item whose id is not a Shopify id.");
  if (typeof r.handle !== "string" || !HANDLE.test(r.handle))
    throw new AdapterCouldNotCheck(
      "Shopify answered with an item whose handle is not a plain handle.",
    );
  let path: string | undefined;
  if (r.onlineStoreUrl !== null && r.onlineStoreUrl !== undefined) {
    path = safePath(r.onlineStoreUrl);
    if (path === undefined)
      throw new AdapterCouldNotCheck("Shopify answered with an address that is not a page path.");
  }
  const spec = SHOPIFY_TYPES[type];
  const publishedAt = isoOf(r.publishedAt);
  const updatedAt = isoOf(r.updatedAt);
  if (spec?.times.includes("updatedAt") && updatedAt === undefined)
    throw new AdapterCouldNotCheck("Shopify answered with an item that has no update time.");
  return {
    id: gid[2],
    slug: r.handle,
    published: path !== undefined,
    ...(path !== undefined ? { path } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    data: r,
  };
}

export function createShopifyAdapter(options: ShopifyAdapterOptions): ContentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? SHOPIFY_PAGE_SIZE, MAX_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? SHOPIFY_LIMITS.itemsPerType;
  const settings = options.settings;
  const redact = createRedactor(env, [SHOPIFY_STOREFRONT_TOKEN]);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError || err instanceof Throttled)
      return new AdapterRateLimitedError(
        partial,
        err instanceof ConnectorRateLimitedError ? err.retry : undefined,
      );
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? `Shopify did not accept ${SHOPIFY_STOREFRONT_TOKEN} (HTTP 401). Check that it is a current Storefront API access token for this shop.`
          : `Shopify did not let the token read this (HTTP ${err.status}). Check the token's Storefront API permissions.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Shopify answered HTTP 404: there is no Storefront API at this shop and version. Check ${SHOPIFY_SHOP_DOMAIN} and ${SHOPIFY_API_VERSION}.`
          : `Shopify answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The address, host and token, checked before anything is asked. */
  const target = (): { url: string; host: string; token: string } => {
    const token = (env[SHOPIFY_STOREFRONT_TOKEN] ?? "").trim();
    if (token === "")
      throw new AdapterCouldNotCheck(
        `${SHOPIFY_STOREFRONT_TOKEN} is not set. Shopify's content needs a Storefront API access token.`,
      );
    if (!/^[\x21-\x7e]{1,256}$/.test(token))
      throw new AdapterCouldNotCheck(`${SHOPIFY_STOREFRONT_TOKEN} is not a plain token.`);
    const rawShop = (env[SHOPIFY_SHOP_DOMAIN] ?? "").trim();
    if (rawShop === "")
      throw new AdapterCouldNotCheck(
        `${SHOPIFY_SHOP_DOMAIN} is not set. Set it to the shop's myshopify.com address.`,
      );
    const host = shopHost(rawShop);
    if (host === undefined)
      throw new AdapterCouldNotCheck(
        `${SHOPIFY_SHOP_DOMAIN} is not a myshopify.com address, so nothing was asked and the token was not sent.`,
      );
    const version = (env[SHOPIFY_API_VERSION] ?? "").trim() || DEFAULT_SHOPIFY_API_VERSION;
    if (!VERSION.test(version))
      throw new AdapterCouldNotCheck(
        `${SHOPIFY_API_VERSION} must be a quarterly release such as ${DEFAULT_SHOPIFY_API_VERSION}.`,
      );
    return { url: `https://${host}/api/${version}/graphql.json`, host, token };
  };

  /** One query through the allowlist, parsed. A short Retry-After or THROTTLED is waited out once. */
  const ask = async (
    document: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const t = target();
    if (fetcher.query === undefined)
      throw new AdapterCouldNotCheck(
        "This fetcher cannot send a read-only query, which Shopify's Storefront API needs.",
      );
    for (let attempt = 0; ; attempt++) {
      try {
        const hop = await fetcher.query(t.url, {
          allow: SHOPIFY_STOREFRONT_QUERY.id,
          host: t.host,
          body: { query: document, variables },
          headers: { [TOKEN_HEADER]: t.token },
        });
        if (hop.status === 401 || hop.status === 403) throw new ConnectorRefusedError(hop.status);
        if (hop.status === 429)
          throw new ConnectorRateLimitedError(
            describeRetry(hop.headers),
            retryAfterSeconds(hop.headers),
          );
        if (hop.status < 200 || hop.status >= 300) throw new ConnectorStatusError(hop.status);
        if (hop.truncated) throw new ResponseTooLargeError("Shopify");
        let body: unknown;
        try {
          body = JSON.parse(hop.body ?? "");
        } catch {
          throw new AdapterCouldNotCheck("Shopify answered with something that is not JSON.");
        }
        if (!isRecord(body))
          throw new AdapterCouldNotCheck("Shopify answered with something that is not an object.");
        return dataOf(body);
      } catch (err) {
        const seconds =
          err instanceof ConnectorRateLimitedError
            ? err.retrySeconds
            : err instanceof Throttled
              ? 1
              : undefined;
        if (attempt === 0 && seconds !== undefined && seconds <= MAX_RETRY_SECONDS) {
          await sleep(seconds * 1000);
          continue;
        }
        throw err;
      }
    }
  };

  /** The `data` of a GraphQL answer. An answer with errors is never an empty list, and its messages (which may quote content) are not repeated. */
  const dataOf = (body: Record<string, unknown>): Record<string, unknown> => {
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const codes = body.errors.map((e: unknown) =>
        isRecord(e) && isRecord(e.extensions) ? e.extensions.code : undefined,
      );
      if (codes.includes("THROTTLED")) throw new Throttled();
      if (codes.includes("ACCESS_DENIED"))
        throw new AdapterCouldNotCheck(
          "Shopify says the token may not read this: it lacks a Storefront API permission (unauthenticated_read_product_listings for products and collections, unauthenticated_read_content for pages, blogs and articles).",
        );
      throw new AdapterCouldNotCheck(
        `Shopify answered with ${body.errors.length} error${body.errors.length === 1 ? "" : "s"}.`,
      );
    }
    if (!isRecord(body.data))
      throw new AdapterCouldNotCheck("Shopify answered with something that has no data.");
    return body.data;
  };

  /**
   * The items of one type, a cursor page at a time. The next page is asked for with the cursor the
   * platform returned. A page that returns more than was asked, a missing or repeated cursor, an empty
   * page that says there is more, and a type past the bound are could-not-check: a page is never
   * clamped and called complete. `size` is halved when an answer is too big, down to ten.
   */
  async function* itemsOfType(
    type: string,
    fields: readonly string[],
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawItem> {
    const spec = SHOPIFY_TYPES[type];
    if (spec === undefined) return;
    const asked = fields.filter((f) => spec.fields.includes(f));
    const document = readQuery(type, asked);
    const seen = new Set<string>();
    let after: string | null = null;
    let size = pageSize;
    let read = 0;
    for (;;) {
      let data: Record<string, unknown>;
      try {
        data = await ask(document, { first: size, after });
      } catch (err) {
        if (!(err instanceof TooLarge)) throw translate(err, partial());
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Shopify's answer for ${size} ${type} is larger than Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). They were not read.`,
        );
      }
      const connection = data[spec.root];
      const nodes = isRecord(connection) ? connection.nodes : undefined;
      const info = isRecord(connection) ? connection.pageInfo : undefined;
      if (!Array.isArray(nodes) || !isRecord(info) || typeof info.hasNextPage !== "boolean")
        throw new AdapterCouldNotCheck(
          `Shopify answered with something that is not a list of ${type}.`,
        );
      if (nodes.length > size)
        throw new AdapterCouldNotCheck(
          `Shopify sent more ${type} in a page than were asked for, so they were not read.`,
        );
      read += nodes.length;
      if (read > cap && enforceCap)
        throw new AdapterCouldNotCheck(
          `Shopify has more than ${cap} ${type}, which is as many as Gaugeline reads from one type.`,
        );
      for (const raw of nodes) yield parseItem(raw, type);
      if (!info.hasNextPage) return;
      const cursor = info.endCursor;
      if (typeof cursor !== "string" || cursor === "" || cursor.length > SHOPIFY_LIMITS.cursorChars)
        throw new AdapterCouldNotCheck(
          `Shopify's list of ${type} says there is more but gave no usable cursor, so the rest was not read.`,
        );
      if (seen.has(cursor) || nodes.length === 0)
        throw new AdapterCouldNotCheck(
          `Shopify's list of ${type} stopped moving after ${read} items, so the rest was not read.`,
        );
      seen.add(cursor);
      after = cursor;
      if (read > cap) return;
    }
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const chosen = (names: readonly string[] | undefined): string[] =>
    Object.keys(SHOPIFY_TYPES).filter((n) => names === undefined || names.includes(n));

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of chosen(undefined)) {
      let count = 0;
      for await (const item of itemsOfType(name, [], true, () => out.slice()))
        if (item.published) count++;
      out.push({ name, count });
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for (const name of chosen([type]))
      for await (const item of itemsOfType(name, fields, true, () => ({ ...out }))) {
        if (!item.published) continue;
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
    for (const type of chosen(opts.types)) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const read = itemsOfType(type, fields, opts.limit === undefined, () => delivered);
      for await (const item of read) {
        // Not published to the Online Store: hidden on purpose, never reported as missing.
        if (!item.published) continue;
        if (
          since !== undefined &&
          item.updatedAt !== undefined &&
          Date.parse(item.updatedAt) < Date.parse(since)
        )
          continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const v = valueAt(item.data, f);
          const h = hasValue(v) ? hashValue(v) : undefined;
          if (h !== undefined) fieldHashes[f] = h;
        }
        const templated = resolveUrl({ id: item.id, type, slug: item.slug });
        const url = templated !== "" ? templated : item.path;
        remaining--;
        delivered++;
        yield {
          id: item.id,
          type,
          ...(url !== undefined ? { url } : {}),
          slug: item.slug,
          ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
          ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  /**
   * A Storefront API token sees only what is published, by design: it cannot reach a draft, so the
   * answer is no. One cheap read first, so a token the shop refuses is could-not-check, never a "no".
   */
  const draftsReachable = async (): Promise<boolean> => {
    try {
      await ask(readQuery("products", []), { first: 1, after: null });
    } catch (err) {
      throw translate(err, undefined);
    }
    return false;
  };

  return {
    id: "shopify",
    describe: () => SHOPIFY_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
  };
}
