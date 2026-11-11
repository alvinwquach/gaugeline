import { describePartial } from "../adapters/collect.js";
import {
  comparablePrice,
  type ProductRead,
  type SquarespaceCommerceReading,
} from "../adapters/squarespace-commerce-read.js";
import { SQUARESPACE_COMMERCE_LIMITS } from "../adapters/squarespace-commerce.entry.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";
import { formatMoney } from "../products/money.js";

/**
 * The checks that need Squarespace's Commerce API: whether the price and the stock a product page shows
 * are the ones the store's own data holds. Pure over a SquarespaceCommerceReading (ids, slugs, numbers and
 * statuses, never a name or a page's words), so the same store gives the same findings. Prices are whole
 * numbers in minor units and are compared only in one currency, never converted. Nothing here says which
 * side is right. Everything in a reading came from a platform and a site: it is printed and never acted on.
 */

const nameOf = (p: { slug?: string; id: string }): string => p.slug ?? p.id;

/** The lines every Squarespace commerce check says when the read fell short: a refusal, a rate limit, nothing to compare. */
function unfinished(r: SquarespaceCommerceReading, ctx: CheckContext): boolean {
  if (r.unreadable !== undefined) {
    ctx.couldNotCheck?.(r.site, `Squarespace's Products API was not read: ${r.unreadable}`);
    return true;
  }
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
  if (r.visible === 0 && r.partial === undefined)
    ctx.couldNotCheck?.(
      r.site,
      "The Products API lists no visible product, so no page was compared. That is not a pass: a key that cannot see the store looks the same as an empty store.",
    );
  for (const u of r.unaddressed)
    ctx.couldNotCheck?.(r.site, `product ${u.id} was not compared, because ${u.reason}.`);
  if (r.pagesSkipped > 0)
    ctx.couldNotCheck?.(
      r.site,
      `${r.pagesSkipped} ${r.pagesSkipped === 1 ? "product page was" : "product pages were"} not asked for, because a run asks for at most ${r.pageBudget}.`,
    );
  return false;
}

/** Product pages that did not answer, or that show nothing to compare, said once each with the count. */
function pageProblems(
  products: readonly ProductRead[],
  what: string,
  shows: (p: ProductRead & { page: { kind: "page" } }) => boolean,
  ctx: CheckContext,
  site: string,
): ProductRead[] {
  const usable: ProductRead[] = [];
  const blank: string[] = [];
  for (const p of products) {
    if (p.page.kind === "unread") {
      ctx.couldNotCheck?.(p.url, `the product page was not read (${p.page.reason})`);
    } else if (p.page.kind === "missing") {
      ctx.couldNotCheck?.(
        p.url,
        `the product page answers ${p.page.status}, so its ${what} was not compared`,
      );
    } else if (shows(p as ProductRead & { page: { kind: "page" } })) usable.push(p);
    else blank.push(nameOf(p));
  }
  if (blank.length > 0)
    ctx.couldNotCheck?.(
      site,
      `${blank.length} product ${blank.length === 1 ? "page shows" : "pages show"} no ${what} Gaugeline can read (${blank.slice(0, 5).join(", ")}${blank.length > 5 ? ", and more" : ""}), so ${blank.length === 1 ? "it was" : "they were"} not compared.`,
    );
  return usable;
}

export const squarespacePriceDiffers = defineCheck<SquarespaceCommerceReading>({
  id: "squarespace-price-differs",
  size: "S",
  done: "The price on every product page is one of the prices the Squarespace Commerce API holds for that product.",
  estimateChanges:
    "A single product is one edit in Squarespace (a sale that ended, a variant price changed in one place). Many products at once usually mean a cached page, a currency setting or a template that shows a fixed price. Allow longer if the prices are copied into the page by hand.",
  area: "Sales & prices",
  severity: "high",
  title: "A Squarespace product page shows a price the store does not have",
  what: "The price in a product page's product data (or the one price it shows) is not one of the prices the Squarespace Commerce API gives that product's variants.",
  why: "Shoppers see one price and the store charges another, and search engines show the page's price in results. Gaugeline can tell you the two disagree, not which is right.",
  fix: "Open the product in Squarespace and check each variant's price and any sale. If the page is wrong, publish it again or clear a cache in front of the site; if the store is wrong, change the variant price. A page that copies prices by hand should read them from the product.",
  tech: `GET /1.0/commerce/products (cursor pages, at most ${SQUARESPACE_COMMERCE_LIMITS.pagesPerList} pages and ${SQUARESPACE_COMMERCE_LIMITS.itemsPerType} products; the next page is asked for by the cursor the answer returns, never by an address it gives), then one GET of each visible product's page (its path from the API, or the \`urls\` pattern; at most ${SQUARESPACE_COMMERCE_LIMITS.pages} pages a run). The API side is each variant's price in minor units (the sale price while it is on sale), parsed from the decimal text without a float. The page side is the Product offers' price, lowPrice and highPrice in its JSON-LD (or the one visible price when there is none), also in minor units. Every page price must be one of the variants' prices; a "From" price must be the lowest. Compared only in a currency with two decimal places and only when both sides name the same one (a page in another currency is could-not-check, never converted); a product with a variant whose price could not be read, a page with no price, or a page that does not answer is could-not-check. Findings carry both numbers and no text from the page or the product. Integers in minor units: 19.99 times 100 is 1998.9999999999998 as a float`,
  run(r, ctx) {
    if (unfinished(r, ctx)) return [];
    const usable = pageProblems(
      r.products,
      "price",
      (p) => p.page.kind === "page" && p.page.prices.length > 0,
      ctx,
      r.site,
    );
    const out: Finding[] = [];
    for (const p of usable) {
      if (p.page.kind !== "page") continue;
      const { api } = p;
      if (api.prices.length === 0) {
        ctx.couldNotCheck?.(p.url, "the Commerce API gave no price Gaugeline could read for it");
        continue;
      }
      if (!comparablePrice(api.currency)) {
        ctx.couldNotCheck?.(
          p.url,
          api.currency === "mixed"
            ? "its variants are priced in different currencies, which are not converted"
            : `its price is in ${api.currency ?? "a currency that was not named"}, which has not two decimal places, so it was not compared`,
        );
        continue;
      }
      if (p.page.currency !== undefined && p.page.currency !== api.currency) {
        ctx.couldNotCheck?.(
          p.url,
          `the page prices it in ${p.page.currency.toUpperCase()} and the store in ${(api.currency ?? "?").toUpperCase()}, which are not converted`,
        );
        continue;
      }
      const have = new Set(api.prices);
      // A "From" price is the lowest of several: it must be the lowest, not merely one of them.
      const wrong = p.page.startingPrice
        ? p.page.prices.filter((x) => x !== api.prices[0])
        : p.page.prices.filter((x) => !have.has(x));
      if (wrong.length === 0) continue;
      if (api.priceGap) {
        ctx.couldNotCheck?.(
          p.url,
          "a variant's price could not be read, so a page price that matches none of the others proves nothing",
        );
        continue;
      }
      const cur = api.currency as string;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${nameOf(p)}: the page shows ${formatMoney({ amount: wrong[0] as number, currency: cur })} and the Commerce API has ${api.prices.map((x) => formatMoney({ amount: x, currency: cur })).join(", ")}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const squarespaceStockDiffers = defineCheck<SquarespaceCommerceReading>({
  id: "squarespace-stock-differs",
  size: "S",
  done: "No product page offers something the Squarespace Inventory API says is sold out, or says sold out for something the API says is in stock.",
  estimateChanges:
    "Usually one product: a stock count changed after the page was cached, or a variant was marked unlimited by mistake. Many products at once mean a cache in front of the site.",
  area: "Sales & prices",
  severity: "medium",
  title: "A Squarespace product page and its stock disagree",
  what: "A product page offers the product as in stock while the Squarespace Inventory API says every variant is out of stock, or says it is out of stock while the API says a variant can be bought.",
  why: "Shoppers order what cannot be shipped, or leave a product that could have sold. Search results show the page's availability.",
  fix: "Open the product in Squarespace and check each variant's stock. If the page is out of date, publish it again or clear a cache in front of the site.",
  tech: `GET /1.0/commerce/products and GET /1.0/commerce/inventory (cursor pages; a key without the Inventory permission, or a plan that does not offer it, makes this check could-not-check and leaves the price check as it is), then one GET of each visible product's page. The API side: "in" when any variant has a row that is unlimited or has a quantity above 0, "out" when every variant has a row and none can be bought, otherwise unknown (a variant with no row is never read as out of stock). The page side: the Product offers' availability in its JSON-LD (InStock, OutOfStock, SoldOut ...), or a sold-out button when there is no product data; mixed or missing words are unknown. Only "in" against "out", either way round, is a finding; unknown on either side is could-not-check. Findings carry a word and a name, never a quantity or a page's text`,
  run(r, ctx) {
    if (unfinished(r, ctx)) return [];
    if (r.stock.state === "unread") {
      ctx.couldNotCheck?.(
        r.site,
        `Squarespace's Inventory API was not read, so stock was not compared: ${r.stock.reason}`,
      );
      return [];
    }
    const usable = pageProblems(
      r.products,
      "stock",
      (p) => p.page.kind === "page" && p.page.availability !== "unknown",
      ctx,
      r.site,
    );
    const out: Finding[] = [];
    for (const p of usable) {
      if (p.page.kind !== "page") continue;
      if (p.api.stock === "unknown") {
        ctx.couldNotCheck?.(
          p.url,
          "the Inventory API has no row for one of its variants (or none can be told apart), so its stock was not compared",
        );
        continue;
      }
      if (p.api.stock === p.page.availability) continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${nameOf(p)}: the page offers it as ${p.page.availability === "in" ? "in stock" : "out of stock"} and the Inventory API says ${p.api.stock === "in" ? "a variant is in stock" : "every variant is out of stock"}`,
        url: p.url,
      });
    }
    return out;
  },
});

export const SQUARESPACE_COMMERCE_CHECKS = [
  squarespacePriceDiffers,
  squarespaceStockDiffers,
] as const;

/** The checks a Squarespace commerce read runs. They are not in the page registry: they read the store and the live site, not one page. */
export function createSquarespaceCommerceRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of SQUARESPACE_COMMERCE_CHECKS) registry.register(check);
  return registry;
}
