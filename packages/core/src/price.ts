import { load } from "cheerio/slim";
import { NetworkError } from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import { defineCheck, type Finding } from "./model.js";
import type { PageSnapshot } from "./snapshot.js";

/**
 * Three prices for one product page: what a visitor sees, what the product data search engines
 * read says, and (on Shopify) what the store would charge, from its public product JSON. Amounts
 * are integers in minor units (cents), never floats. G23's price checks import comparePrices.
 */
export interface PriceReading {
  visible?: number;
  /** The page shows a starting price ("From $48"). */
  startingPrice?: boolean;
  /** The currency the visible price is written in, when it says (€, £, ¥ or a code). */
  visibleCurrency?: string;
  structured?: number;
  /** priceCurrency in the product data. */
  currency?: string;
  /** The product data's availability, without the schema.org prefix ("InStock"). */
  availability?: string;
  charged?: number;
  /** The variant compared, when the product has several. */
  variant?: string;
  /** False when the product can't be bought (sold out, or no add-to-cart). */
  canBuy?: boolean;
}

/** Elements themes put the shown price in, most specific first. */
const VISIBLE = [
  "[data-product-price]",
  ".price-item--sale",
  ".price-item--regular",
  ".product__price",
  ".product-price",
  "[itemprop=price]",
  ".price",
];

const SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
});

/** "$48", "48.00 USD", "€48,00": minor units, or undefined. A thousands comma is not a decimal. */
export function parseAmount(text: string): number | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /(\d{1,3}(?:[,.\s]\d{3})+|\d+)(?:([.,])(\d{1,2}))?(?!\d)/.exec(t);
  if (!m) return undefined;
  const whole = Number((m[1] ?? "").replace(/[,.\s]/g, ""));
  const cents = m[3] ? Number(m[3].padEnd(2, "0")) : 0;
  return whole * 100 + cents;
}

function currencyOf(text: string): string | undefined {
  for (const [sym, code] of Object.entries(SYMBOLS)) if (text.includes(sym)) return code;
  return /\b(USD|EUR|GBP|CAD|AUD|JPY|NZD|CHF|SEK|MXN)\b/.exec(text)?.[1];
}

/** schema.org Product nodes from the page's JSON-LD (top level and @graph). */
function products(jsonLd: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const type = o["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) out.push(o);
    if (o["@graph"]) visit(o["@graph"]);
  };
  jsonLd.forEach(visit);
  return out;
}

function offersOf(product: Record<string, unknown>): Record<string, unknown>[] {
  const raw = product.offers;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((o) => {
    if (!o || typeof o !== "object") return [];
    const offer = o as Record<string, unknown>;
    // An AggregateOffer's own offers, when it lists them; else the aggregate itself.
    if (Array.isArray(offer.offers)) return offersOf({ offers: offer.offers });
    return [offer];
  });
}

/** The variant the page selects: ?variant=<id> on the address. */
function selectedVariant(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("variant") ?? undefined;
  } catch {
    return undefined;
  }
}

function isShopify(page: PageSnapshot): boolean {
  const headers = page.hops.at(-1)?.headers ?? {};
  if (headers["x-shopid"] || /shopify/i.test(headers["powered-by"] ?? "")) return true;
  return page.scripts.some((s) => /cdn\.shopify\.com|\/cdn\/shop\//.test(s));
}

/** /products/<handle> on the page's origin, when the address is a Shopify product page. */
export function shopifyProductJs(url: string): string | undefined {
  try {
    const u = new URL(url);
    const m =
      /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/(?:collections\/[^/]+\/)?products\/([^/?#]+)\/?$/i.exec(
        u.pathname,
      );
    return m?.[1] ? `${u.origin}/products/${m[1]}.js` : undefined;
  } catch {
    return undefined;
  }
}

interface ShopifyProduct {
  variants?: { id?: number; title?: string; price?: number; available?: boolean }[];
}

/**
 * Read the three prices. The page and its JSON-LD are already in the snapshot; on a Shopify product
 * page one more GET reads the public product JSON (no key). Nothing else is requested.
 */
export async function readPrices(page: PageSnapshot, fetcher?: Fetcher): Promise<PriceReading> {
  const $ = load(page.hops.at(-1)?.body ?? "");
  const reading: PriceReading = {};
  const variantId = selectedVariant(page.finalUrl);

  for (const sel of VISIBLE) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const text = (el.attr("content") ?? el.text()).replace(/\s+/g, " ").trim();
    const amount = parseAmount(text);
    if (amount === undefined) continue;
    reading.visible = amount;
    if (/\bfrom\b/i.test(text) || /\bfrom\b/i.test(el.parent().text().slice(0, 40)))
      reading.startingPrice = true;
    const cur = currencyOf(text);
    if (cur) reading.visibleCurrency = cur;
    break;
  }

  const product = products(page.jsonLd)[0];
  if (product) {
    const offers = offersOf(product);
    const offer =
      (variantId &&
        offers.find((o) => typeof o.url === "string" && selectedVariant(o.url) === variantId)) ||
      offers[0];
    if (offer) {
      const price = offer.price ?? offer.lowPrice;
      const amount =
        typeof price === "number"
          ? Math.round(price * 100)
          : typeof price === "string"
            ? parseAmount(price)
            : undefined;
      if (amount !== undefined) reading.structured = amount;
      if (typeof offer.priceCurrency === "string") reading.currency = offer.priceCurrency;
      if (typeof offer.availability === "string")
        reading.availability = offer.availability.replace(/^https?:\/\/schema\.org\//, "");
    }
  }

  const productJs = fetcher && isShopify(page) ? shopifyProductJs(page.finalUrl) : undefined;
  if (fetcher && productJs) {
    try {
      const last = (await fetcher.get(productJs)).at(-1);
      if (last && last.status === 200 && last.body) {
        const data = JSON.parse(last.body) as ShopifyProduct;
        const variants = data.variants ?? [];
        const v =
          (variantId && variants.find((x) => String(x.id) === variantId)) ||
          variants.find((x) => x.available !== false) ||
          variants[0];
        if (v && typeof v.price === "number") reading.charged = v.price;
        if (v && variants.length > 1 && v.title) reading.variant = v.title;
        if (v && typeof v.available === "boolean") reading.canBuy = v.available;
      }
    } catch (err) {
      // No product JSON (not a product, a blocked request, not JSON): charged stays unknown.
      if (!(err instanceof NetworkError) && !(err instanceof SyntaxError)) throw err;
    }
  }
  if (reading.canBuy === undefined) {
    const soldOut = $("button, input[type=submit]").filter(
      (_, el) =>
        /sold out|out of stock|unavailable/i.test($(el).text() + ($(el).attr("value") ?? "")) ||
        ($(el).attr("name") === "add" && $(el).is("[disabled]")),
    );
    if (soldOut.length > 0) reading.canBuy = false;
  }
  return reading;
}

export interface PriceDisagreement {
  kind: "amount" | "currency" | "stock";
  message: string;
}

const LABEL = {
  visible: "the page shows",
  structured: "the product data says",
  charged: "the store charges",
} as const;

function money(n: number): string {
  return (n / 100).toFixed(2);
}

/**
 * Compare the prices that exist: any two that differ, the page's currency against the product
 * data's (never converted), and "in stock" in the product data for something that can't be bought.
 */
export function comparePrices(r: PriceReading): PriceDisagreement[] {
  const out: PriceDisagreement[] = [];
  const present = (["visible", "structured", "charged"] as const).filter((k) => r[k] !== undefined);
  for (let i = 0; i < present.length; i++)
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i] as keyof typeof LABEL;
      const b = present[j] as keyof typeof LABEL;
      const x = r[a] as number;
      const y = r[b] as number;
      if (x === y) continue;
      out.push({
        kind: "amount",
        message: `${LABEL[a]} ${money(x)}${a === "visible" && r.startingPrice ? ' (a starting price, "From")' : ""} but ${LABEL[b]} ${money(y)}`,
      });
    }
  if (r.visibleCurrency && r.currency && r.visibleCurrency !== r.currency)
    out.push({
      kind: "currency",
      message: `the page shows ${r.visibleCurrency} but the product data says ${r.currency} (amounts are not converted)`,
    });
  if (r.canBuy === false && r.availability === "InStock")
    out.push({
      kind: "stock",
      message: "the product data says InStock but the product can't be bought",
    });
  return out;
}

/** The free tool's price check. It is not in the default registry: gaugeline-free runs it. */
export const pricesDisagree = defineCheck<PageSnapshot>({
  id: "prices-disagree",
  area: "Sales & prices",
  severity: "high",
  title: "This product's prices disagree",
  what: "The price on the page, the price in the product data search engines read, and (on Shopify) the price the store charges are not all the same, or the product data says in stock for something that can't be bought.",
  why: "Shoppers see one price and pay another, and Google shows the product data's price and stock in results: a mismatch costs trust and can get listings pulled.",
  fix: "Make the product data come from the same field as the price on the page, and update availability when a product sells out.",
  tech: "Visible: the first of the theme's price elements, in minor units. Structured: the JSON-LD Product offer (the one for ?variant= when there are several). Charged: the variant price from /products/<handle>.js on Shopify (one GET, no key). Currencies are compared, never converted",
  async run(page, ctx) {
    const reading = await readPrices(page, ctx.fetcher);
    const parts = comparePrices(reading);
    if (parts.length === 0) return [];
    const variant = reading.variant ? ` (variant ${reading.variant})` : "";
    return [
      {
        checkId: "prices-disagree",
        severity: "high",
        title: this.title,
        evidence: `${parts.map((p) => p.message).join("; ")}${variant}`,
        url: page.finalUrl,
      } satisfies Finding,
    ];
  },
});
