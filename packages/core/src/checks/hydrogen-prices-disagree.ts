import { load } from "cheerio/slim";
import { embeddedVariantPrice, isHydrogenSite, readEmbedded } from "../hydrogen/detect.js";
import { exponentOf, machineMinor, shownMinor } from "../hydrogen/money.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

interface Source {
  label: string;
  minor: number;
  currency: string;
}

/** Price nodes of schema.org Product offers in the page's JSON-LD (depth and count capped). */
function offerPrice(
  jsonLd: unknown[],
  variant: string | null,
): { amount: string; currency: string } | undefined {
  const offers: Record<string, unknown>[] = [];
  const stack: [unknown, number][] = jsonLd.map((n) => [n, 0]);
  for (let visits = 0; stack.length > 0 && visits < 5_000; visits += 1) {
    const [n, d] = stack.pop() as [unknown, number];
    if (d > 8 || typeof n !== "object" || n === null) continue;
    if (Array.isArray(n)) {
      for (const c of n.slice(0, 100)) stack.push([c, d + 1]);
      continue;
    }
    const o = n as Record<string, unknown>;
    const type = o["@type"];
    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
    if (isProduct) {
      const raw = o.offers;
      for (const x of (Array.isArray(raw) ? raw : raw ? [raw] : []).slice(0, 50))
        if (typeof x === "object" && x !== null) offers.push(x as Record<string, unknown>);
    }
    if (o["@graph"] !== undefined) stack.push([o["@graph"], d + 1]);
  }
  const pick =
    (variant === null
      ? undefined
      : offers.find((o) => typeof o.url === "string" && o.url.includes(`variant=${variant}`))) ??
    offers[0];
  if (!pick) return undefined;
  const price = pick.price ?? pick.lowPrice;
  const currency = pick.priceCurrency;
  const amount = typeof price === "number" ? String(price) : price;
  return typeof amount === "string" && typeof currency === "string" && currency.length === 3
    ? { amount, currency: currency.toUpperCase() }
    : undefined;
}

const dec = (minor: number, currency: string): string => {
  const e = exponentOf(currency);
  const s = String(minor).padStart(e + 1, "0");
  return e === 0 ? s : `${s.slice(0, -e)}.${s.slice(-e)}`;
};

export const hydrogenPricesDisagree = defineCheck<PageSnapshot>({
  id: "hydrogen-prices-disagree",
  size: "M",
  done: "The price shown, the product data search engines read and the price in the page's state are the same for the variant on offer.",
  estimateChanges:
    "Product data written by hand in the route needs to read the same variant field the page shows; a theme with several price components needs each one checked.",
  area: "Sales & prices",
  severity: "high",
  title: "This Hydrogen product's prices disagree",
  what: "On a product page of this Hydrogen storefront, the price shown to the shopper, the price in the page's structured data (JSON-LD offer, product:price:amount or og:price:amount) and the variant price in the page's embedded state are not all the same, or are in different currencies.",
  why: "Shoppers see one price and the cart can start from another, and Google shows the structured data's price in results: a mismatch costs trust and can get listings pulled.",
  fix: "Build the JSON-LD and meta tags from the same selected variant the page shows (selectedOrFirstAvailableVariant, after the ?option= choices are applied) rather than the product's first variant or a cached copy.",
  tech: "Hydrogen storefronts, no extra request. Amounts are integers in minor units with the currency's own exponent (JPY 0, USD 2, BHD 3), read digit by digit, never as floats; currencies are compared, never converted. Shown: the text of the .product-price element (or aria-label Price), compare-at (s, del) left out. Structured: the JSON-LD Product offer for ?variant= or the first, product:price:amount with product:price:currency, og:price:amount with og:price:currency. Embedded: product.selectedOrFirstAvailableVariant.price (MoneyV2) in the streamed state. What a cart or checkout would charge is not compared: it needs a cart, which Gaugeline never creates, and the Storefront API is POST only; the check says so under could not run. The product and price fields are those of the @shopify/cli-hydrogen 13.0.6 starter; JSON-LD and the meta names are schema.org and Open Graph conventions (uncited for Hydrogen)",
  async run(page, ctx) {
    if (!isHydrogenSite(page) || !isHtmlPage(page)) return [];
    const embedded = readEmbedded(page);
    const inState = embeddedVariantPrice(embedded);
    let variant: string | null = null;
    try {
      variant = new URL(page.finalUrl).searchParams.get("variant");
    } catch {
      // no variant in an address that does not parse
    }
    const ld = offerPrice(page.jsonLd, variant);
    const $ = load((page.hops.at(-1)?.body ?? "").slice(0, 400_000));
    const meta = (name: string): string | undefined =>
      $(`meta[property="${name}"], meta[name="${name}"]`).first().attr("content");
    const metaAmount = meta("product:price:amount") ?? meta("og:price:amount");
    const metaCurrency = meta("product:price:currency") ?? meta("og:price:currency");

    const sources: Source[] = [];
    const add = (label: string, amount: string | undefined, currency: string | undefined) => {
      const minor =
        amount === undefined || currency === undefined ? undefined : machineMinor(amount, currency);
      if (minor !== undefined && currency !== undefined)
        sources.push({ label, minor, currency: currency.toUpperCase() });
    };
    add("the page's state", inState?.amount, inState?.currency);
    add("the product data", ld?.amount, ld?.currency);
    add("the price meta tag", metaAmount, metaCurrency);

    // The shown price: in the currency the other sources agree on, else not read.
    const el = $(".product-price, [aria-label=Price]").first();
    if (el.length > 0) {
      const clone = el.clone();
      clone.find("s, del").remove();
      const currency = sources[0]?.currency;
      const shown = currency === undefined ? undefined : shownMinor(clone.text(), currency);
      if (currency !== undefined && shown !== undefined)
        sources.unshift({
          label: "the page shows",
          minor: shown.minor,
          currency: shown.currency ?? currency,
        });
    }

    const onProduct = /\/products\/[^/]+/.test(new URL(page.finalUrl).pathname);
    if (sources.length > 0 || onProduct)
      ctx.couldNotCheck?.(
        page.finalUrl,
        "the price a cart or checkout would charge is not compared: that needs a cart, which Gaugeline will not create",
      );
    if (sources.length < 2) {
      if (onProduct)
        ctx.couldNotCheck?.(
          page.finalUrl,
          "fewer than two prices could be read on this product page (shown price, JSON-LD, price meta tags, embedded variant price)",
        );
      return [];
    }
    const parts: string[] = [];
    const first = sources[0] as Source;
    for (const s of sources.slice(1)) {
      if (s.currency !== first.currency)
        parts.push(
          `${first.label} ${first.currency} but ${s.label} ${s.currency} (amounts are not converted)`,
        );
      else if (s.minor !== first.minor)
        parts.push(
          `${first.label} ${dec(first.minor, first.currency)} but ${s.label} ${dec(s.minor, s.currency)} ${s.currency}`,
        );
    }
    if (parts.length === 0) return [];
    return [
      {
        checkId: "hydrogen-prices-disagree",
        severity: "high",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
