import type { PrintfulVariant } from "../connectors/printful.js";
import type { StripeProduct } from "../connectors/stripe.js";
import {
  CheckRegistry,
  defineCheck,
  type Check,
  type CheckContext,
  type Finding,
} from "../model.js";
import type { ProductGroup, Tier } from "../products/match.js";
import { formatMoney, minorExponent, type Money } from "../products/money.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * What the price checks read: the groups the matcher made (one per Sanity product), and the unit
 * the Sanity connector read prices in. The connector reads a "major" price ("48") with two places,
 * which is wrong for a yen or dinar product; the checks put that right once the Stripe currency is
 * known. A "cents" price is already in minor units and is used as it is.
 */
export interface PriceCheckInput {
  groups: readonly ProductGroup[];
  /** GAUGELINE_SANITY_PRICE_UNIT as the connector read it. Default "major", like the connector. */
  sanityPriceUnit?: "cents" | "major";
}

export const PRICE_CHECK_IDS = [
  "price-mismatch",
  "price-stored-twice",
  "printful-price",
  "stripe-no-price",
] as const;
export type PriceCheckId = (typeof PRICE_CHECK_IDS)[number];

// ---- words --------------------------------------------------------------------------------------

/** How a match is named in a finding, so it reads "matched by SKU" and never asks for trust in a score. */
const HOW: Readonly<Record<Tier, string>> = {
  "saved-id": "saved id",
  "metadata-id": "metadata id",
  sku: "SKU",
  name: "name",
};

/** "matched by SKU", or "" for a group built by hand with no tier. */
export const matchedBy = (tier: Tier | undefined): string =>
  tier === undefined ? "" : `matched by ${HOW[tier]}`;

/** The most products or variants a finding lists before it counts the rest. */
const LIST_MAX = 5;
const VARIANT_MAX = 3;

function listed(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Text from a system, for one line of evidence: escaped and cut. */
const safe = (text: string, max = 60): string => escapeInvisible(text, max);

/** A product's name for a message. The id stands in for an empty name. */
function nameOf(g: ProductGroup): string {
  const text = safe(g.sanity?.name ?? "").trim();
  return text === "" ? safe(g.sanity?._id ?? "") : text;
}

/** What a finding is about. Not an address: the product's id in the content system. */
const refOf = (g: ProductGroup): string => `sanity:${g.sanity?._id ?? ""}`;

const lower = (c: string): string => c.trim().toLowerCase();
const shown = (c: string): string => (c.trim() === "" ? "no currency" : c.trim().toUpperCase());

// ---- reading a group ----------------------------------------------------------------------------

/** What the Stripe side of a group offers to compare. */
type StripeSide =
  | { kind: "none" } // no Stripe partner
  | { kind: "no-default" } // the product names no default price
  | { kind: "unread"; id: string } // it names one the price list did not contain
  | { kind: "no-amount" } // tiered, metered or custom pricing: no fixed amount
  | { kind: "no-currency" }
  | { kind: "ready"; money: Money; priceId: string };

function stripeSide(p: StripeProduct | undefined): StripeSide {
  if (p === undefined) return { kind: "none" };
  if (p.defaultPriceId === null) return { kind: "no-default" };
  const price = p.prices.find((x) => x.id === p.defaultPriceId);
  if (price === undefined) return { kind: "unread", id: p.defaultPriceId };
  if (price.unitAmount === null) return { kind: "no-amount" };
  if (lower(price.currency) === "") return { kind: "no-currency" };
  return {
    kind: "ready",
    money: { amount: price.unitAmount, currency: lower(price.currency) },
    priceId: price.id,
  };
}

/** Why a Stripe default price could not be compared, in words for a notice. */
function stripeReason(side: StripeSide): string | null {
  switch (side.kind) {
    case "unread":
      return `Stripe names a default price (${safe(side.id)}) that was not in the prices that were read`;
    case "no-amount":
      return "Stripe's default price has no fixed amount (tiered or custom pricing)";
    case "no-currency":
      return "Stripe's default price has no currency";
    default:
      return null;
  }
}

/**
 * Sanity's price as minor units of the Stripe currency, or null when it has no whole reading there
 * (a yen price that was read as 500.50). Sanity has no currency field, so it takes Stripe's.
 */
function sanityMoney(price: number, currency: string, unit: "cents" | "major"): Money | null {
  const exponent = minorExponent(currency);
  if (unit === "cents" || exponent === 2) return { amount: price, currency };
  // The connector read the text with two places; this currency has another number of them.
  if (exponent > 2) {
    const amount = price * 10 ** (exponent - 2);
    return Number.isSafeInteger(amount) ? { amount, currency } : null;
  }
  const step = 10 ** (2 - exponent);
  return price % step === 0 ? { amount: price / step, currency } : null;
}

interface Notice {
  url: string;
  reason: string;
}

interface Analysis {
  mismatch: Finding[];
  mismatchNotices: Notice[];
  /** Products that store a price in Sanity and in Stripe and agree, in input order. */
  agree: { group: ProductGroup; name: string }[];
  printful: Finding[];
  printfulNotices: Notice[];
  noPrice: Finding[];
}

type Titles = Readonly<Record<PriceCheckId, string>>;

function mismatchFinding(
  g: ProductGroup,
  titles: Titles,
  sanity: Money,
  stripe: Money,
  priceId: string,
): Finding {
  const how = matchedBy(g.stripeTier);
  return {
    checkId: "price-mismatch",
    severity: "high",
    title: titles["price-mismatch"],
    evidence: `"${nameOf(g)}": Sanity says ${formatMoney(sanity)} and Stripe's default price (${safe(priceId)}) says ${formatMoney(stripe)}${how === "" ? "" : ` (${how})`}.`,
    url: refOf(g),
  };
}

/** One Printful comparison: the finding for the differing variants, and the notices for what was skipped. */
function printfulResult(
  g: ProductGroup,
  titles: Titles,
  stripe: Money,
  notices: Notice[],
): Finding | null {
  const synced = (g.printful?.variants ?? []).filter((v) => v.synced);
  const name = nameOf(g);
  const url = refOf(g);
  const unpriced = synced.filter((v) => v.retailPrice === null);
  if (unpriced.length > 0)
    notices.push({
      url,
      reason: `"${name}": ${plural(unpriced.length, "synced Printful variant")} ${unpriced.length === 1 ? "has" : "have"} no retail price, so ${unpriced.length === 1 ? "it was" : "they were"} not compared with Stripe.`,
    });
  const priced = synced.filter(
    (v): v is PrintfulVariant & { retailPrice: number } => v.retailPrice !== null,
  );
  // Compare only when both currencies are known and equal. Prices are never converted.
  const foreign = [
    ...new Set(priced.map((v) => lower(v.currency)).filter((c) => c !== stripe.currency)),
  ];
  if (foreign.length > 0)
    notices.push({
      url,
      reason: `"${name}": Printful prices this product in ${foreign.map(shown).join(" and ")} and Stripe in ${shown(stripe.currency)}, so those prices were not compared. Gaugeline never converts between currencies.`,
    });
  const differing = priced.filter(
    (v) => lower(v.currency) === stripe.currency && v.retailPrice !== stripe.amount,
  );
  if (differing.length === 0) return null;
  const comparedCount = priced.filter((v) => lower(v.currency) === stripe.currency).length;
  const lines = differing.map(
    (v) =>
      `${safe(v.sku ?? v.id)} at ${formatMoney({ amount: v.retailPrice, currency: stripe.currency })}`,
  );
  const how = [
    g.stripeTier === undefined ? "" : `Stripe ${matchedBy(g.stripeTier)}`,
    g.printfulTier === undefined ? "" : `Printful ${matchedBy(g.printfulTier)}`,
  ].filter((s) => s !== "");
  return {
    checkId: "printful-price",
    severity: "medium",
    title: titles["printful-price"],
    evidence: `"${name}": ${differing.length} of ${plural(comparedCount, "synced Printful variant")} ${differing.length === 1 ? "has" : "have"} a retail price that differs from Stripe's default price (${formatMoney(stripe)}): ${listed(lines, VARIANT_MAX)}${how.length === 0 ? "" : ` (${how.join(", ")})`}.`,
    url,
  };
}

function analyse(input: PriceCheckInput, titles: Titles): Analysis {
  const unit = input.sanityPriceUnit ?? "major";
  const out: Analysis = {
    mismatch: [],
    mismatchNotices: [],
    agree: [],
    printful: [],
    printfulNotices: [],
    noPrice: [],
  };
  for (const g of input.groups) {
    const sanity = g.sanity;
    if (sanity === undefined) continue; // The matcher anchors every group on a Sanity product.
    const side = stripeSide(g.stripe);
    const url = refOf(g);
    const name = nameOf(g);

    if (g.stripe !== undefined && g.stripe.active && side.kind === "no-default") {
      const n = g.stripe.prices.length;
      const how = matchedBy(g.stripeTier);
      out.noPrice.push({
        checkId: "stripe-no-price",
        severity: "medium",
        title: titles["stripe-no-price"],
        evidence: `"${name}" is active in Stripe (${safe(g.stripe.id)}) but has no default price${n > 0 ? `, although it has ${plural(n, "price")}` : " and no prices at all"}, so checkout has nothing to charge by default${how === "" ? "" : ` (${how})`}.`,
        url,
      });
    }

    if (sanity.price !== null && g.stripe !== undefined) {
      const why = stripeReason(side);
      if (why !== null)
        out.mismatchNotices.push({
          url,
          reason: `"${name}": ${why}, so it was not compared with Sanity's price.`,
        });
      else if (side.kind === "ready") {
        const site = sanityMoney(sanity.price, side.money.currency, unit);
        if (site === null)
          out.mismatchNotices.push({
            url,
            reason: `"${name}": Sanity's price cannot be read as a whole amount of ${shown(side.money.currency)}, so it was not compared with Stripe's.`,
          });
        else if (site.amount !== side.money.amount)
          out.mismatch.push(mismatchFinding(g, titles, site, side.money, side.priceId));
        else out.agree.push({ group: g, name });
      }
    }

    if (g.printful !== undefined && g.stripe !== undefined) {
      const why = stripeReason(side);
      if (why !== null)
        out.printfulNotices.push({
          url,
          reason: `"${name}": ${why}, so Printful's prices were not compared with it.`,
        });
      else if (side.kind === "ready") {
        const f = printfulResult(g, titles, side.money, out.printfulNotices);
        if (f !== null) out.printful.push(f);
      }
    }
  }
  return out;
}

/** The four checks share one pass over the groups, done once per input. */
const cache = new WeakMap<PriceCheckInput, Analysis>();

function analysis(input: PriceCheckInput, titles: Titles): Analysis {
  let a = cache.get(input);
  if (a === undefined) {
    a = analyse(input, titles);
    cache.set(input, a);
  }
  return a;
}

// ---- the checks ---------------------------------------------------------------------------------

const TITLES: Titles = {
  "price-mismatch": "Website price disagrees with checkout",
  "price-stored-twice": "A price is stored in two systems",
  "printful-price": "Fulfillment lists a different price",
  "stripe-no-price": "No default price in checkout",
};

function notify(ctx: CheckContext, notices: readonly Notice[]): void {
  for (const n of notices) ctx.couldNotCheck?.(n.url, n.reason);
}

export const priceMismatch = defineCheck<PriceCheckInput>({
  id: "price-mismatch",
  size: "M",
  done: "The site and checkout show the same price for each product named.",
  estimateChanges:
    "Deciding which system owns the price comes first. Prices typed into many places are edited one by one.",
  area: "Sales & prices",
  severity: "high",
  title: TITLES["price-mismatch"],
  what: "The price on your website (Sanity) is different from the price Stripe charges for the same product.",
  why: "Customers see one price and pay another, which causes abandoned carts, complaints and refunds.",
  fix: "Decide which system owns the price, usually checkout, and have the other read from it. Until then, change one of the two so they agree.",
  tech: "the Sanity product's price against the unit_amount of the matched Stripe product's default_price, both whole minor units (Sanity has no currency and takes Stripe's); compared only when the Stripe currency is known; a default price with no fixed amount (tiered or custom pricing), one that was not read, or a Sanity price with no whole reading in that currency is skipped with a notice; a Stripe product with no default price is stripe-no-price, not a mismatch; the evidence carries both amounts and the rule that matched the pair, and never says which is right",
  run(input, ctx) {
    const a = analysis(input, TITLES);
    notify(ctx, a.mismatchNotices);
    return a.mismatch;
  },
});

export const priceStoredTwice = defineCheck<PriceCheckInput>({
  id: "price-stored-twice",
  size: "M",
  done: "One system owns each price and the other reads it.",
  estimateChanges:
    "The number of products, and code on both sides that has to change to read instead of store.",
  area: "Sales & prices",
  severity: "low",
  title: TITLES["price-stored-twice"],
  what: "The same price is saved on the Sanity product and on the matched Stripe product, and the two agree today.",
  why: "Two copies that agree today are the cause of next month's mismatch: the next price change has to be made twice, and one of them will be forgotten.",
  fix: "Decide which system owns each price, usually checkout, and have the other read it instead of storing its own copy.",
  tech: "a Sanity product with a price whose matched Stripe product has a default price with a fixed amount, in a known currency, equal to it; one finding per run listing the count and the first five products; products whose prices differ are price-mismatch, not this",
  run(input) {
    const a = analysis(input, TITLES);
    const first = a.agree[0];
    if (first === undefined) return [];
    const names = a.agree.map((p) => {
      // Only the weaker rules are worth a reviewer's eye in a list; the exact ones would be noise.
      const tier = p.group.stripeTier;
      return tier === "sku" || tier === "name" ? `${p.name} (${matchedBy(tier)})` : p.name;
    });
    return [
      {
        checkId: "price-stored-twice",
        severity: "low",
        title: TITLES["price-stored-twice"],
        evidence: `${plural(a.agree.length, "product")} ${a.agree.length === 1 ? "stores its price" : "store their price"} in both Sanity and Stripe, and the two agree today: ${listed(names, LIST_MAX)}. Choose one system to hold each price and have the other read it.`,
        url: refOf(first.group),
      },
    ];
  },
});

export const printfulPrice = defineCheck<PriceCheckInput>({
  id: "printful-price",
  size: "S",
  done: "Fulfillment and checkout list the same price.",
  estimateChanges: "Deciding which system owns the price comes first.",
  area: "Sales & prices",
  severity: "medium",
  title: TITLES["printful-price"],
  what: "A synced Printful variant's retail price is different from the price Stripe charges for the product.",
  why: "Anything that reads Printful's price (a storefront sync, an invoice, a packing slip) shows customers a different number from the one they paid.",
  fix: "Decide which price you mean, then change the other so the two agree, or have Printful's retail price follow checkout.",
  tech: "each synced sync_variants.retail_price of the matched Printful product against the unit_amount of the matched Stripe product's default price, both whole minor units; compared only when the variant's currency is known and equal to Stripe's (a different currency is a notice, never converted); a variant with no retail price, or a Stripe default price with no fixed amount, is skipped with a notice; one finding per product listing up to three differing variants and both match rules",
  run(input, ctx) {
    const a = analysis(input, TITLES);
    notify(ctx, a.printfulNotices);
    return a.printful;
  },
});

export const stripeNoPrice = defineCheck<PriceCheckInput>({
  id: "stripe-no-price",
  size: "S",
  done: "The product has a default price in Stripe, or is archived.",
  estimateChanges: "Several products are one edit each.",
  area: "Sales & prices",
  severity: "medium",
  title: TITLES["stripe-no-price"],
  what: "An active Stripe product that is matched to a product on your website has no default price.",
  why: "Anything that asks Stripe for the product's price (a payment link, a checkout session, a price comparison) finds nothing, and the product cannot be bought or compared.",
  fix: "In Stripe, open the product and set one of its prices as the default, or archive the product if it is no longer sold.",
  tech: "a matched Stripe product with active true and default_price null, whether or not it has other prices; the evidence says how many prices it has; archived products and Stripe products with no Sanity partner are not reported",
  run(input) {
    return analysis(input, TITLES).noPrice;
  },
});

/** The four price checks, in id order. They read a PriceCheckInput, not a page. */
export const PRICE_CHECKS: readonly Check<PriceCheckInput>[] = [
  priceMismatch,
  priceStoredTwice,
  printfulPrice,
  stripeNoPrice,
];

export function createPriceRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of PRICE_CHECKS) registry.register(c);
  return registry;
}
