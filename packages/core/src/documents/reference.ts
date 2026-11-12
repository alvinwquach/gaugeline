import type { ProductGroup } from "../products/match.js";
import { minorExponent } from "../products/money.js";
import { normaliseName } from "../products/match.js";
import type { ReferenceItem } from "./types.js";

/**
 * The prices a document is compared with, from the products the matcher (G23d) grouped: the
 * content system's price first (Sanity, in the units the connector read it in: cents), then the
 * default price of the matched Stripe product. In that order the first source that names an item
 * decides, so a price changed in the CMS wins over an older one in Stripe. A currency that does not
 * have two decimal places (a yen or dinar price) is left out: the document parser reads two.
 * No findings and no requests here; the groups were read by the connectors already.
 */
export function referenceFromGroups(groups: readonly ProductGroup[]): ReferenceItem[] {
  const cms: ReferenceItem[] = [];
  const payments: ReferenceItem[] = [];
  for (const g of groups) {
    const name = g.sanity?.name ?? g.stripe?.name;
    if (name === undefined || normaliseName(name) === "") continue;
    const key = normaliseName(name);
    if (g.sanity?.price !== undefined && g.sanity.price !== null)
      cms.push({ name, key, amount: g.sanity.price, source: "your content system" });
    const price = g.stripe?.prices.find((p) => p.id === g.stripe?.defaultPriceId);
    if (price && price.unitAmount !== null && minorExponent(price.currency) === 2)
      payments.push({ name, key, amount: price.unitAmount, source: "Stripe" });
  }
  return [...cms, ...payments];
}
