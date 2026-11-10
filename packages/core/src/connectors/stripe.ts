import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import { isConfigured } from "./env.js";
import { ConnectorRateLimitedError, ConnectorRefusedError, connectorGet } from "./http.js";
import { createRedactor } from "./redact.js";
import type { Connector, Env } from "./types.js";

/** One price of a product. `unitAmount` is whole minor units, or null (tiered or metered pricing). */
export interface StripePrice {
  id: string;
  unitAmount: number | null;
  currency: string;
  active: boolean;
}

/** A product as checkout holds it, with every price it has (archived ones included). */
export interface StripeProduct {
  id: string;
  name: string;
  active: boolean;
  metadata: Record<string, string>;
  defaultPriceId: string | null;
  prices: StripePrice[];
}

export const STRIPE_API_KEY = "STRIPE_API_KEY";
/** Every variable the Stripe connector reads: what the CLI hands to core for it. */
export const STRIPE_ENV_VARS = [STRIPE_API_KEY] as const;

const API = "https://api.stripe.com/v1";
/** The most Stripe allows per page. */
export const STRIPE_PAGE_SIZE = 100;
/** Proposed: pages read per list, so a runaway cursor can never keep a run going. 50 x 100 = 5,000 rows. */
export const STRIPE_MAX_PAGES = 50;

// ---- the key ------------------------------------------------------------------------------------
// Every fact about how a Stripe key starts lives in this section, so a new Stripe key format is one edit.

export type StripeKeyKind = "restricted" | "secret-live" | "secret-test" | "unknown";

/**
 * What kind of key a value is, from its start alone. Restricted keys (rk_live_, rk_test_) are the
 * only ones Gaugeline wants: they can be limited to reading products and prices. A secret key
 * (sk_live_, sk_test_) can do everything on the account. Anything else, a publishable key included,
 * is "unknown".
 */
export function classifyStripeKey(key: string): StripeKeyKind {
  const k = key.trim();
  if (k.startsWith("rk_live_") || k.startsWith("rk_test_"))
    return k.length > 8 ? "restricted" : "unknown";
  if (k.startsWith("sk_live_")) return "secret-live";
  if (k.startsWith("sk_test_")) return "secret-test";
  return "unknown";
}

/**
 * A test-mode publishable key as it appears in a page or a script: `pk_test_` and at least 16
 * letters and digits, not part of a longer word (so `xpk_test_...` and `my_pk_test_...` are not
 * keys). Proposed: Stripe's own keys are longer; 16 keeps prose such as "pk_test_ keys" out.
 */
const TEST_PUBLISHABLE = /(?<![A-Za-z0-9_])pk_test_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/g;

/** Every distinct test publishable key in a text, in order of first appearance. */
export function findTestPublishableKeys(text: string): string[] {
  return [...new Set([...text.matchAll(TEST_PUBLISHABLE)].map((m) => m[0]))];
}

const CREATE_RESTRICTED = "Create a restricted key that can read products and prices";

/**
 * Decide what to do with STRIPE_API_KEY before anything is requested. Returns the notices to show
 * (none for a restricted key or no key). A live secret key, or any other `sk_` key, throws a
 * ConfigError (the CLI exits 2) unless `allowSecretKey` turns the refusal into a notice. No
 * message here contains any part of the key.
 */
export function guardStripeKey(env: Env, options: { allowSecretKey: boolean }): string[] {
  const key = env[STRIPE_API_KEY];
  if (typeof key !== "string" || key.trim() === "") return [];
  switch (classifyStripeKey(key)) {
    case "restricted":
      return [];
    case "secret-test":
      return [
        `${STRIPE_API_KEY} is a Stripe test-mode secret key. It is used, because it can only touch test data, but a restricted key that can read products and prices is the better habit.`,
      ];
    case "secret-live":
      return refuseSecret(options);
    case "unknown":
      if (/^sk_/i.test(key.trim())) return refuseSecret(options);
      return [
        `${STRIPE_API_KEY} does not start with rk_, so it does not look like a restricted Stripe key. It is used as it is; Stripe will say if it does not accept it.`,
      ];
  }
}

function refuseSecret(options: { allowSecretKey: boolean }): string[] {
  if (options.allowSecretKey)
    return [
      `${STRIPE_API_KEY} is a Stripe secret key and --allow-secret-key is set, so it is used. Gaugeline only reads, but a restricted key that can read products and prices is safer: use one and drop the flag.`,
    ];
  throw new ConfigError(
    `${STRIPE_API_KEY} is a Stripe secret key, which can do far more than read. ${CREATE_RESTRICTED}, set ${STRIPE_API_KEY} to it and run again.`,
    {
      hint: "The steps are in docs/products-and-prices. To use the secret key anyway, pass --allow-secret-key.",
    },
  );
}

// ---- reading ------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An id that is a string, or an expanded object that has one. */
function idOf(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (isRecord(v) && typeof v.id === "string" && v.id !== "") return v.id;
  return null;
}

function priceOf(raw: unknown): { productId: string; price: StripePrice } {
  const productId = isRecord(raw) ? idOf(raw.product) : null;
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "" || productId === null)
    throw new Error("Stripe answered with a price that has no id or no product.");
  const amount = raw.unit_amount;
  return {
    productId,
    price: {
      id: raw.id,
      // null stays null: a tiered price is not a free one.
      unitAmount:
        typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
      currency: typeof raw.currency === "string" ? raw.currency : "",
      active: raw.active !== false,
    },
  };
}

function productOf(raw: unknown, prices: StripePrice[]): StripeProduct {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "")
    throw new Error("Stripe answered with a product that has no id.");
  const metadata: Record<string, string> = {};
  if (isRecord(raw.metadata))
    for (const [k, v] of Object.entries(raw.metadata)) if (typeof v === "string") metadata[k] = v;
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    active: raw.active !== false,
    metadata,
    defaultPriceId: idOf(raw.default_price),
    prices,
  };
}

/**
 * Join the two lists. The prices go into a Map<productId, StripePrice[]> once, so each product
 * finds its own in O(1) however the price pages were interleaved. A price for a product that is
 * not in the list is dropped. Products keep the order Stripe sent them in.
 */
export function buildProducts(
  rawProducts: readonly unknown[],
  rawPrices: readonly unknown[],
): StripeProduct[] {
  const byProduct = new Map<string, StripePrice[]>();
  for (const raw of rawPrices) {
    const { productId, price } = priceOf(raw);
    const bucket = byProduct.get(productId);
    if (bucket) bucket.push(price);
    else byProduct.set(productId, [price]);
  }
  return rawProducts.map((raw) =>
    productOf(
      raw,
      isRecord(raw) && typeof raw.id === "string" ? (byProduct.get(raw.id) ?? []) : [],
    ),
  );
}

type Resource = "products" | "prices";
const PERMISSION: Record<Resource, string> = { products: "Products", prices: "Prices" };

function refusal(resource: Resource, err: ConnectorRefusedError): ConnectorRefusedError {
  const name = PERMISSION[resource];
  return new ConnectorRefusedError(
    err.status,
    err.status === 401
      ? `Stripe did not accept ${STRIPE_API_KEY}. Check it is a restricted key from the right Stripe account.`
      : `${STRIPE_API_KEY} cannot read ${name}. In Stripe, edit the restricted key and set ${name} to Read; nothing else is needed.`,
  );
}

/**
 * Every row of one list, following Stripe's cursor (`starting_after` with the last id while
 * `has_more` is true), at most STRIPE_MAX_PAGES pages. A list that stops early, for a reason that
 * is not an error, comes back with a note and the rows read so far.
 */
async function listAll(
  key: string,
  fetcher: Fetcher,
  resource: Resource,
  note: (message: string) => void,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= STRIPE_MAX_PAGES; page++) {
    const url = `${API}/${resource}?limit=${STRIPE_PAGE_SIZE}${cursor === undefined ? "" : `&starting_after=${encodeURIComponent(cursor)}`}`;
    let body: string;
    try {
      const hop = await connectorGet(fetcher, url, { authorization: `Bearer ${key}` });
      if (hop.truncated)
        throw new Error(
          `Stripe's answer is larger than ${LIMITS.bodyBytes / (1024 * 1024)} MB, which is more than a page of ${resource} should be.`,
        );
      body = hop.body ?? "";
    } catch (err) {
      if (err instanceof ConnectorRefusedError) throw refusal(resource, err);
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.data) || typeof parsed.has_more !== "boolean")
      throw new Error(`Stripe answered with something that is not a list of ${resource}.`);
    const data: unknown[] = parsed.data;
    const last = data.length > 0 ? idOf(data[data.length - 1]) : null;
    if (data.length > 0 && last === null)
      throw new Error(
        `Stripe answered with a ${resource === "products" ? "product" : "price"} that has no id.`,
      );
    if (last !== null && last === cursor) {
      note(
        `Stripe sent the same page of ${resource} twice, so Gaugeline stopped reading them after ${rows.length}.`,
      );
      return rows;
    }
    rows.push(...data);
    if (!parsed.has_more) return rows;
    if (last === null) {
      note(
        `Stripe said there were more ${resource} but sent an empty page, so Gaugeline stopped reading them after ${rows.length}.`,
      );
      return rows;
    }
    cursor = last;
  }
  note(
    `Stripe has more ${resource} than Gaugeline reads in one run: it read the first ${rows.length} (${STRIPE_MAX_PAGES} pages of ${STRIPE_PAGE_SIZE}) and left the rest out.`,
  );
  return rows;
}

export interface StripeConnectorOptions {
  /** Turn the refusal of a live secret key into a notice (--allow-secret-key). */
  allowSecretKey?: boolean;
}

/**
 * Stripe as a source of products. Read only: two paginated GETs (products, then prices, 100 a page)
 * with the key in an Authorization header. Prices are joined to products in memory, never fetched
 * one product at a time. Archived products and prices are included: `active: false` is data.
 */
export function createStripeConnector(
  options: StripeConnectorOptions = {},
): Connector<StripeProduct> {
  return {
    id: "stripe",
    envVars: [STRIPE_API_KEY],
    secretEnvVars: [STRIPE_API_KEY],
    configured: (env) => isConfigured(env, [STRIPE_API_KEY]),
    async read(env, fetcher, note = () => undefined) {
      try {
        // Before any request: a secret key stops here, and a notice is passed on.
        for (const n of guardStripeKey(env, { allowSecretKey: options.allowSecretKey === true }))
          note(n);
        const key = (env[STRIPE_API_KEY] ?? "").trim();
        const products = await listAll(key, fetcher, "products", note);
        const prices = await listAll(key, fetcher, "prices", note);
        return buildProducts(products, prices);
      } catch (err) {
        if (
          err instanceof ConfigError ||
          err instanceof ConnectorRefusedError ||
          err instanceof ConnectorRateLimitedError
        )
          throw err;
        // Whatever a fetcher put in a message, the key is blanked before it leaves this file.
        const text = err instanceof Error ? err.message : String(err);
        throw new Error(createRedactor(env, [STRIPE_API_KEY])(text));
      }
    },
  };
}

/** The default connector: a live secret key is refused. */
export const stripeConnector: Connector<StripeProduct> = createStripeConnector();
