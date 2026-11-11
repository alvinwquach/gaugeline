import { describePartial } from "../adapters/collect.js";
import type { ShopifyPriceRead, ShopifyReading } from "../adapters/shopify-read.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";
import { formatMoney, minorExponent } from "../products/money.js";

/**
 * The checks that need Shopify's own answers: which published items have no page on the live site,
 * whether a product's price or availability on its page differs from the Storefront API, and whether a
 * theme preview link the site shows can be indexed. Pure over a ShopifyReading (ids, slugs, paths,
 * statuses, prices as minor units and flags, never a title or a text), so the same site gives the same
 * findings. An item hidden from the Online Store has no address and is never reported as missing.
 */

const money = (n: number, currency: string): string => formatMoney({ amount: n, currency });

/** What no check can say when the read itself fell short: a part the token may not read, or a rate limit. */
function unfinished(r: ShopifyReading, ctx: CheckContext): void {
  for (const u of r.unreadable)
    ctx.couldNotCheck?.(r.site, `${u.part}: Shopify would not give this (${u.reason})`);
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const shopifyItemNoPage = defineCheck<ShopifyReading>({
  id: "shopify-item-no-page",
  size: "M",
  done: "Every product, collection, page, blog and article published to the Online Store has a page that answers on the live site.",
  estimateChanges:
    "A page that is gone for every item of a type is one theme template or one redirect. A single item is a handle that was changed or a page the client removed from the Online Store.",
  area: "Launch day",
  severity: "high",
  title: "A Shopify item published to the Online Store has no page on the live site",
  what: "Shopify says an item is published to the Online Store and gives it an address, and that address answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page.",
  fix: "Check the item's Online Store publishing and the theme's template for its type, and that the live domain is the store's primary domain. If the item should not be public, remove it from the Online Store channel.",
  tech: "POST /api/<version>/graphql.json (a Storefront API query, ADR-0006) for products, collections, pages, blogs and articles, each with onlineStoreUrl; then one GET of that path on the live site (redirects followed). A final 404 or 410, or a redirect to the home page, is the finding; a redirect to the password page and any other non-2xx answer are could-not-check for that page. An item whose onlineStoreUrl is null is hidden from the Online Store and is never reported.",
  run(r, ctx) {
    unfinished(r, ctx);
    if (r.pagesSkipped > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.pagesSkipped} ${r.pagesSkipped === 1 ? "page was" : "pages were"} not asked for, because a run asks for at most ${r.pageBudget}.`,
      );
    const out: Finding[] = [];
    for (const p of r.pages) {
      if (p.answer.kind === "unread") {
        ctx.couldNotCheck?.(p.url, `the page was not read (${p.answer.reason})`);
        continue;
      }
      if (p.answer.kind === "redirected-home") {
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${p.type}: ${p.slug ?? p.id} is published to the Online Store and ${p.path} redirects to the home page`,
          url: p.url,
        });
        continue;
      }
      if (p.answer.kind !== "missing") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${p.type}: ${p.slug ?? p.id} is published to the Online Store and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

/** The disagreements for one product, as short sentences. Empty when the page and the API agree. */
function disagreements(p: ShopifyPriceRead, ctx: CheckContext): string[] {
  const { offer, page } = p;
  const out: string[] = [];
  if (page === undefined) {
    ctx.couldNotCheck?.(p.url, `the page was not read (${p.unread ?? "no answer"})`);
    return out;
  }
  const code = offer.currency.toUpperCase();
  const pageCode = page.currency ?? page.visibleCurrency;
  const sameCurrency = pageCode === undefined || code === "" || pageCode.toUpperCase() === code;
  if (offer.minMinor === undefined || offer.maxMinor === undefined)
    ctx.couldNotCheck?.(p.url, "Shopify's price for this product was not a plain amount");
  else if (minorExponent(offer.currency) !== 2)
    ctx.couldNotCheck?.(
      p.url,
      `${code} has a minor unit that is not hundredths, and the page's amounts are read in hundredths, so they were not compared`,
    );
  else if (!sameCurrency)
    ctx.couldNotCheck?.(
      p.url,
      `the page prices in ${pageCode ?? "?"} and the Storefront API in ${code}: amounts are never converted, so they were not compared`,
    );
  else {
    for (const [label, amount] of [
      ["the page shows", page.visible],
      ["the product data says", page.structured],
    ] as const) {
      if (amount === undefined) continue;
      if (amount < offer.minMinor || amount > offer.maxMinor)
        out.push(
          `${label} ${money(amount, offer.currency)} but the Storefront API says ${money(offer.minMinor, offer.currency)}${offer.maxMinor === offer.minMinor ? "" : ` to ${money(offer.maxMinor, offer.currency)}`}`,
        );
    }
  }
  // Availability is judged on every offer the page lists (one per variant), never the first alone, and
  // never on a sold-out button, which may belong to a recommendation or another variant.
  const seen = p.offerAvailability ?? [];
  const inStock = seen.some((a) => a === "InStock");
  const soldOut =
    seen.length > 0 && seen.every((a) => /^(OutOfStock|SoldOut|Discontinued)$/.test(a));
  if (offer.available === false && inStock)
    out.push("the page says InStock but the Storefront API says it cannot be bought");
  else if (offer.available === true && soldOut)
    out.push("the page says sold out but the Storefront API says it can be bought");
  else if (offer.available !== undefined && seen.length === 0 && page.canBuy === false)
    ctx.couldNotCheck?.(
      p.url,
      "the page has a sold-out button but no product data, so its availability was not compared",
    );
  return out;
}

export const shopifyProductDrift = defineCheck<ShopifyReading>({
  id: "shopify-product-drift",
  size: "M",
  done: "The price and availability on every product page match what the Storefront API says.",
  estimateChanges:
    "A theme that prints a hand-typed price or a cached stock badge is a template change per product type. Prices from another app or a market the theme adds are a settings change.",
  area: "Sales & prices",
  severity: "high",
  title: "A Shopify product's page differs from the store",
  what: "The price on the page (or in its product data) is outside the range the Storefront API gives for the product, or the page says in stock or sold out against what the store says.",
  why: "Shoppers see one price or stock state and pay or get another, and search results show the page's data: a mismatch costs trust and can get listings pulled.",
  fix: "Make the page's price and stock come from the product (the theme's product form and its structured data), and clear any cache or app that keeps an old copy.",
  tech: "Storefront API: priceRange (minVariantPrice and maxVariantPrice, amounts as text split into whole minor units, never floats) and availableForSale for each product published to the Online Store. Page: the theme's price element and the product JSON-LD offer, read by the same code as prices-disagree (readPrices) with no extra request. A page price outside min..max, or an availability that contradicts availableForSale, is the finding. Currencies whose minor unit is not hundredths, and different currencies, are could-not-check, never converted. Availability: every offer in the page's product data is considered (not the first only); a sold-out button alone is ignored.",
  run(r, ctx) {
    unfinished(r, ctx);
    if (r.productsSkipped > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.productsSkipped} ${r.productsSkipped === 1 ? "product was" : "products were"} not compared, because a run asks for at most ${r.pageBudget} pages.`,
      );
    const out: Finding[] = [];
    for (const p of r.prices) {
      const parts = disagreements(p, ctx);
      if (parts.length === 0) continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${p.offer.slug}: ${parts.join("; ")}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const shopifyThemePreviewIndexable = defineCheck<ShopifyReading>({
  id: "shopify-theme-preview-indexable",
  size: "S",
  done: "No link on the live site leads to a theme preview that search engines may list.",
  estimateChanges:
    "Removing a preview link from the theme or a page is a minute. A preview theme shared in a menu or a newsletter template needs the link found first.",
  area: "Search & sharing",
  severity: "medium",
  title: "A Shopify theme preview link on the live site can be indexed",
  what: "The live site links to a theme preview address (a preview_theme_id address, or a shopifypreview.com host), and that page has no noindex and no canonical pointing at the public page.",
  why: "A preview shows an unfinished theme, can hold test content, and can compete with the real page in search.",
  fix: "Remove the preview link from the page, menu or template that holds it. Share previews by sending the link directly, not by publishing it.",
  tech: "One GET of the home page, then one GET of each linked address that carries preview_theme_id or a shopifypreview.com host (at most 5, only addresses the site itself links to, on the site's own host, a myshopify.com host or shopifypreview.com: none is guessed). Indexable means a 2xx answer with no noindex in the robots meta tag or X-Robots-Tag and no canonical to a different address.",
  run(r, ctx) {
    unfinished(r, ctx);
    return r.previews
      .filter((p) => p.indexable)
      .map((p): Finding => ({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${p.shown} is linked from the live site and ${p.why}`,
        url: p.url,
      }));
  },
});

export const SHOPIFY_CHECKS = [
  shopifyItemNoPage,
  shopifyProductDrift,
  shopifyThemePreviewIndexable,
] as const;

/** The checks a Shopify read runs. They are not in the page registry: they read the store and the live site, not one page. */
export function createShopifyRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of SHOPIFY_CHECKS) registry.register(check);
  return registry;
}
