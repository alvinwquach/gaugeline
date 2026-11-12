/** Billing rules as plain functions: what an event does to a subscription, and what a plan allows. */
import { describe, expect, it } from "vitest";
import { BILLING, planById, showPrice, shown } from "../../lib/billing/config.js";
import { applyEvent, checkAddSite, entitlement } from "../../lib/billing/state.js";
import { at, created, event, sub, T0, TEST_CONFIG } from "./billing-fixtures.js";

const apply = (prev: ReturnType<typeof sub> | null, ev: Parameters<typeof applyEvent>[1]) =>
  applyEvent(prev, ev, TEST_CONFIG);

describe("config: the owner's gaps stay gaps", () => {
  it("no plan in the committed config has a made-up price, limit or name", () => {
    expect(BILLING.plans.length).toBeGreaterThan(0);
    for (const p of BILLING.plans) {
      expect(p.price).toEqual({ month: null, year: null });
      expect([p.currency, p.sites, p.clientViewers, p.runFrequency]).toEqual([
        null,
        null,
        null,
        null,
      ]);
      expect(p.name).toMatch(/to be set/i);
      expect(showPrice(p, "month")).toBe("To be set");
    }
    expect([
      BILLING.trialDays,
      BILLING.graceDays,
      BILLING.taxDisplay,
      BILLING.pricingPageAddress,
    ]).toEqual([null, null, null, null]);
  });
  it("a price shows only when the amount and the currency are both known, in whole minor units", () => {
    const p = { ...TEST_CONFIG.plans[0]!, price: { month: 1205, year: null }, currency: "TST" };
    expect(showPrice(p, "month")).toBe("12.05 TST");
    expect(showPrice(p, "year")).toBe("To be set");
    expect(showPrice({ ...p, currency: null }, "month")).toBe("To be set");
    expect(shown(null)).toBe("To be set");
    expect(planById(TEST_CONFIG, "large")?.sites).toBe(5);
    expect(planById(TEST_CONFIG, "nope")).toBeUndefined();
  });
});

describe("applyEvent", () => {
  it("a created subscription becomes the team's plan", () => {
    const r = apply(null, created());
    expect(r.outcome).toBe("applied");
    expect(r.next).toMatchObject({ planId: "small", status: "active", graceEndsAt: null });
    expect(r.effects).toEqual([]);
  });

  it("an update changes the plan; a cancellation ends it", () => {
    const first = apply(null, created()).next!;
    const up = apply(first, {
      ...created({ createdAt: at(5) }),
      type: "subscription.updated",
      subscription: { ...created().subscription, planId: "large", interval: "year" },
    });
    expect(up.next).toMatchObject({ planId: "large", interval: "year" });
    const gone = apply(up.next, event("subscription.canceled", { createdAt: at(10) }));
    expect(gone.next?.status).toBe("canceled");
  });

  it("a failed payment starts the grace period and asks for one notice; a second failure changes neither", () => {
    const first = apply(sub(), event("payment.failed", { createdAt: at(1) }));
    expect(first.next).toMatchObject({ status: "past_due", graceEndsAt: at(1 + 7 * 24 * 60) });
    expect(first.effects).toEqual([
      { kind: "payment_failed_notice", orgId: sub().orgId, graceEndsAt: at(1 + 7 * 24 * 60) },
    ]);
    const again = apply(first.next, event("payment.failed", { createdAt: at(60 * 24) }));
    expect(again.next?.graceEndsAt).toEqual(first.next?.graceEndsAt);
    expect(again.effects).toEqual([]);
  });

  it("a payment that goes through ends the grace period", () => {
    const failed = apply(sub(), event("payment.failed", { createdAt: at(1) })).next!;
    const ok = apply(failed, event("payment.succeeded", { createdAt: at(2) }));
    expect(ok.next).toMatchObject({ status: "active", graceEndsAt: null });
  });

  it("with no grace days decided, a failure is recorded and nothing is ever paused", () => {
    const r = applyEvent(sub(), event("payment.failed", { createdAt: at(1) }), {
      ...TEST_CONFIG,
      graceDays: null,
    });
    expect(r.next).toMatchObject({ status: "past_due", graceEndsAt: null });
    expect(entitlement(r.next, at(60 * 24 * 400))).toBe("grace");
  });

  it("an event older than the one applied is stale and changes nothing", () => {
    const r = apply(sub({ lastEventAt: at(10) }), event("payment.failed", { createdAt: at(5) }));
    expect(r.outcome).toBe("stale");
    expect(r.next).toBeNull();
  });

  it("events about another subscription of the same team (an old one, cancelled late) are stale", () => {
    const r = apply(
      sub(),
      event("subscription.canceled", { subscriptionId: "sub_old", createdAt: at(5) }),
    );
    expect(r.outcome).toBe("stale");
  });

  it("a payment event before any subscription is known must be retried, not dropped", () => {
    expect(apply(null, event("payment.failed")).outcome).toBe("needs_subscription");
    expect(apply(null, event("payment.succeeded")).outcome).toBe("needs_subscription");
    expect(apply(null, event("subscription.canceled")).outcome).toBe("needs_subscription");
  });

  it("a payment event on a cancelled subscription changes nothing", () => {
    const r = apply(sub({ status: "canceled" }), event("payment.failed", { createdAt: at(5) }));
    expect(r.outcome).toBe("stale");
  });

  it("subscribing again after cancelling replaces the row with the new subscription", () => {
    const r = apply(
      sub({ status: "canceled", subscriptionId: "sub_old" }),
      created({ createdAt: at(30), subscriptionId: "sub_new" }),
    );
    expect(r.next).toMatchObject({ subscriptionId: "sub_new", status: "active" });
  });
});

describe("entitlement and the limit on adding a site", () => {
  it("no subscription: nothing to enforce yet", () => {
    expect(entitlement(null, T0)).toBe("none");
    expect(checkAddSite(null, 40, TEST_CONFIG, T0)).toEqual({ allowed: true });
  });

  it("adds are allowed up to the plan's limit, then refused with a plain message", () => {
    expect(checkAddSite(sub(), 1, TEST_CONFIG, T0)).toEqual({ allowed: true });
    const full = checkAddSite(sub(), 2, TEST_CONFIG, T0);
    expect(full).toMatchObject({ allowed: false, reason: "limit" });
    expect(full.allowed === false && full.message).toBe(
      "Your plan, Test plan small, includes 2 sites and you have 2. Change your plan under Billing to add more.",
    );
  });

  it("a plan with no limit decided does not limit", () => {
    expect(checkAddSite(sub({ planId: "unset" }), 999, TEST_CONFIG, T0)).toEqual({ allowed: true });
  });

  it("downgrading below the number of sites keeps them and only blocks adding", () => {
    const r = checkAddSite(sub({ planId: "small" }), 4, TEST_CONFIG, T0);
    expect(r).toMatchObject({ allowed: false, reason: "limit" });
    expect(r.allowed === false && r.message).toMatch(/you have 4, more than the 2 it includes/);
    expect(r.allowed === false && r.message).toMatch(/keep being checked/);
  });

  it("a plan the config no longer knows refuses, and says whom to ask", () => {
    expect(checkAddSite(sub({ planId: "retired" }), 0, TEST_CONFIG, T0)).toMatchObject({
      allowed: false,
      reason: "unknown_plan",
    });
  });

  it("in the grace period adds still work; after it they stop; a cancelled plan stops them", () => {
    const pastDue = sub({ status: "past_due", graceEndsAt: at(100) });
    expect(entitlement(pastDue, at(99))).toBe("grace");
    expect(checkAddSite(pastDue, 0, TEST_CONFIG, at(99))).toEqual({ allowed: true });
    expect(entitlement(pastDue, at(100))).toBe("paused");
    expect(checkAddSite(pastDue, 0, TEST_CONFIG, at(100))).toMatchObject({
      allowed: false,
      reason: "paused",
    });
    expect(checkAddSite(sub({ status: "canceled" }), 0, TEST_CONFIG, T0)).toMatchObject({
      allowed: false,
      reason: "ended",
    });
  });
});
