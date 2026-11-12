/**
 * Everything about billing that the owner has not decided yet, in this one file. A value of `null` is
 * "to be set": nothing here is a real price, a real limit or a real name. The pages show "To be set", and
 * the code does not enforce what has not been decided (see state.ts). When the owner decides, only this
 * file changes.
 *
 * Money is whole minor units (pence, cents): integers, never floats.
 */

export type Interval = "month" | "year";
export const INTERVALS: readonly Interval[] = ["month", "year"];

/** Marks a value the owner has not given. Written out so a reader sees it is a gap, not a zero. */
export const TO_BE_SET = null;
export type ToBeSet<T> = T | null;

export interface Plan {
  /** Stored in subscriptions.plan_id and sent to the provider; lower case, digits and hyphens. */
  id: string;
  /** What the pages call the plan. A placeholder until the owner names the plans. */
  name: string;
  /** Per interval, in minor units. */
  price: Record<Interval, ToBeSet<number>>;
  currency: ToBeSet<string>;
  /** Sites that can be added. `null`: not decided, so not enforced. */
  sites: ToBeSet<number>;
  /** Client viewers (the read-only role). */
  clientViewers: ToBeSet<number>;
  /** How often the sites are checked, in words ("nightly"). */
  runFrequency: ToBeSet<string>;
}

export interface BillingConfig {
  plans: readonly Plan[];
  /** Days of trial a new subscription starts with. `null`: no trial is offered yet. */
  trialDays: ToBeSet<number>;
  /** Days after a failed payment before anything is paused. `null`: nothing is ever paused on its own. */
  graceDays: ToBeSet<number>;
  /** How prices are shown: "including-tax" or "excluding-tax". `null`: the pages say nothing about tax. */
  taxDisplay: ToBeSet<"including-tax" | "excluding-tax">;
  /** The public address of the pricing page. */
  pricingPageAddress: ToBeSet<string>;
}

const placeholder = (id: string, name: string): Plan => ({
  id,
  name,
  price: { month: TO_BE_SET, year: TO_BE_SET },
  currency: TO_BE_SET,
  sites: TO_BE_SET,
  clientViewers: TO_BE_SET,
  runFrequency: TO_BE_SET,
});

export const BILLING: BillingConfig = {
  // How many plans there are, and what they are called, is the owner's call. Two placeholders.
  plans: [
    placeholder("plan-a", "Plan A (name to be set)"),
    placeholder("plan-b", "Plan B (name to be set)"),
  ],
  trialDays: TO_BE_SET,
  graceDays: TO_BE_SET,
  taxDisplay: TO_BE_SET,
  pricingPageAddress: TO_BE_SET,
};

export const planById = (config: BillingConfig, id: string): Plan | undefined =>
  config.plans.find((p) => p.id === id);

/** "To be set" for a gap, else the value as text. */
export const shown = (value: string | number | null): string =>
  value === null ? "To be set" : String(value);

/** A price as text: "To be set" unless the amount and the currency are both known. */
export function showPrice(plan: Plan, interval: Interval): string {
  const minor = plan.price[interval];
  if (minor === null || plan.currency === null) return "To be set";
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")} ${plan.currency}`;
}
