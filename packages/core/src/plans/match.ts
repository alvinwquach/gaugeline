import type { StripePrice, StripeProduct, StripeRecurring } from "../connectors/stripe.js";
import { TIERS, normaliseName, type Tier } from "../products/match.js";
import { toMinor } from "../products/money.js";
import { PLAN_METADATA_KEY } from "./config.js";
import { sameCadence, type Cadence } from "./phrases.js";
import type { PagePlan } from "./read.js";

/**
 * The product matcher's rules, in the product matcher's order, minus the SKU rule: a plan has no
 * SKU. They are taken from TIERS itself so that the two cannot drift apart: the saved id (here the
 * Stripe price id named in gaugeline.plans.json), then the metadata id (the product's
 * `gaugelinePlan` equal to the plan's id), then the name. A check and the app must agree on which
 * plan is which, so there is one order, written once, in products/match.ts.
 */
export const PLAN_TIERS = TIERS.filter((t): t is Exclude<Tier, "sku"> => t !== "sku");
export type PlanTier = (typeof PLAN_TIERS)[number];

export interface PlanMatch {
  plan: PagePlan;
  /** The rule that paired the plan with a price. */
  tier?: PlanTier;
  product?: StripeProduct;
  price?: StripePrice;
  /** Why the plan has no price, when a rule led to one that could not be used. */
  why?: string;
}

export interface PlanMatchResult {
  /** One entry per plan that is on the page, in the order of the configuration. */
  matches: PlanMatch[];
  /** Ids of the prices some plan was paired with. */
  claimed: ReadonlySet<string>;
}

/** Stripe's interval and count as the cadence a page would write. */
export function cadenceOf(r: StripeRecurring): Cadence {
  return { unit: r.interval, count: r.intervalCount };
}

/** Every amount a price has, by lower-case currency: its own, then those in `currencyOptions`. */
export function amountsOf(price: StripePrice): Map<string, number> {
  const out = new Map<string, number>();
  for (const [currency, amount] of Object.entries(price.currencyOptions ?? {}))
    out.set(currency.toLowerCase(), amount);
  const own = price.currency.trim().toLowerCase();
  if (price.unitAmount !== null && own !== "") out.set(own, price.unitAmount);
  return out;
}

/** The page's amount as minor units of `currency`, or null when it has no whole reading there. */
export function pageMinor(plan: PagePlan, currency: string): number | null {
  if (plan.amount === null) return null;
  try {
    return toMinor(plan.amount.text, currency);
  } catch {
    return null;
  }
}

/**
 * Which of a product's recurring prices a plan stands for. Prices another plan has taken are out.
 * Active prices come first (an archived one is chosen only when there is no other). Of several,
 * the one that bills as often as the page says, then the one with the page's amount, then the
 * product's default price, then the first Stripe listed.
 */
function pick(product: StripeProduct, plan: PagePlan, claimed: ReadonlySet<string>) {
  const recurring = product.prices.filter((p) => p.recurring !== undefined && !claimed.has(p.id));
  let pool = recurring.filter((p) => p.active);
  if (pool.length === 0) pool = recurring;
  if (pool.length > 1 && plan.cadence !== null) {
    const cadence = plan.cadence;
    const same = pool.filter(
      (p) => p.recurring !== undefined && sameCadence(cadenceOf(p.recurring), cadence),
    );
    if (same.length > 0) pool = same;
  }
  if (pool.length > 1 && plan.amount !== null) {
    const same = pool.filter((p) =>
      [...amountsOf(p)].some(([currency, amount]) => pageMinor(plan, currency) === amount),
    );
    if (same.length > 0) pool = same;
  }
  if (pool.length > 1) {
    const def = pool.find((p) => p.id === product.defaultPriceId);
    if (def !== undefined) pool = [def];
  }
  return pool[0];
}

type Index<T> = Map<string, T[]>;

function add<T>(index: Index<T>, key: string | null, record: T): void {
  if (key === null || key === "") return;
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [record]);
  else bucket.push(record);
}

/**
 * Pair each plan on the page with the Stripe price it stands for. Pure, in the configuration's
 * order. For each plan the rules run strongest first and stop at the first that finds something:
 * a key with no record is not a hit (the next rule is tried); a hit whose price another plan has
 * taken, or that is not a recurring price, ends the search and leaves the plan without a partner.
 * The saved id may name any price, one-time included; the other two rules look only at products
 * that have a recurring price. Plans that are not on the page are not matched.
 */
export function matchPlans(
  plans: readonly PagePlan[],
  stripe: readonly StripeProduct[],
): PlanMatchResult {
  const byPrice = new Map<string, { price: StripePrice; product: StripeProduct }>();
  const byMeta: Index<StripeProduct> = new Map();
  const byName: Index<StripeProduct> = new Map();
  for (const product of stripe) {
    for (const price of product.prices) byPrice.set(price.id, { price, product });
    if (!product.prices.some((p) => p.recurring !== undefined)) continue;
    add(byMeta, (product.metadata[PLAN_METADATA_KEY] ?? "").trim(), product);
    add(byName, normaliseName(product.name), product);
  }
  const claimed = new Set<string>();
  const matches: PlanMatch[] = [];
  for (const plan of plans) {
    if (plan.state !== "found") continue;
    const match: PlanMatch = { plan };
    matches.push(match);

    const saved = plan.priceId === undefined ? undefined : byPrice.get(plan.priceId);
    if (saved !== undefined) {
      if (claimed.has(saved.price.id))
        match.why = `its price (${saved.price.id}) is already the price of another plan`;
      else {
        claimed.add(saved.price.id);
        Object.assign(match, { tier: "saved-id", ...saved });
      }
      continue;
    }
    for (const [tier, key, index] of [
      ["metadata-id", plan.id, byMeta],
      ["name", normaliseName(plan.name), byName],
    ] as const) {
      const product = index.get(key)?.[0];
      if (product === undefined) continue;
      const price = pick(product, plan, claimed);
      if (price === undefined)
        match.why = `every recurring price of the Stripe product ${product.id} belongs to another plan`;
      else {
        claimed.add(price.id);
        Object.assign(match, { tier, product, price });
      }
      break;
    }
  }
  return { matches, claimed };
}
