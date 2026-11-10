import { LIMITS } from "../limits.js";
import { toMinor } from "../products/money.js";
import type { Fetcher } from "../fetcher.js";
import { isConfigured } from "./env.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  connectorGet,
} from "./http.js";
import { createRedactor } from "./redact.js";
import type { Connector } from "./types.js";

/** One size or colour of a product. `retailPrice` is whole minor units, or null when Printful has none. */
export interface PrintfulVariant {
  id: string;
  /** Absent when Printful has no SKU for it (never an empty string). */
  sku?: string;
  /** False: the design is not yet matched to a printable item, so an order for it cannot be made. */
  synced: boolean;
  retailPrice: number | null;
  currency: string;
}

/** A product of the store, with every variant Printful lists for it. */
export interface PrintfulProduct {
  id: string;
  /** The id the shop (Sanity, Stripe) gave it, when Printful holds one. */
  externalId?: string;
  name: string;
  variants: PrintfulVariant[];
}

export const PRINTFUL_API_TOKEN = "PRINTFUL_API_TOKEN";
export const PRINTFUL_STORE_ID = "PRINTFUL_STORE_ID";
/** Every variable the Printful connector reads: what the CLI hands to core for it. */
export const PRINTFUL_ENV_VARS = [PRINTFUL_API_TOKEN, PRINTFUL_STORE_ID] as const;

const API = "https://api.printful.com";
/** Rows asked for per list page. The shop may hold back fewer; the offset moves by what came. */
export const PRINTFUL_PAGE_SIZE = 100;
/** Proposed: list pages read per run, so a runaway total can never keep a run going. 50 x 100 = 5,000 products. */
export const PRINTFUL_MAX_LIST_PAGES = 50;
/** Product detail requests in flight at once (spec: at most 5 at a time). */
export const PRINTFUL_DETAIL_CONCURRENCY = 5;
/** Proposed (spec): product detail requests per run. Variants only come from the detail endpoint. */
export const PRINTFUL_MAX_DETAILS = 200;
/** Proposed: the longest Retry-After Gaugeline waits for, in seconds. A longer one is given up on. */
export const PRINTFUL_MAX_RETRY_SECONDS = 60;

// ---- mapping ------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An id sent as a number or as text, as text. Anything else (or empty) is null. */
function idText(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

/**
 * Printful's retail price ("24.50", "24.5") as whole minor units. Printful sends a decimal string;
 * the text is split at the point (toMinor), never multiplied. An empty or missing price, or one that
 * is not a plain amount, is null: no price, not a free one.
 */
export function retailToMinor(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    return toMinor(value);
  } catch {
    return null;
  }
}

/** One entry of `sync_variants`. Only the fields of the type are kept. */
export function mapPrintfulVariant(raw: unknown): PrintfulVariant {
  const id = isRecord(raw) ? idText(raw.id) : null;
  if (!isRecord(raw) || id === null)
    throw new Error("Printful answered with a variant that has no id.");
  const sku = typeof raw.sku === "string" && raw.sku.trim() !== "" ? raw.sku.trim() : undefined;
  return {
    id,
    ...(sku === undefined ? {} : { sku }),
    // Only an explicit false is "not synced": a field that is missing must not invent a problem.
    synced: raw.synced !== false,
    retailPrice: retailToMinor(raw.retail_price),
    currency: typeof raw.currency === "string" ? raw.currency : "",
  };
}

interface ListedProduct {
  id: string;
  externalId?: string;
  name: string;
}

function listedProduct(raw: unknown): ListedProduct {
  const id = isRecord(raw) ? idText(raw.id) : null;
  if (!isRecord(raw) || id === null)
    throw new Error("Printful answered with a product that has no id.");
  const externalId =
    typeof raw.external_id === "string" && raw.external_id.trim() !== ""
      ? raw.external_id.trim()
      : undefined;
  return {
    id,
    ...(externalId === undefined ? {} : { externalId }),
    name: typeof raw.name === "string" ? raw.name : "",
  };
}

// ---- requests -----------------------------------------------------------------------------------

interface Context {
  token: string;
  store: string;
  fetcher: Fetcher;
  sleep: (ms: number) => Promise<void>;
}

const unsure = (store: string): string =>
  `${PRINTFUL_API_TOKEN} cannot see store ${store}. Check ${PRINTFUL_STORE_ID} is the number of a store this token was made for, and that the token can view store products (the narrowest read-only choice is in docs/products-and-prices).`;

function refusal(status: number, store: string): ConnectorRefusedError {
  return new ConnectorRefusedError(
    status,
    status === 401
      ? `Printful did not accept ${PRINTFUL_API_TOKEN}: the token is wrong or has been revoked. Create a new private token in the Printful Developer Portal.`
      : unsure(store),
  );
}

/**
 * One GET with the token in an Authorization header and the store in its own header, parsed as JSON.
 * A 429 with a Retry-After of at most PRINTFUL_MAX_RETRY_SECONDS is waited out and asked again once;
 * a second 429, or one with no usable Retry-After, is thrown for the runner to report. 401 and 403
 * (and a 404 on the list, which is how an unknown store answers) become a refusal that says which.
 * A 404 on a product returns null: that product is gone.
 */
async function ask(ctx: Context, path: string, kind: "list" | "detail"): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const hop = await connectorGet(ctx.fetcher, `${API}${path}`, {
        authorization: `Bearer ${ctx.token}`,
        headers: { "X-PF-Store-Id": ctx.store },
        // The fetcher remembers answers: a retry must not be handed the 429 it already got.
        fresh: attempt > 0,
      });
      if (hop.truncated)
        throw new Error(
          `Printful's answer is larger than ${LIMITS.bodyBytes / (1024 * 1024)} MB, which is more than a page should be.`,
        );
      try {
        return JSON.parse(hop.body ?? "");
      } catch {
        throw new Error("Printful answered with something that is not JSON.");
      }
    } catch (err) {
      if (err instanceof ConnectorRefusedError) throw refusal(err.status, ctx.store);
      if (err instanceof ConnectorStatusError && err.status === 404) {
        if (kind === "detail") return null;
        throw refusal(404, ctx.store);
      }
      if (
        err instanceof ConnectorRateLimitedError &&
        attempt === 0 &&
        err.retrySeconds !== undefined &&
        err.retrySeconds <= PRINTFUL_MAX_RETRY_SECONDS
      ) {
        await ctx.sleep(err.retrySeconds * 1000);
        continue;
      }
      throw err;
    }
  }
}

/** Every product of the store, in list order, each once. */
async function listProducts(
  ctx: Context,
  note: (message: string) => void,
): Promise<ListedProduct[]> {
  // A Map keyed by id: insertion order is list order, and a product that moves between pages while
  // the list is read (the shop changed) is kept once.
  const byId = new Map<string, ListedProduct>();
  let offset = 0;
  for (let page = 1; page <= PRINTFUL_MAX_LIST_PAGES; page++) {
    const body = await ask(
      ctx,
      `/store/products?offset=${offset}&limit=${PRINTFUL_PAGE_SIZE}`,
      "list",
    );
    if (!isRecord(body) || !Array.isArray(body.result))
      throw new Error("Printful answered with something that is not a list of products.");
    if (body.result.length === 0) return [...byId.values()];
    for (const raw of body.result) {
      const p = listedProduct(raw);
      if (!byId.has(p.id)) byId.set(p.id, p);
    }
    offset += body.result.length;
    const total = isRecord(body.paging) ? body.paging.total : undefined;
    if (typeof total === "number" && Number.isFinite(total) && offset >= total)
      return [...byId.values()];
  }
  note(
    `Printful has more products than Gaugeline lists in one run: it listed the first ${byId.size} (${PRINTFUL_MAX_LIST_PAGES} pages) and left the rest out.`,
  );
  return [...byId.values()];
}

/** The variants of one product, or null when Printful no longer has it. */
async function readVariants(ctx: Context, id: string): Promise<PrintfulVariant[] | null> {
  const body = await ask(ctx, `/store/products/${encodeURIComponent(id)}`, "detail");
  if (body === null) return null;
  const result = isRecord(body) ? body.result : undefined;
  if (!isRecord(result) || !Array.isArray(result.sync_variants))
    throw new Error("Printful answered with something that is not a product with variants.");
  return result.sync_variants.map(mapPrintfulVariant);
}

/**
 * Run `fn` over the items, at most `limit` at a time, results in item order. After a failure no new
 * item is started; the ones already running finish, and the first failure is thrown.
 */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const at = next++;
      try {
        results[at] = await fn(items[at] as T);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

export interface PrintfulConnectorOptions {
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Printful as a source of store products and their variants. Read only: GET the product list
 * (offset and limit, until the reported total or an empty page), then GET each product's detail for
 * its variants, five at a time, at most PRINTFUL_MAX_DETAILS of them. Products past the cap are left
 * out and one notice states how many.
 */
export function createPrintfulConnector(
  options: PrintfulConnectorOptions = {},
): Connector<PrintfulProduct> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "printful",
    envVars: [...PRINTFUL_ENV_VARS],
    secretEnvVars: [PRINTFUL_API_TOKEN],
    configured: (env) => isConfigured(env, PRINTFUL_ENV_VARS),
    async read(env, fetcher, note = () => undefined) {
      try {
        const store = (env[PRINTFUL_STORE_ID] ?? "").trim();
        if (!/^\d{1,20}$/.test(store))
          throw new Error(
            `${PRINTFUL_STORE_ID} must be the number of the store, such as 1234567. Nothing was requested.`,
          );
        const ctx: Context = {
          token: (env[PRINTFUL_API_TOKEN] ?? "").trim(),
          store,
          fetcher,
          sleep,
        };
        const listed = await listProducts(ctx, note);
        const toRead = listed.slice(0, PRINTFUL_MAX_DETAILS);
        const variants = await pool(toRead, PRINTFUL_DETAIL_CONCURRENCY, (p) =>
          readVariants(ctx, p.id),
        );
        const products: PrintfulProduct[] = [];
        let gone = 0;
        toRead.forEach((p, i) => {
          const v = variants[i];
          if (v === null || v === undefined) gone++;
          else products.push({ ...p, variants: v });
        });
        const skipped = listed.length - toRead.length;
        if (skipped > 0)
          note(
            `Printful has ${listed.length} products. Gaugeline read the variants of ${toRead.length} and skipped ${skipped}: it reads at most ${PRINTFUL_MAX_DETAILS} products in one run.`,
          );
        if (gone > 0)
          note(
            `${gone} product${gone === 1 ? " was" : "s were"} removed from Printful while Gaugeline was reading, so ${gone === 1 ? "it was" : "they were"} left out.`,
          );
        return products;
      } catch (err) {
        if (err instanceof ConnectorRefusedError || err instanceof ConnectorRateLimitedError)
          throw err;
        // Whatever a fetcher put in a message, the token is blanked before it leaves this file.
        const text = err instanceof Error ? err.message : String(err);
        throw new Error(createRedactor(env, [PRINTFUL_API_TOKEN])(text));
      }
    },
  };
}

/** The default connector. */
export const printfulConnector: Connector<PrintfulProduct> = createPrintfulConnector();
