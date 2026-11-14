import { toMinor } from "../products/money.js";
import type { CatalogueItem, CatalogueVariant } from "./catalogue.js";
import { isConfigured } from "./env.js";
import { getJson, idText, isRecord, skuText, type JsonSource } from "./get-json.js";
import { ConnectorRateLimitedError, ConnectorRefusedError, ConnectorStatusError } from "./http.js";
import { createRedactor } from "./redact.js";
import type { Connector } from "./types.js";

/** A Shopify product as a catalogue item, with the address its page has on the storefront. */
export interface ShopifyProduct extends CatalogueItem {
  source: "shopify";
  /** The product's address on the storefront (/products/<handle>), or "" when Shopify sent none. */
  handle: string;
}

export const SHOPIFY_ACCESS_TOKEN = "SHOPIFY_ACCESS_TOKEN";
export const SHOPIFY_SHOP_DOMAIN = "SHOPIFY_SHOP_DOMAIN";
export const SHOPIFY_API_VERSION = "SHOPIFY_API_VERSION";
/** Every variable the Shopify connector requires: what the CLI hands to core for it. */
export const SHOPIFY_ENV_VARS = [SHOPIFY_ACCESS_TOKEN, SHOPIFY_SHOP_DOMAIN] as const;
/** Read when set, never required. */
export const SHOPIFY_OPTIONAL_ENV_VARS = [SHOPIFY_API_VERSION] as const;

/**
 * Proposed: the Admin API version asked for when SHOPIFY_API_VERSION is not set. Shopify ships a
 * version every quarter and supports each for about a year; one that is no longer supported is
 * answered by the oldest that is. The setting exists so a store can move without a Gaugeline release.
 */
export const DEFAULT_SHOPIFY_API_VERSION = "2025-07";
/** The most Shopify sends in one page of products. */
export const SHOPIFY_PAGE_SIZE = 250;
/** Proposed: list pages read per run, so a runaway cursor can never keep a run going. 40 x 250 = 10,000 products. */
export const SHOPIFY_MAX_PAGES = 40;

const FIELDS = "id,title,handle,status,variants";
/** Currencies whose smallest unit is the whole unit: 1500 yen is 1500, not 150000. */
const WHOLE_UNIT_CURRENCIES = new Set([
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "ISK",
  "UGX",
  "XAF",
  "XOF",
  "XPF",
  "PYG",
  "RWF",
]);

// ---- addresses ----------------------------------------------------------------------------------

/**
 * The store's myshopify.com address from what a person typed: `ridgeline-coaching`,
 * `ridgeline-coaching.myshopify.com`, or that with `https://` and a path. Anything else throws,
 * because the token is sent to this host and to no other: a custom domain, a port, an address with
 * a user name or a host that only ends in myshopify.com all fail here, before any request.
 */
export function shopifyHost(input: string): string {
  const host =
    input
      .trim()
      .toLowerCase()
      .replace(/^https:\/\//, "")
      .split("/")[0] ?? "";
  const m = /^([a-z0-9][a-z0-9-]{0,62})(?:\.myshopify\.com)?$/.exec(host);
  if (!m)
    throw new Error(
      `${SHOPIFY_SHOP_DOMAIN} must be the store's myshopify.com address, such as ridgeline-coaching.myshopify.com. Nothing was requested.`,
    );
  return `${m[1]}.myshopify.com`;
}

function apiVersion(env: Readonly<Record<string, string | undefined>>): string {
  const v = (env[SHOPIFY_API_VERSION] ?? "").trim() || DEFAULT_SHOPIFY_API_VERSION;
  if (!/^\d{4}-(?:01|04|07|10)$/.test(v))
    throw new Error(
      `${SHOPIFY_API_VERSION} must be a quarterly release such as ${DEFAULT_SHOPIFY_API_VERSION}. Nothing was requested.`,
    );
  return v;
}

// ---- mapping ------------------------------------------------------------------------------------

/**
 * A price ("54.00", "58.5") as whole minor units. The text is split at the point (toMinor), never
 * multiplied. "0.00" is 0: a free item. An empty, missing or non-plain amount is null: no price,
 * not a free one. For a currency with no minor unit the whole number is the amount.
 */
export function shopifyPrice(value: unknown, currency: string): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (text === "") return null;
  if (WHOLE_UNIT_CURRENCIES.has(currency.toUpperCase())) {
    const m = /^(\d+)(?:\.0+)?$/.exec(text);
    const whole = m ? Number(m[1]) : NaN;
    return Number.isSafeInteger(whole) ? whole : null;
  }
  try {
    return toMinor(typeof value === "number" ? value : text);
  } catch {
    return null;
  }
}

/**
 * Whether a variant can be bought, from what the product list already says (no inventory scope):
 * not tracked is available; tracked with stock is available; tracked with none left follows the
 * shop's policy ("deny" is sold out, "continue" keeps selling). Anything the answer does not say
 * is null, never a guess.
 */
export function shopifyAvailability(raw: Record<string, unknown>): boolean | null {
  const management = raw.inventory_management;
  if (management === null) return true;
  if (typeof management !== "string") return null;
  const quantity = raw.inventory_quantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) return null;
  if (quantity > 0) return true;
  if (raw.inventory_policy === "continue") return true;
  if (raw.inventory_policy === "deny") return false;
  return null;
}

/** One entry of a product's `variants`. Only the fields of the type are kept. */
export function mapShopifyVariant(raw: unknown, currency: string): CatalogueVariant {
  const id = isRecord(raw) ? idText(raw.id) : null;
  if (!isRecord(raw) || id === null)
    throw new Error("Shopify answered with a variant that has no id.");
  const sku = skuText(raw.sku);
  return {
    id,
    ...(sku === undefined ? {} : { sku }),
    price: shopifyPrice(raw.price, currency),
    currency,
    available: shopifyAvailability(raw),
  };
}

/** One product of the list. A product is active only when its status says so. */
export function mapShopifyProduct(raw: unknown, currency: string): ShopifyProduct {
  const id = isRecord(raw) ? idText(raw.id) : null;
  if (!isRecord(raw) || id === null)
    throw new Error("Shopify answered with a product that has no id.");
  return {
    source: "shopify",
    id,
    handle: typeof raw.handle === "string" ? raw.handle : "",
    name: typeof raw.title === "string" ? raw.title : "",
    active: raw.status === "active",
    variants: Array.isArray(raw.variants)
      ? raw.variants.map((v: unknown) => mapShopifyVariant(v, currency))
      : [],
  };
}

/**
 * The page_info of the rel="next" link of a Link header, or undefined when there is none. Only the
 * token is taken: the next address is built on the store's own host, never copied from the header.
 */
export function nextPageInfo(link: string | undefined): string | undefined {
  if (!link) return undefined;
  for (const m of link.matchAll(/<([^>]+)>\s*;\s*rel\s*=\s*"?([a-z]+)"?/gi)) {
    if ((m[2] ?? "").toLowerCase() !== "next") continue;
    try {
      const info = new URL(m[1] ?? "", "https://shop.invalid").searchParams.get("page_info");
      if (info) return info;
    } catch {
      // not an address: no next page
    }
  }
  return undefined;
}

// ---- reading ------------------------------------------------------------------------------------

const refusal = (status: number): ConnectorRefusedError =>
  new ConnectorRefusedError(
    status,
    status === 401
      ? `Shopify did not accept ${SHOPIFY_ACCESS_TOKEN}: it is wrong, or the app that made it was uninstalled. Copy the Admin API access token again.`
      : `${SHOPIFY_ACCESS_TOKEN} cannot read products. Give the app the read_products scope, nothing else is needed, and install it again so the new scope applies.`,
  );

/** The scopes a token holds that Gaugeline does not need. Nothing when it holds read_products alone. */
function extraScopes(body: unknown): string[] {
  const list = isRecord(body) && Array.isArray(body.access_scopes) ? body.access_scopes : [];
  const handles = list.flatMap((s: unknown) =>
    isRecord(s) && typeof s.handle === "string" ? [s.handle] : [],
  );
  return [...new Set(handles.filter((h) => h !== "read_products"))].sort();
}

export interface ShopifyConnectorOptions {
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Shopify as a source of products, variants, prices and availability. Read only: every request is
 * a GET to the store's own Admin API address with the token in the X-Shopify-Access-Token header.
 * Three resources are read: the token's scopes (to say if it holds more than read_products), the
 * shop's currency, and the product list (250 a page, following the Link header's page_info, at most
 * SHOPIFY_MAX_PAGES pages). Nothing else is asked, and the GraphQL endpoint, which takes a POST, is
 * not used.
 */
export function createShopifyConnector(
  options: ShopifyConnectorOptions = {},
): Connector<ShopifyProduct> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "shopify",
    envVars: [...SHOPIFY_ENV_VARS],
    optionalEnvVars: [...SHOPIFY_OPTIONAL_ENV_VARS],
    secretEnvVars: [SHOPIFY_ACCESS_TOKEN],
    configured: (env) => isConfigured(env, SHOPIFY_ENV_VARS),
    async read(env, fetcher, note = () => undefined) {
      try {
        const domain = shopifyHost(env[SHOPIFY_SHOP_DOMAIN] ?? "");
        const version = apiVersion(env);
        const source: JsonSource = {
          fetcher,
          request: {
            headers: { "X-Shopify-Access-Token": (env[SHOPIFY_ACCESS_TOKEN] ?? "").trim() },
          },
          sleep,
          system: "Shopify",
        };
        const base = `https://${domain}/admin/api/${version}`;
        const currency = await openingReads(source, domain, base, note);
        return await listProducts(source, base, currency, note);
      } catch (err) {
        if (err instanceof ConnectorRefusedError || err instanceof ConnectorRateLimitedError)
          throw err;
        // Whatever a fetcher put in a message, the token is blanked before it leaves this file.
        const text = err instanceof Error ? err.message : String(err);
        throw new Error(createRedactor(env, [SHOPIFY_ACCESS_TOKEN])(text));
      }
    },
  };
}

/** The scopes (advice only) and the shop's currency. A 401 stops the run here, after one request. */
async function openingReads(
  source: JsonSource,
  domain: string,
  base: string,
  note: (message: string) => void,
): Promise<string> {
  try {
    const { body } = await getJson(source, `https://${domain}/admin/oauth/access_scopes.json`);
    const extra = extraScopes(body);
    if (extra.length > 0)
      note(
        `${SHOPIFY_ACCESS_TOKEN} can also use ${extra.join(", ")}. Gaugeline only needs read_products: create a token for an app with that one scope and nothing else.`,
      );
  } catch (err) {
    // The scopes are advice. Only a wrong token or a rate limit means anything for the run.
    if (err instanceof ConnectorRateLimitedError) throw err;
    if (err instanceof ConnectorRefusedError && err.status === 401) throw refusal(401);
    // anything else (404, 5xx, not JSON): no advice
  }
  try {
    const { body } = await getJson(source, `${base}/shop.json?fields=currency`);
    const currency = isRecord(body) && isRecord(body.shop) ? body.shop.currency : undefined;
    if (typeof currency === "string") return currency;
    throw new Error("Shopify did not say which currency the shop sells in.");
  } catch (err) {
    if (err instanceof ConnectorRateLimitedError) throw err;
    if (err instanceof ConnectorRefusedError && err.status === 401) throw refusal(401);
    if (err instanceof ConnectorStatusError && err.status === 404)
      throw new Error(
        `Shopify has no store at ${domain}. Check ${SHOPIFY_SHOP_DOMAIN} is the store's myshopify.com address.`,
      );
    note(
      "Gaugeline could not read the shop's currency from Shopify, so prices are listed without one and a currency mismatch cannot be found.",
    );
    return "";
  }
}

/** Every product of the store, in list order, each once. */
async function listProducts(
  source: JsonSource,
  base: string,
  currency: string,
  note: (message: string) => void,
): Promise<ShopifyProduct[]> {
  // A Map keyed by id: insertion order is list order, and a product that moves between pages while
  // the list is read (the shop changed) is kept once.
  const byId = new Map<string, ShopifyProduct>();
  const seenPages = new Set<string>();
  let pageInfo: string | undefined;
  for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
    const url = `${base}/products.json?limit=${SHOPIFY_PAGE_SIZE}${pageInfo === undefined ? "" : `&page_info=${encodeURIComponent(pageInfo)}`}&fields=${FIELDS}`;
    let answer: Awaited<ReturnType<typeof getJson>>;
    try {
      answer = await getJson(source, url);
    } catch (err) {
      if (err instanceof ConnectorRefusedError) throw refusal(err.status);
      throw err;
    }
    const { body, headers } = answer;
    if (!isRecord(body) || !Array.isArray(body.products))
      throw new Error("Shopify answered with something that is not a list of products.");
    for (const raw of body.products) {
      const p = mapShopifyProduct(raw, currency);
      if (!byId.has(p.id)) byId.set(p.id, p);
    }
    const next = nextPageInfo(headers.link);
    if (next === undefined) return [...byId.values()];
    if (seenPages.has(next)) {
      note(
        `Shopify sent the same page of products twice, so Gaugeline stopped reading them after ${byId.size}.`,
      );
      return [...byId.values()];
    }
    seenPages.add(next);
    pageInfo = next;
  }
  note(
    `Shopify has more products than Gaugeline reads in one run: it read the first ${byId.size} (${SHOPIFY_MAX_PAGES} pages) and left the rest out.`,
  );
  return [...byId.values()];
}

/** The default connector. */
export const shopifyConnector: Connector<ShopifyProduct> = createShopifyConnector();
