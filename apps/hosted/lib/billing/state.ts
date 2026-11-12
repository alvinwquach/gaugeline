/**
 * What billing events do to a team's subscription, and what a subscription allows. Plain functions with no
 * database and no clock of their own (the caller passes `now`), so the same input gives the same answer.
 * The provider's own ids are all a subscription holds; there is no field for a card.
 */
import { planById, type BillingConfig, type Interval } from "./config.js";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

export interface Subscription {
  orgId: string;
  provider: string;
  customerId: string;
  subscriptionId: string;
  planId: string;
  interval: Interval | null;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  /** Set by a failed payment: nothing is paused before this time. Null when none, or none decided. */
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  /** The provider's time of the newest event applied. */
  lastEventAt: Date;
}

/** What the provider says a subscription is now: a full snapshot, so applying it twice is the same as once. */
export interface Snapshot {
  planId: string;
  interval: Interval | null;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
}

interface EventBase {
  provider: string;
  /** The provider's event id: the idempotency key. */
  id: string;
  /** The provider's time for the event; orders events that arrive out of order. */
  createdAt: Date;
  orgId: string;
  customerId: string;
  subscriptionId: string;
}

/** An event in this app's own terms. A provider's adapter maps its events onto these and verifies them first. */
export type SnapshotEvent = EventBase & {
  type: "subscription.created" | "subscription.updated";
  subscription: Snapshot;
};
export type SimpleEvent = EventBase & {
  type: "subscription.canceled" | "payment.failed" | "payment.succeeded";
};
export type BillingEvent = SnapshotEvent | SimpleEvent;

/** Something to do once the change is saved (never inside the transaction). */
export type Effect = { kind: "payment_failed_notice"; orgId: string; graceEndsAt: Date | null };

export type Outcome =
  | "applied"
  /** Older than what is stored, or about a subscription that is no longer the team's: changes nothing. */
  | "stale"
  /** About a subscription not seen yet: the provider should send it again later. */
  | "needs_subscription";

const DAY_MS = 86_400_000;

export function applyEvent(
  prev: Subscription | null,
  ev: BillingEvent,
  config: BillingConfig,
): { outcome: Outcome; next: Subscription | null; effects: Effect[] } {
  const none = (outcome: Outcome) => ({ outcome, next: null, effects: [] as Effect[] });
  if (prev && ev.createdAt.getTime() < prev.lastEventAt.getTime()) return none("stale");

  if (ev.type === "subscription.created" || ev.type === "subscription.updated") {
    // A snapshot for the team's current subscription, or for a new one (subscribing again after cancelling).
    // An update for some other subscription while this one is live is not ours to apply.
    if (prev && prev.subscriptionId !== ev.subscriptionId && prev.status !== "canceled")
      return none("stale");
    const s = ev.subscription;
    // Keep the grace period running if the provider still says past_due; end it when it does not.
    const stillLate = s.status === "past_due" && prev?.subscriptionId === ev.subscriptionId;
    return {
      outcome: "applied",
      effects: [],
      next: {
        orgId: ev.orgId,
        provider: ev.provider,
        customerId: ev.customerId,
        subscriptionId: ev.subscriptionId,
        planId: s.planId,
        interval: s.interval,
        status: s.status,
        currentPeriodEnd: s.currentPeriodEnd,
        trialEndsAt: s.trialEndsAt,
        graceEndsAt: stillLate ? prev.graceEndsAt : null,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        lastEventAt: ev.createdAt,
      },
    };
  }

  if (!prev) return none("needs_subscription");
  if (prev.subscriptionId !== ev.subscriptionId || prev.status === "canceled") return none("stale");
  const base = { ...prev, lastEventAt: ev.createdAt };

  if (ev.type === "subscription.canceled")
    return {
      outcome: "applied",
      effects: [],
      next: { ...base, status: "canceled", graceEndsAt: null },
    };

  if (ev.type === "payment.succeeded")
    return {
      outcome: "applied",
      effects: [],
      next: {
        ...base,
        status: prev.status === "past_due" ? "active" : prev.status,
        graceEndsAt: null,
      },
    };

  // payment.failed: the first failure of a run starts the grace period and asks for one notice. Retries
  // of the same payment must not push the end of the grace period further away.
  if (prev.status === "past_due") return { outcome: "applied", effects: [], next: base };
  const graceEndsAt =
    config.graceDays === null ? null : new Date(ev.createdAt.getTime() + config.graceDays * DAY_MS);
  return {
    outcome: "applied",
    effects: [{ kind: "payment_failed_notice", orgId: prev.orgId, graceEndsAt }],
    next: { ...base, status: "past_due", graceEndsAt },
  };
}

export type Entitlement = "none" | "trialing" | "active" | "grace" | "paused" | "ended";

export function entitlement(sub: Subscription | null, now: Date): Entitlement {
  if (!sub) return "none";
  switch (sub.status) {
    case "canceled":
      return "ended";
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return sub.graceEndsAt !== null && now.getTime() >= sub.graceEndsAt.getTime()
        ? "paused"
        : "grace";
  }
}

export type SiteCheck =
  | { allowed: true }
  | { allowed: false; reason: "limit" | "paused" | "ended" | "unknown_plan"; message: string };

const sites = (n: number): string => `${n} site${n === 1 ? "" : "s"}`;

/**
 * May this team add one more site? Only adding is ever refused: a site that exists keeps being checked,
 * so a downgrade, a lapsed payment or a plan with fewer sites never stops a run in the middle of a month.
 * A limit the owner has not set (null) is not enforced, and a team with no subscription is not limited.
 */
export function checkAddSite(
  sub: Subscription | null,
  siteCount: number,
  config: BillingConfig,
  now: Date,
): SiteCheck {
  const state = entitlement(sub, now);
  if (!sub || state === "none") return { allowed: true };
  if (state === "ended")
    return {
      allowed: false,
      reason: "ended",
      message: "Your subscription has ended. Choose a plan under Billing to add sites.",
    };
  if (state === "paused")
    return {
      allowed: false,
      reason: "paused",
      message:
        "A payment failed and the grace period has ended. Update your payment details under Billing to add sites.",
    };
  const plan = planById(config, sub.planId);
  if (!plan)
    return {
      allowed: false,
      reason: "unknown_plan",
      message: "We do not recognise your plan. Please contact us, and no site has been added.",
    };
  if (plan.sites === null || siteCount < plan.sites) return { allowed: true };
  const has = `Your plan, ${plan.name}, includes ${sites(plan.sites)}`;
  return {
    allowed: false,
    reason: "limit",
    message:
      siteCount === plan.sites
        ? `${has} and you have ${siteCount}. Change your plan under Billing to add more.`
        : `${has}, and you have ${siteCount}, more than the ${plan.sites} it includes. Your sites keep being checked; change your plan under Billing to add more.`,
  };
}
