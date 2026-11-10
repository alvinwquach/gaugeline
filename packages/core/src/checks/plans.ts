import type { StripePrice, StripeProduct } from "../connectors/stripe.js";
import {
  CheckRegistry,
  defineCheck,
  type Check,
  type CheckContext,
  type Finding,
} from "../model.js";
import { formatMoney } from "../products/money.js";
import { describeCadence, sameCadence, trialAgrees } from "../plans/phrases.js";
import {
  amountsOf,
  cadenceOf,
  matchPlans,
  pageMinor,
  type PlanMatch,
  type PlanTier,
} from "../plans/match.js";
import type { PagePlan } from "../plans/read.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * What the subscription checks read: the plans as the page shows them (`readPagePlans`), the
 * Stripe products with their prices (the Stripe connector), and the ids of the Stripe products that
 * are plans (`products` in gaugeline.plans.json), so a price nobody put on the page can be found.
 */
export interface SubscriptionCheckInput {
  plans: readonly PagePlan[];
  stripe: readonly StripeProduct[];
  products?: readonly string[];
}

export const SUBSCRIPTION_CHECK_IDS = [
  "plan-archived",
  "plan-interval-mismatch",
  "plan-missing-on-page",
  "plan-price-mismatch",
  "plan-trial-mismatch",
] as const;
export type SubscriptionCheckId = (typeof SUBSCRIPTION_CHECK_IDS)[number];

const TITLES: Readonly<Record<SubscriptionCheckId, string>> = {
  "plan-archived": "The page sells a plan that is archived in checkout",
  "plan-interval-mismatch": "A plan bills on a different schedule than the page says",
  "plan-missing-on-page": "A subscription price in checkout has no plan on the page",
  "plan-price-mismatch": "A plan's price on the page differs from checkout",
  "plan-trial-mismatch": "A plan's free trial differs from checkout",
};

const HOW: Readonly<Record<PlanTier, string>> = {
  "saved-id": "configured price id",
  "metadata-id": "product metadata",
  name: "name",
};

// ---- words --------------------------------------------------------------------------------------

/** Text from a page or a system, for one line of evidence: escaped and cut. */
const safe = (text: string, max = 60): string => escapeInvisible(text, max);

const matchedBy = (m: PlanMatch): string =>
  m.tier === undefined ? "" : ` (matched by ${HOW[m.tier]})`;

/** What the page says about a plan, as short words: "$49 per month, 7-day trial". */
function pageSays(p: PagePlan): string {
  const parts = [
    p.amount === null ? "" : safe(p.amount.shown),
    p.cadence === null ? "" : describeCadence(p.cadence),
    p.trial === null
      ? ""
      : `a ${p.trial.min === p.trial.max ? `${p.trial.min}-day` : "free"} trial`,
  ].filter((s) => s !== "");
  return parts.length === 0 ? "nothing about its price" : parts.join(", ");
}

/** What a price says: "52.00 USD every month". */
function stripeSays(price: StripePrice): string {
  const amount =
    price.unitAmount === null
      ? "no fixed amount"
      : formatMoney({ amount: price.unitAmount, currency: price.currency.toLowerCase() });
  const every =
    price.recurring === undefined ? "once" : describeCadence(cadenceOf(price.recurring));
  return `${amount} ${every}`;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

// ---- one pass -----------------------------------------------------------------------------------

interface Notice {
  url: string;
  reason: string;
}

interface Analysis {
  archived: Finding[];
  interval: Finding[];
  intervalNotices: Notice[];
  missing: Finding[];
  missingNotices: Notice[];
  price: Finding[];
  priceNotices: Notice[];
  trial: Finding[];
}

function find(
  id: SubscriptionCheckId,
  severity: Finding["severity"],
  url: string,
  evidence: string,
): Finding {
  return { checkId: id, severity, title: TITLES[id], evidence, url };
}

function analyse(input: SubscriptionCheckInput): Analysis {
  const out: Analysis = {
    archived: [],
    interval: [],
    intervalNotices: [],
    missing: [],
    missingNotices: [],
    price: [],
    priceNotices: [],
    trial: [],
  };
  const { matches, claimed } = matchPlans(input.plans, input.stripe);

  for (const plan of input.plans)
    if (plan.state === "missing")
      out.priceNotices.push({
        url: plan.url,
        reason: `"${safe(plan.name)}" was not found on the page, so it was not compared with Stripe.`,
      });

  for (const m of matches) {
    const { plan, price } = m;
    const url = plan.url;
    const name = safe(plan.name);
    if (price === undefined) {
      out.priceNotices.push({
        url,
        reason: `"${name}" has no Stripe price to compare with: ${m.why ?? "no configured price id, no product with a matching gaugelinePlan metadata entry and no product with its name was found"}.`,
      });
      continue;
    }

    if (!price.active) {
      out.archived.push(
        find(
          "plan-archived",
          "high",
          url,
          `"${name}" is sold on the page (${pageSays(plan)}), but Stripe's price ${safe(price.id)} (${stripeSays(price)}) is archived, so checkout cannot charge it${matchedBy(m)}.`,
        ),
      );
      continue; // One cause: the other comparisons would only repeat it.
    }

    // The price: the amount, and what the page says about tax.
    if (plan.promo)
      out.priceNotices.push({
        url,
        reason: `"${name}" shows an introductory price, coupon or discount next to the plan, so its price was not compared. Set introAmount for the plan in gaugeline.plans.json to name the introductory amount.`,
      });
    else if (plan.amount === null)
      out.priceNotices.push({
        url,
        reason: `"${name}" shows no price with a currency next to its name, so its price was not compared.`,
      });
    else if (price.unitAmount === null)
      out.priceNotices.push({
        url,
        reason: `"${name}": Stripe's price ${safe(price.id)} has no fixed amount (tiered or custom pricing), so it was not compared.`,
      });
    else {
      const options = amountsOf(price);
      const currency = plan.amount.currencies.find((c) => options.has(c));
      const stripeAmount = currency === undefined ? undefined : options.get(currency);
      const shown = pageMinor(plan, currency ?? price.currency.toLowerCase());
      if (currency === undefined || stripeAmount === undefined)
        out.priceNotices.push({
          url,
          reason: `"${name}" shows ${safe(plan.amount.shown)} and Stripe's price ${safe(price.id)} is in ${[...options.keys()].map((c) => c.toUpperCase()).join(" and ")}, so the amounts were not compared. Gaugeline never converts between currencies.`,
        });
      else if (shown === null)
        out.priceNotices.push({
          url,
          reason: `"${name}" shows ${safe(plan.amount.shown)}, which is not a whole amount of ${currency.toUpperCase()}, so it was not compared.`,
        });
      else {
        const taxDiffers =
          plan.tax !== null && price.taxBehavior !== undefined && plan.tax !== price.taxBehavior;
        if (shown !== stripeAmount || taxDiffers) {
          const tax = taxDiffers
            ? ` The page says tax is ${plan.tax === "inclusive" ? "included" : "extra"} and Stripe's price is tax ${price.taxBehavior}.`
            : "";
          out.price.push(
            find(
              "plan-price-mismatch",
              "high",
              url,
              `"${name}": the page shows ${safe(plan.amount.shown)}${plan.cadence === null ? "" : ` ${describeCadence(plan.cadence)}`} and Stripe's price ${safe(price.id)} charges ${formatMoney({ amount: stripeAmount, currency })}${shown === stripeAmount ? ", the same amount" : ""}${matchedBy(m)}.${tax}`,
            ),
          );
        }
      }
    }

    // How often it bills.
    if (plan.cadence === null)
      out.intervalNotices.push({
        url,
        reason: `"${name}" ${plan.cadenceUnclear ? "names two different billing intervals" : "does not say how often it bills"}, so its interval was not compared.`,
      });
    else if (price.recurring === undefined)
      out.interval.push(
        find(
          "plan-interval-mismatch",
          "high",
          url,
          `"${name}": the page says ${describeCadence(plan.cadence)}, but Stripe's price ${safe(price.id)} is a one-time price, not a subscription${matchedBy(m)}.`,
        ),
      );
    else if (!sameCadence(plan.cadence, cadenceOf(price.recurring)))
      out.interval.push(
        find(
          "plan-interval-mismatch",
          "high",
          url,
          `"${name}": the page says ${describeCadence(plan.cadence)} and Stripe's price ${safe(price.id)} bills ${describeCadence(cadenceOf(price.recurring))}${matchedBy(m)}.`,
        ),
      );

    // The trial. Only a subscription price has one.
    if (price.recurring !== undefined) {
      const days = price.recurring.trialPeriodDays ?? 0;
      if (plan.trial !== null && !trialAgrees(plan.trial, days))
        out.trial.push(
          find(
            "plan-trial-mismatch",
            "medium",
            url,
            `"${name}": the page promises a ${plan.trial.min === plan.trial.max ? `${plan.trial.min}-day` : "free"} trial and Stripe's price ${safe(price.id)} ${days === 0 ? "has no trial" : `has a ${days}-day trial`}${matchedBy(m)}.`,
          ),
        );
      else if (plan.trial === null && days > 0)
        out.trial.push(
          find(
            "plan-trial-mismatch",
            "medium",
            url,
            `"${name}": Stripe's price ${safe(price.id)} gives a ${days}-day trial and the page does not mention one${matchedBy(m)}.`,
          ),
        );
    }
  }

  // Plans nobody put on the page: active recurring prices of the configured products.
  const byId = new Map(input.stripe.map((p) => [p.id, p]));
  for (const id of input.products ?? []) {
    const product = byId.get(id);
    if (product === undefined) {
      out.missingNotices.push({
        url: `stripe:${id}`,
        reason: `The Stripe product ${safe(id)} named in gaugeline.plans.json was not in the products that were read.`,
      });
      continue;
    }
    if (!product.active) continue;
    const loose = product.prices.filter(
      (p) => p.active && p.recurring !== undefined && !claimed.has(p.id),
    );
    if (loose.length === 0) continue;
    out.missing.push(
      find(
        "plan-missing-on-page",
        "low",
        `stripe:${product.id}`,
        `Stripe product "${safe(product.name)}" (${safe(product.id)}) has ${plural(loose.length, "active subscription price")} that no plan on the page stands for: ${loose
          .slice(0, 3)
          .map((p) => `${safe(p.id)} (${stripeSays(p)})`)
          .join(", ")}${loose.length > 3 ? ` and ${loose.length - 3} more` : ""}.`,
      ),
    );
  }
  return out;
}

/** The five checks share one pass over the plans, done once per input. */
const cache = new WeakMap<SubscriptionCheckInput, Analysis>();

function analysis(input: SubscriptionCheckInput): Analysis {
  let a = cache.get(input);
  if (a === undefined) {
    a = analyse(input);
    cache.set(input, a);
  }
  return a;
}

function notify(ctx: CheckContext, notices: readonly Notice[]): void {
  for (const n of notices) ctx.couldNotCheck?.(n.url, n.reason);
}

// ---- the checks ---------------------------------------------------------------------------------

export const planArchived = defineCheck<SubscriptionCheckInput>({
  id: "plan-archived",
  area: "Sales & prices",
  severity: "high",
  title: TITLES["plan-archived"],
  what: "A plan on your page is paired with a Stripe price that has been archived.",
  why: "Visitors can pick the plan, but the price behind it can no longer be used to start a subscription: checkout fails, or an old link keeps charging a price you retired.",
  fix: "Point the page at the plan's current Stripe price, or restore the price in Stripe if it should still be sold. Take the plan off the page if it is gone.",
  tech: "a plan found on its configured page whose matched Stripe price has active false, matched by the configured price id, then the product's gaugelinePlan metadata, then the product name, as the product matcher does; the plan's other comparisons are skipped, since the archived price is the one cause",
  run(input) {
    return analysis(input).archived;
  },
});

export const planIntervalMismatch = defineCheck<SubscriptionCheckInput>({
  id: "plan-interval-mismatch",
  area: "Sales & prices",
  severity: "high",
  title: TITLES["plan-interval-mismatch"],
  what: "The page says a plan bills one way (per month, say) and the matched Stripe price bills another (yearly, or every 3 months), or is not a subscription price at all.",
  why: "A customer who expects 49 a month is charged 588 up front, or the other way round. It is the commonest cause of subscription refunds and chargebacks.",
  fix: "Change the page's wording or pick the Stripe price that bills on the schedule the page promises. Create the missing price in Stripe if there is none.",
  tech: "the billing interval written next to the plan's name (per month, /mo, monthly, every 3 months, al mes, mensual, cada 3 meses, and the weekly, yearly and daily forms) against recurring.interval and recurring.interval_count of the matched price; 12 months equals a year and 7 days a week; a card that names two different intervals, or none, is skipped with a notice, not guessed",
  run(input, ctx) {
    const a = analysis(input);
    notify(ctx, a.intervalNotices);
    return a.interval;
  },
});

export const planMissingOnPage = defineCheck<SubscriptionCheckInput>({
  id: "plan-missing-on-page",
  area: "Sales & prices",
  severity: "low",
  title: TITLES["plan-missing-on-page"],
  what: "A Stripe product you listed as a plan has an active subscription price that no plan on the page stands for.",
  why: "A price that is live in Stripe but never shown is either a plan you forgot to put on the site, or an old price that can still be bought from an old link.",
  fix: "Add the plan to the page, or archive the price in Stripe if it should no longer be sold.",
  tech: "for each Stripe product in gaugeline.plans.json products (active), its prices with active true and a recurring object that no plan on the page was matched to; one finding per product listing up to three prices; a product that is archived, or not among the products that were read, says nothing here",
  run(input, ctx) {
    const a = analysis(input);
    notify(ctx, a.missingNotices);
    return a.missing;
  },
});

export const planPriceMismatch = defineCheck<SubscriptionCheckInput>({
  id: "plan-price-mismatch",
  area: "Sales & prices",
  severity: "high",
  title: TITLES["plan-price-mismatch"],
  what: "The price shown for a plan on your page is different from the Stripe price it is paired with, or the page and Stripe disagree about whether tax is included.",
  why: "Customers see one price and are charged another, which causes abandoned checkouts, complaints and refunds.",
  fix: "Decide which price you mean, then change the other so they agree. If the difference is tax, say on the page whether the price includes it.",
  tech: "the first amount written with a currency next to the plan's name, as a whole number of minor units, against unit_amount of the matched price (or its currency_options entry when the page's currency is one of them); a currency that is not one of the price's is a notice, never converted; a plan showing an introductory price or discount is skipped unless introAmount names it; the page's 'tax included' or 'plus tax' against tax_behavior when both say; the evidence shows both amounts and never says which is right",
  run(input, ctx) {
    const a = analysis(input);
    notify(ctx, a.priceNotices);
    return a.price;
  },
});

export const planTrialMismatch = defineCheck<SubscriptionCheckInput>({
  id: "plan-trial-mismatch",
  area: "Sales & prices",
  severity: "medium",
  title: TITLES["plan-trial-mismatch"],
  what: "The page promises a free trial that the matched Stripe price does not give, or Stripe gives a trial the page never mentions.",
  why: "Someone who signs up for a free trial and is charged today, or who is surprised by a trial that hides when the first bill comes, files a dispute.",
  fix: "Make the page and the Stripe price agree on the trial's length, or take the promise off the page.",
  tech: "a trial of N days, weeks or months written next to the plan's name (7-day free trial, prueba gratis de 7 dias) against recurring.trial_period_days of the matched price (a month is 28 to 31 days); a trial set when checkout is created (subscription_data) is not visible on the price, so confirm there before changing the page",
  run(input) {
    return analysis(input).trial;
  },
});

/** The five subscription checks, in id order. They read a SubscriptionCheckInput, not a page. */
export const SUBSCRIPTION_CHECKS: readonly Check<SubscriptionCheckInput>[] = [
  planArchived,
  planIntervalMismatch,
  planMissingOnPage,
  planPriceMismatch,
  planTrialMismatch,
];

export function createSubscriptionRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of SUBSCRIPTION_CHECKS) registry.register(c);
  return registry;
}
