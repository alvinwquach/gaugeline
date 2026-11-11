import { ResponseTooLargeError, getJson, isRecord } from "../connectors/get-json.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { toMinor } from "../products/money.js";
import type { PartialRead } from "./collect.js";
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import {
  SQUARESPACE_COMMERCE_DESCRIPTION,
  SQUARESPACE_COMMERCE_LIMITS,
  SQUARESPACE_COMMERCE_TOKEN,
  SQUARESPACE_COMMERCE_TYPE,
} from "./squarespace-commerce.entry.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

export {
  SQUARESPACE_COMMERCE_DESCRIPTION,
  SQUARESPACE_COMMERCE_LIMITS,
  SQUARESPACE_COMMERCE_TOKEN,
};

/**
 * The Commerce APIs' base, from Squarespace's developer documentation (checked as the docs page says;
 * the endpoint shapes are partly from memory and marked `uncited` there).
 */
export const SQUARESPACE_COMMERCE_API = "https://api.squarespace.com/1.0/commerce";

/** Every address is built from this origin and no other: a key is never sent anywhere else. */
const API_ORIGIN = new URL(SQUARESPACE_COMMERCE_API).origin;

/** A product, variant or slug id as a plain identifier. Anything else is not used. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A cursor the API gave: opaque, short and made of URL-safe characters. Anything else ends the read. */
const CURSOR = /^[A-Za-z0-9._~=-]{1,2048}$/;

/** A path on the shop: one leading slash, no `//`, no `..`, no query, ASCII only. */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9._~%!$&'()*+,;=:@/-]{0,511}$/;

export interface SquarespaceCommerceAdapterOptions {
  /** SQUARESPACE_COMMERCE_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Replaces SQUARESPACE_COMMERCE_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
  /** Replaces SQUARESPACE_COMMERCE_LIMITS.pagesPerList. For tests. */
  maxPagesPerList?: number | undefined;
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

/** One variant as the checks need it: its price in whole minor units, never a float. */
export interface VariantFacts {
  id: string;
  /** What a buyer pays now (the sale price when the variant is on sale), in minor units. Absent when the price could not be read. */
  price?: number;
  /** Lower-case ISO 4217, such as "usd". */
  currency?: string;
}

/** A product as a fingerprint: ids, kind, state, times and prices. No name, no description, no image. */
export interface ProductFacts {
  id: string;
  slug?: string;
  /** The product page's path on the shop, when the API gave one that is safe to ask for. */
  path?: string;
  /** "physical", "service", "digital", "gift_card" or "unknown". */
  kind: string;
  /** Visible in the store. A product that is not is a draft: it has no live page. */
  published: boolean;
  publishedAt?: string;
  updatedAt: string;
  variants: VariantFacts[];
}

/** Whether a variant can be bought now, from the Inventory API. */
export type StockState = "in" | "out";

/**
 * What the commerce checks need, read once: the products and, when the key may read it, the stock of
 * each variant. `stock` is "unread" with the reason when the Inventory API was not read (no permission,
 * not offered on the plan, a rate limit): the price part still stands, the stock part is could-not-check.
 */
export interface SquarespaceCatalogue {
  products: ProductFacts[];
  stock:
    | { state: "read"; byVariant: ReadonlyMap<string, StockState> }
    | { state: "unread"; reason: string };
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface SquarespaceCommerceAdapter extends ContentAdapter {
  /** Products with prices and the stock of each variant, for the price and stock checks. Only reads. */
  catalogue(): Promise<SquarespaceCatalogue>;
}

interface RawProduct extends ProductFacts {
  /** The field data, held only until it is hashed or counted. */
  data: Record<string, unknown>;
}

/** The price a buyer pays for a variant, in minor units, or undefined when it is not a plain decimal. */
function variantPrice(pricing: unknown): { price: number; currency: string } | undefined {
  if (!isRecord(pricing)) return undefined;
  const sale = isRecord(pricing.salePrice) ? pricing.salePrice : undefined;
  const at = pricing.onSale === true && sale !== undefined ? sale : pricing.basePrice;
  if (!isRecord(at) || typeof at.currency !== "string" || typeof at.value !== "string")
    return undefined;
  if (!/^[A-Za-z]{3}$/.test(at.currency)) return undefined;
  try {
    return { price: toMinor(at.value, at.currency), currency: at.currency.toLowerCase() };
  } catch {
    return undefined;
  }
}

/** The path of a product page: the API's `url` when it is a safe path, or the path of an https address. */
function pathOf(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  let path = url;
  if (url.startsWith("https://")) {
    try {
      path = new URL(url).pathname;
    } catch {
      return undefined;
    }
  }
  if (!SAFE_PATH.test(path) || path.split("/").includes("..")) return undefined;
  return path;
}

/** An item of the Products API as a RawProduct. A product with no usable id or time makes the read could-not-check. */
function parseProduct(raw: unknown): RawProduct {
  const r = isRecord(raw) ? raw : {};
  const publishedAt = isoOf(r.createdOn);
  const updatedAt = isoOf(r.modifiedOn) ?? publishedAt;
  if (typeof r.id !== "string" || !PLAIN.test(r.id) || updatedAt === undefined)
    throw new AdapterCouldNotCheck(
      "Squarespace answered with products that have no usable id or no update time.",
    );
  const variants: VariantFacts[] = [];
  for (const v of Array.isArray(r.variants) ? r.variants : []) {
    if (!isRecord(v) || typeof v.id !== "string" || !PLAIN.test(v.id)) continue;
    const p = variantPrice(v.pricing);
    variants.push({ id: v.id, ...(p !== undefined ? p : {}) });
  }
  const path = pathOf(r.url);
  const kind =
    typeof r.type === "string" && /^[A-Z_]{1,32}$/.test(r.type) ? r.type.toLowerCase() : "unknown";
  return {
    id: r.id,
    ...(typeof r.urlSlug === "string" && PLAIN.test(r.urlSlug) ? { slug: r.urlSlug } : {}),
    ...(path !== undefined ? { path } : {}),
    kind,
    // Only a product the store shows is live: hidden products are drafts. Absence of the flag is not "published".
    published: r.isVisible === true,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    updatedAt,
    variants,
    data: r,
  };
}

export function createSquarespaceCommerceAdapter(
  options: SquarespaceCommerceAdapterOptions,
): SquarespaceCommerceAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const cap = options.maxItemsPerType ?? SQUARESPACE_COMMERCE_LIMITS.itemsPerType;
  const maxPages = options.maxPagesPerList ?? SQUARESPACE_COMMERCE_LIMITS.pagesPerList;
  const settings = options.settings;
  const redact = createRedactor(env, [SQUARESPACE_COMMERCE_TOKEN]);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown, what: string): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError)
      return new AdapterCouldNotCheck(
        `Squarespace's answer for ${what} is larger than Gaugeline reads at once. It was not read.`,
      );
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? "Squarespace did not accept SQUARESPACE_COMMERCE_TOKEN (HTTP 401). Check that it is a current API key."
          : `Squarespace did not let the key read ${what} (HTTP ${err.status}). The key needs the ${what} permission set to read, and the site's plan must offer the Commerce APIs.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(`Squarespace answered HTTP ${err.status} for ${what}.`);
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const keyOrThrow = (): string => {
    const key = (env[SQUARESPACE_COMMERCE_TOKEN] ?? "").trim();
    if (key === "")
      throw new AdapterCouldNotCheck(
        `${SQUARESPACE_COMMERCE_TOKEN} is not set. Squarespace's Commerce APIs need an API key.`,
      );
    return key;
  };

  /** One GET, parsed as a JSON object, to this API's origin and no other. The key goes in a header, never in the address. */
  const get = async (
    address: string,
    what: string,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    if (new URL(address).origin !== API_ORIGIN)
      throw new AdapterCouldNotCheck("Squarespace pointed at another address, which is not asked.");
    const key = keyOrThrow();
    try {
      const { body } = await getJson(
        {
          fetcher,
          request: { authorization: `Bearer ${key}`, headers: { accept: "application/json" } },
          sleep,
          system: "Squarespace",
        },
        address,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck(
          "Squarespace answered with something that is not an object.",
        );
      return body;
    } catch (err) {
      throw translate(err, partial(), what);
    }
  };

  /**
   * The items of one list, a page at a time, stepping by the cursor each page returns and stopping at
   * the page that says it is the last. Both ends are bounded: items per list and pages per list, so a
   * server that never says "last" ends the read as could-not-check. A cursor is checked, never
   * followed as an address, and one seen twice ends the read. Every address is built here.
   */
  async function* listOf(
    path: "products" | "inventory",
    listKey: "products" | "inventory",
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<unknown> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    let items = 0;
    for (let page = 1; ; page++) {
      const address = `${SQUARESPACE_COMMERCE_API}/${path}${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`;
      const body = await get(address, path, partial);
      const list = body[listKey];
      const paging = body.pagination;
      if (!Array.isArray(list) || !isRecord(paging) || typeof paging.hasNextPage !== "boolean")
        throw new AdapterCouldNotCheck(
          `Squarespace answered ${path} with something that is not a page of ${listKey}.`,
        );
      items += list.length;
      if (enforceCap && items > cap)
        throw new AdapterCouldNotCheck(
          `The store has more than ${cap} ${listKey}, which is as many as Gaugeline reads.`,
        );
      for (const item of list) yield item;
      if (!paging.hasNextPage) return;
      const next = paging.nextPageCursor;
      if (typeof next !== "string" || !CURSOR.test(next) || seen.has(next) || list.length === 0)
        throw new AdapterCouldNotCheck(
          `Squarespace's list of ${listKey} stopped making sense after ${items} (a missing, repeated or unusable cursor), so the rest was not read.`,
        );
      if (page >= maxPages)
        throw new AdapterCouldNotCheck(
          `Squarespace's list of ${listKey} is longer than ${maxPages} pages, which is as many as Gaugeline reads.`,
        );
      seen.add(next);
      cursor = next;
    }
  }

  async function* productsOf(
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawProduct> {
    for await (const raw of listOf("products", "products", enforceCap, partial))
      yield parseProduct(raw);
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    const url = template === undefined ? "" : fillUrlTemplate(template, doc);
    // A template may not turn into "//host": that is another site, not a path on this one.
    return url.startsWith("//") ? "" : url;
  };

  const onlyType = (type: string): void => {
    if (type !== SQUARESPACE_COMMERCE_TYPE)
      throw new AdapterCouldNotCheck(
        `Squarespace commerce has no type "${type}". Its only type is "${SQUARESPACE_COMMERCE_TYPE}" (the Commerce Products API). Pages and blog posts have no read API.`,
      );
  };

  const types = async (): Promise<TypeCount[]> => {
    let count = 0;
    for await (const p of productsOf(true, () => [])) if (p.published) count++;
    return [{ name: SQUARESPACE_COMMERCE_TYPE, count }];
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    onlyType(type);
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for await (const p of productsOf(true, () => ({})))
      if (p.published)
        for (const f of fields) if (hasValue(valueAt(p.data, f))) out[f] = (out[f] ?? 0) + 1;
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    if (opts.types !== undefined && !opts.types.includes(SQUARESPACE_COMMERCE_TYPE)) return;
    const type = SQUARESPACE_COMMERCE_TYPE;
    const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    if (remaining <= 0) return;
    for await (const p of productsOf(opts.limit === undefined, () => delivered)) {
      if (!p.published) continue;
      if (since !== undefined && Date.parse(p.updatedAt) < Date.parse(since)) continue;
      const fieldHashes: Record<string, string> = {};
      for (const f of fields) {
        const h = hashValue(valueAt(p.data, f));
        if (h !== undefined) fieldHashes[f] = h;
      }
      const url =
        p.path ?? resolveUrl({ id: p.id, type, ...(p.slug !== undefined ? { slug: p.slug } : {}) });
      remaining--;
      delivered++;
      yield {
        id: p.id,
        type,
        ...(url !== "" ? { url } : {}),
        ...(p.slug !== undefined ? { slug: p.slug } : {}),
        ...(p.publishedAt !== undefined ? { publishedAt: p.publishedAt } : {}),
        updatedAt: p.updatedAt,
        fieldHashes,
      };
      if (remaining <= 0) return;
    }
  }

  /** True when the store holds a product that is not visible: a draft the key can read and visitors cannot. */
  const draftsReachable = async (): Promise<boolean> => {
    for await (const p of productsOf(true, () => undefined)) if (!p.published) return true;
    return false;
  };

  const catalogue = async (): Promise<SquarespaceCatalogue> => {
    const products: ProductFacts[] = [];
    const rateLimited = (err: AdapterRateLimitedError, delivered: number): PartialRead => ({
      reason: "rate-limited",
      ...(err.retry !== undefined ? { retry: err.retry } : {}),
      delivered,
    });
    try {
      for await (const { data: _data, ...facts } of productsOf(true, () => products.length))
        products.push(facts);
    } catch (err) {
      if (!(err instanceof AdapterRateLimitedError)) throw err;
      return {
        products,
        stock: { state: "unread", reason: "the Products read was cut short by a rate limit" },
        partial: rateLimited(err, products.length),
      };
    }
    const byVariant = new Map<string, StockState>();
    try {
      for await (const row of listOf("inventory", "inventory", true, () => byVariant.size)) {
        if (!isRecord(row) || typeof row.variantId !== "string" || !PLAIN.test(row.variantId))
          continue;
        const quantity = row.quantity;
        const unlimited = row.isUnlimited === true;
        // A row with no usable quantity says nothing: it is left out, and that variant's stock stays unknown.
        if (
          !unlimited &&
          !(typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity >= 0)
        )
          continue;
        byVariant.set(row.variantId, unlimited || (quantity as number) > 0 ? "in" : "out");
      }
    } catch (err) {
      if (err instanceof AdapterRateLimitedError)
        return {
          products,
          stock: { state: "unread", reason: "the Inventory read was cut short by a rate limit" },
          partial: rateLimited(err, products.length),
        };
      if (err instanceof AdapterCouldNotCheck)
        return { products, stock: { state: "unread", reason: err.reason } };
      throw err;
    }
    return { products, stock: { state: "read", byVariant } };
  };

  return {
    id: "squarespace-commerce",
    describe: () => SQUARESPACE_COMMERCE_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    catalogue,
  };
}
