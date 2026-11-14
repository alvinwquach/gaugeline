import type { PrintfulProduct } from "../../connectors/printful.js";
import type { SanityProduct } from "../../connectors/sanity.js";
import type { StripePrice, StripeProduct } from "../../connectors/stripe.js";

/**
 * Invented records for the duplicate checks, shaped like the connectors' output. They are built by
 * hand, not recorded: no Sanity, Stripe or Printful account was asked, and the businesses, names
 * and ids do not exist.
 */

export const sanityProduct = (id: string, name: string, extra: Partial<SanityProduct> = {}) =>
  ({ _id: id, name, price: null, ...extra }) satisfies SanityProduct;

export const stripePrice = (
  id: string,
  unitAmount: number | null,
  currency = "usd",
): StripePrice => ({
  id,
  unitAmount,
  currency,
  active: true,
});

export const stripeProduct = (
  id: string,
  name: string,
  extra: Partial<StripeProduct> = {},
): StripeProduct => ({
  id,
  name,
  active: true,
  metadata: {},
  defaultPriceId: null,
  prices: [],
  ...extra,
});

/** A Stripe product with one price, which is its default. */
export const stripeAt = (
  id: string,
  name: string,
  amount: number,
  extra: Partial<StripeProduct> = {},
): StripeProduct =>
  stripeProduct(id, name, {
    defaultPriceId: `price_${id}`,
    prices: [stripePrice(`price_${id}`, amount)],
    ...extra,
  });

export const printfulProduct = (
  id: string,
  name: string,
  extra: Partial<PrintfulProduct> = {},
): PrintfulProduct => ({ id, name, variants: [], ...extra });

/**
 * Harbor Street Tees: one tee stored three ways, "Classic Tee" in the CMS, "classic-tee" in
 * checkout and "CLASSIC TEE" at the supplier, each once. Inside Stripe the gift card was created
 * twice by mistake, at two prices. Only that one is a duplicate.
 */
export function harborStore(): {
  sanity: SanityProduct[];
  stripe: StripeProduct[];
  printful: PrintfulProduct[];
} {
  return {
    sanity: [
      sanityProduct("harbor-tee", "Classic Tee", { sku: "HST-001" }),
      sanityProduct("harbor-giftcard", "Gift card"),
    ],
    stripe: [
      stripeAt("prod_HarborTee", "classic-tee", 2800),
      stripeAt("prod_HarborGift25", "Gift card", 2500),
      stripeAt("prod_HarborGift50", "Gift Card", 5000),
    ],
    printful: [printfulProduct("8101", "CLASSIC TEE", { externalId: "harbor-tee" })],
  };
}

/**
 * Marigold Bakehouse, a pop-up bakery with a small web shop: the tote is in the CMS twice under
 * two names but one SKU, and a second record shares the first's name; the gift card is in Stripe
 * three times (one archived) at two prices; the apron is at the supplier twice under two names
 * with one external id. One finding per system.
 */
export function bakehouseStore(): {
  sanity: SanityProduct[];
  stripe: StripeProduct[];
  printful: PrintfulProduct[];
} {
  return {
    sanity: [
      sanityProduct("mb-tote", "Marigold tote", { sku: "MB-TOTE" }),
      sanityProduct("mb-tote-old", "Marigold Tote!", { sku: "MB-TOTE-OLD" }),
      sanityProduct("mb-tote-2", "Bakehouse canvas bag", { sku: "mb-tote-old" }),
      sanityProduct("mb-loaf", "Sourdough loaf", { sku: "MB-LOAF" }),
    ],
    stripe: [
      stripeAt("prod_MbGift25", "Gift card", 2500),
      stripeAt("prod_MbGift50", "gift card", 5000),
      stripeAt("prod_MbGiftOld", "Gift card", 2500, { active: false }),
      stripeAt("prod_MbLoaf", "Sourdough loaf", 900),
    ],
    printful: [
      printfulProduct("8201", "Marigold apron", { externalId: "mb-apron" }),
      printfulProduct("8202", "Bakehouse apron, navy", { externalId: "mb-apron" }),
      printfulProduct("8203", "Marigold tote", { externalId: "mb-tote" }),
    ],
  };
}
