import type { Fetcher } from "../fetcher.js";
import { toMinor } from "../products/money.js";
import { readPrices } from "../price.js";
import { buildSnapshot, jsonLdNodes } from "../snapshot.js";
import type { PartialRead } from "./collect.js";
import { SQUARESPACE_COMMERCE_LIMITS } from "./squarespace-commerce.entry.js";
import type {
  ProductFacts,
  SquarespaceCommerceAdapter,
  StockState,
} from "./squarespace-commerce.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { onSite } from "./webflow-read.js";

/** What a product page shows, reduced to numbers and two words. The page's text is never kept. */
export type ShownOnPage =
  | {
      kind: "page";
      /** Prices in the page's product data (or its one visible price), in minor units, each once, ascending. */
      prices: number[];
      /** Lower-case ISO 4217 from the product data, when it names one (and names one only). */
      currency?: string;
      /** The visible price is a starting price ("From"): it is the lowest of several. */
      startingPrice: boolean;
      availability: "in" | "out" | "unknown";
    }
  | { kind: "missing"; status: number }
  | { kind: "unread"; reason: string };

/** One visible product with what the API says and what its page shows. */
export interface ProductRead {
  id: string;
  slug?: string;
  /** The page asked for, in full, and its path for the words a finding uses. */
  url: string;
  path: string;
  api: {
    /** Distinct prices of the variants whose price could be read, in minor units, ascending. */
    prices: number[];
    /** Lower-case ISO 4217 when every priced variant has the same one; "mixed" when they differ; absent with no price. */
    currency?: string;
    /** Some variant's price could not be read (not a plain decimal): a page price that matches nothing proves nothing. */
    priceGap: boolean;
    /** "in" when any variant can be bought; "out" when every variant has a row and none can; else "unknown". */
    stock: StockState | "unknown";
  };
  page: ShownOnPage;
}

/**
 * What the two commerce checks need, read once: the visible products from the Products API, the stock from
 * the Inventory API when the key may read it, and one GET of each product's page on the live site. Ids,
 * slugs, addresses, numbers and statuses only: never a name, a description or a page's words.
 */
export interface SquarespaceCommerceReading {
  /** The origin of the live site that was asked. */
  site: string;
  products: ProductRead[];
  /** Why the Products API could not be read at all (no key, refused, not the shape). Then nothing was compared. */
  unreadable?: string;
  /** The Inventory API: "unread" with why when its permission is missing or it is not offered. Prices are still compared. */
  stock: { state: "read" } | { state: "unread"; reason: string };
  /** Visible products the Products API listed, before the page budget. */
  visible: number;
  /** Visible products with no page address (the API gave no safe path and the settings have no pattern). */
  unaddressed: { id: string; reason: string }[];
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadSquarespaceCommerceOptions {
  adapter: SquarespaceCommerceAdapter;
  /** The fetcher for the live site's pages. The key is never sent with these requests. */
  fetcher: Fetcher;
  /** The address of the live site, such as https://tideline-prints.example. */
  site: string;
  /** Replaces SQUARESPACE_COMMERCE_LIMITS.pages. For tests. */
  maxPages?: number;
}

const OUT = new Set(["OutOfStock", "SoldOut", "Discontinued"]);
const IN = new Set(["InStock", "LimitedAvailability", "OnlineOnly", "InStoreOnly", "PreSale"]);

/** What a product page says about price and stock, from its product data (and its visible price when there is none). */
export async function shownOnPage(hops: Parameters<typeof buildSnapshot>[0]): Promise<ShownOnPage> {
  const snapshot = buildSnapshot(hops);
  const prices = new Set<number>();
  const currencies = new Set<string>();
  const states: string[] = [];
  const visit = (node: Record<string, unknown>): void => {
    const offers = node.offers;
    for (const o of Array.isArray(offers) ? offers : offers !== undefined ? [offers] : []) {
      if (o === null || typeof o !== "object") continue;
      const offer = o as Record<string, unknown>;
      const currency =
        typeof offer.priceCurrency === "string" && /^[A-Za-z]{3}$/.test(offer.priceCurrency)
          ? offer.priceCurrency.toLowerCase()
          : undefined;
      if (currency !== undefined) currencies.add(currency);
      for (const key of ["price", "lowPrice", "highPrice"] as const) {
        const raw = offer[key];
        if (typeof raw !== "string" && typeof raw !== "number") continue;
        try {
          prices.add(toMinor(raw, currency));
        } catch {
          // Not a plain decimal: that price says nothing.
        }
      }
      if (typeof offer.availability === "string")
        states.push(offer.availability.replace(/^https?:\/\/schema\.org\//, ""));
      if (Array.isArray(offer.offers)) visit({ offers: offer.offers });
    }
  };
  for (const node of jsonLdNodes(snapshot)) {
    const type = node["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) visit(node);
  }

  let startingPrice = false;
  let visibleCurrency: string | undefined;
  if (prices.size === 0) {
    // No product data: the one price the page shows, which is only a comparison when the page has no better.
    const reading = await readPrices(snapshot);
    if (reading.visible !== undefined) prices.add(reading.visible);
    startingPrice = reading.startingPrice === true;
    visibleCurrency = reading.visibleCurrency?.toLowerCase();
    if (reading.canBuy === false && states.length === 0) states.push("OutOfStock");
  }
  const anyIn = states.some((s) => IN.has(s));
  const anyOut = states.some((s) => OUT.has(s));
  const currency = currencies.size === 1 ? [...currencies][0] : visibleCurrency;
  return {
    kind: "page",
    prices: [...prices].sort((a, b) => a - b),
    ...(currency !== undefined ? { currency } : {}),
    startingPrice,
    // Contradictory or unknown words are "unknown", never a guess.
    availability: anyIn && !anyOut ? "in" : anyOut && !anyIn ? "out" : "unknown",
  };
}

/** One page, asked with GET through the fetcher, and reduced. A 404 or 410 is "missing"; any other non-2xx is unread. */
async function askShown(fetcher: Fetcher, url: string): Promise<ShownOnPage> {
  try {
    const hops = await fetcher.get(url);
    const last = hops.at(-1);
    if (!last) return { kind: "unread", reason: "no answer" };
    if (last.status === 404 || last.status === 410) return { kind: "missing", status: last.status };
    if (last.status < 200 || last.status >= 300)
      return { kind: "unread", reason: `the site answered ${last.status}` };
    return await shownOnPage(hops);
  } catch (err) {
    return { kind: "unread", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** What the API says about one product: its prices, their currency and whether it can be bought. */
function apiSide(
  p: ProductFacts,
  stock: ReadonlyMap<string, StockState> | undefined,
): ProductRead["api"] {
  const priced = p.variants.filter((v) => v.price !== undefined && v.currency !== undefined);
  const currencies = new Set(priced.map((v) => v.currency));
  const states = p.variants.map((v) => stock?.get(v.id));
  return {
    prices: [...new Set(priced.map((v) => v.price as number))].sort((a, b) => a - b),
    ...(currencies.size === 1
      ? { currency: [...currencies][0] as string }
      : currencies.size > 1
        ? { currency: "mixed" }
        : {}),
    priceGap: priced.length < p.variants.length,
    stock:
      stock === undefined || p.variants.length === 0
        ? "unknown"
        : states.includes("in")
          ? "in"
          : states.every((s) => s === "out")
            ? "out"
            : "unknown",
  };
}

/**
 * Read a Squarespace store for the commerce checks. A Products read that cannot be made is recorded with its
 * reason (and nothing is compared); an Inventory read that cannot be made leaves the price part standing;
 * a rate limit that stays ends the read and marks it partial.
 */
export async function readSquarespaceCommerce(
  options: ReadSquarespaceCommerceOptions,
): Promise<SquarespaceCommerceReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? SQUARESPACE_COMMERCE_LIMITS.pages;
  const reading: SquarespaceCommerceReading = {
    site: origin,
    products: [],
    stock: { state: "unread", reason: "the Inventory API was not read" },
    visible: 0,
    unaddressed: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  let catalogue: Awaited<ReturnType<SquarespaceCommerceAdapter["catalogue"]>>;
  try {
    catalogue = await adapter.catalogue();
  } catch (err) {
    if (err instanceof AdapterCouldNotCheck) {
      reading.unreadable = err.reason;
      return reading;
    }
    if (err instanceof AdapterRateLimitedError) {
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: 0,
      };
      return reading;
    }
    throw err;
  }
  if (catalogue.partial) reading.partial = catalogue.partial;
  reading.stock =
    catalogue.stock.state === "read"
      ? { state: "read" }
      : { state: "unread", reason: catalogue.stock.reason };

  const todo: Omit<ProductRead, "page">[] = [];
  for (const p of catalogue.products) {
    if (!p.published) continue;
    reading.visible++;
    // The API's own path first; the settings' pattern when it gave none. Another site's address is never asked.
    const raw =
      p.path ??
      adapter.resolveUrl?.({
        id: p.id,
        type: "products",
        ...(p.slug !== undefined ? { slug: p.slug } : {}),
      }) ??
      "";
    const url = onSite(raw, origin);
    if (url === undefined) {
      reading.unaddressed.push({
        id: p.id,
        reason:
          raw === ""
            ? "the API gave no page address and the settings have no pattern for products"
            : "its address is not on the site being checked",
      });
      continue;
    }
    todo.push({
      id: p.id,
      ...(p.slug !== undefined ? { slug: p.slug } : {}),
      url: url.href,
      path: url.pathname,
      api: apiSide(p, catalogue.stock.state === "read" ? catalogue.stock.byVariant : undefined),
    });
  }
  const asked = todo.slice(0, budget);
  reading.pagesSkipped = todo.length - asked.length;
  reading.products = await Promise.all(
    asked.map(async (p): Promise<ProductRead> => ({ ...p, page: await askShown(fetcher, p.url) })),
  );
  return reading;
}
