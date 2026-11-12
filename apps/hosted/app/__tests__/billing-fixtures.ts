/** Invented plans and events for the billing tests (rule 12). The numbers belong to the tests, not to the product. */
import type { BillingConfig, Plan } from "../../lib/billing/config.js";
import type { SimpleEvent, SnapshotEvent, Subscription } from "../../lib/billing/state.js";

const plan = (id: string, sites: number | null): Plan => ({
  id,
  name: `Test plan ${id}`,
  price: { month: null, year: null },
  currency: null,
  sites,
  clientViewers: null,
  runFrequency: null,
});

/** Two tiny plans so a limit is easy to reach, and one with no limit decided. */
export const TEST_CONFIG: BillingConfig = {
  plans: [plan("small", 2), plan("large", 5), plan("unset", null)],
  trialDays: 14,
  graceDays: 7,
  taxDisplay: null,
  pricingPageAddress: null,
};

export const ORG = "0a000000-0000-4000-8000-00000000000a";
export const T0 = new Date("2026-11-12T09:00:00Z");
export const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

let counter = 0;
export function created(over: Partial<SnapshotEvent> = {}): SnapshotEvent {
  return {
    provider: "stand-in",
    id: `evt_${++counter}`,
    type: "subscription.created",
    createdAt: T0,
    orgId: ORG,
    customerId: "cus_northgate",
    subscriptionId: "sub_northgate",
    subscription: {
      planId: "small",
      interval: "month",
      status: "active",
      currentPeriodEnd: at(60 * 24 * 30),
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
    },
    ...over,
  };
}

export function event(type: SimpleEvent["type"], over: Partial<SimpleEvent> = {}): SimpleEvent {
  return {
    provider: "stand-in",
    id: `evt_${++counter}`,
    type,
    createdAt: T0,
    orgId: ORG,
    customerId: "cus_northgate",
    subscriptionId: "sub_northgate",
    ...over,
  };
}

export function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    orgId: ORG,
    provider: "stand-in",
    customerId: "cus_northgate",
    subscriptionId: "sub_northgate",
    planId: "small",
    interval: "month",
    status: "active",
    currentPeriodEnd: at(60 * 24 * 30),
    trialEndsAt: null,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    lastEventAt: T0,
    ...over,
  };
}
