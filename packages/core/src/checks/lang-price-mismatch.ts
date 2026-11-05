import { pagePrices } from "../languages.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const langPriceMismatch = defineCheck<PageSnapshot>({
  id: "lang-price-mismatch",
  area: "Sales & prices",
  severity: "high",
  title: "Prices differ between language versions",
  what: "The same item (matched by its structured data sku, or name) shows a different price on another language version of the page.",
  why: "Customers see one price and pay another, or compare the two versions and stop trusting either.",
  fix: "Update the price on every version, ideally from one product record. A version that was copied and translated keeps last month's price.",
  tech: 'Product or Offer price in JSON-LD (then the configured priceSelector; never free text) differs for one sku across versions; "$12", "12 USD" and "$12.00" are equal',
  async run(page, ctx) {
    const group = await ctx.languages?.();
    const loaded = (group?.versions ?? []).filter((v) => v.page);
    if (!group || loaded.length === 0) return [];
    const rules = ctx.languageRules ?? {};
    const sets = [
      { lang: group.lang ?? "this page", url: page.finalUrl, prices: pagePrices(page, rules) },
      ...loaded.map((v) => ({
        lang: v.lang,
        url: v.url,
        prices: pagePrices(v.page as PageSnapshot, rules),
      })),
    ];
    // Nothing priced anywhere: nothing to compare. Prices on some versions only, or a configured
    // selector that finds nothing: could not check, with what to add.
    const priced = sets.filter((s) => s.prices.length > 0);
    if (priced.length === 0 && !rules.priceSelector) return [];
    if (priced.length < sets.length) {
      const without = sets.filter((s) => s.prices.length === 0).map((s) => s.lang);
      throw new Error(
        `No prices in structured data on the ${without.join(", ")} version, so prices could not be compared (add Product offers, or a priceSelector; see the languages guide).`,
      );
    }
    const origin = new URL(page.finalUrl).origin;
    const byKey = new Map<string, { lang: string; url: string; price: number; raw: string }[]>();
    for (const s of sets)
      for (const p of s.prices)
        byKey.set(p.key, [
          ...(byKey.get(p.key) ?? []),
          { lang: s.lang, url: s.url, price: p.price, raw: p.raw },
        ]);
    const out = [];
    for (const [key, seen] of byKey) {
      if (new Set(seen.map((x) => x.price)).size < 2) continue;
      out.push({
        checkId: "lang-price-mismatch",
        severity: "high" as const,
        title: this.title,
        evidence: `${key.replace(/^(sku|name|selector):/, "")}: ${firstFew(seen.map((x) => `${x.raw} on ${shortUrl(x.url, origin)} (${x.lang})`))}`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
