/**
 * Saving billing events and reading what a team has. Every write runs as service_role, from the signed
 * webhook (the owner of an organisation can read its subscription, nobody signed in can write it).
 *
 * One event is one transaction: lock the organisation, look at what is stored, decide with the pure rules in
 * state.ts, then write the ledger row and the subscription together. A crash leaves neither, so the
 * provider's retry finds the event not yet handled. The ledger's primary key (provider, event id) is what
 * makes a repeated delivery change nothing.
 */
import { assertServiceRole, type Tx } from "../api/db.js";
import type { BillingConfig } from "./config.js";
import {
  applyEvent,
  checkAddSite,
  type BillingEvent,
  type Effect,
  type Outcome,
  type SiteCheck,
  type Subscription,
} from "./state.js";

export type RecordOutcome = Outcome | "duplicate" | "unknown_org";

type Row = Record<string, unknown>;
const toDate = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string);

function fromRow(r: Row): Subscription {
  return {
    orgId: r.org_id as string,
    provider: r.provider as string,
    customerId: r.provider_customer_id as string,
    subscriptionId: r.provider_subscription_id as string,
    planId: r.plan_id as string,
    interval: (r.billing_interval as Subscription["interval"]) ?? null,
    status: r.status as Subscription["status"],
    currentPeriodEnd: toDate(r.current_period_end),
    trialEndsAt: toDate(r.trial_ends_at),
    graceEndsAt: toDate(r.grace_ends_at),
    cancelAtPeriodEnd: r.cancel_at_period_end as boolean,
    lastEventAt: new Date(r.last_event_at as string),
  };
}

/** The team's subscription, or null. As a person, only an owner gets a row (the policy); as the server, any. */
export async function getSubscription(tx: Tx, orgId: string): Promise<Subscription | null> {
  const rows = await tx`select * from public.subscriptions where org_id = ${orgId}`;
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Applies one verified event. `effects` are for the caller to carry out after the transaction commits. */
export async function recordEvent(
  tx: Tx,
  ev: BillingEvent,
  config: BillingConfig,
): Promise<{ outcome: RecordOutcome; effects: Effect[] }> {
  await assertServiceRole(tx);
  // One event at a time per organisation, whether or not it has a subscription row yet.
  await tx`select pg_advisory_xact_lock(hashtextextended(${ev.orgId}, 68))`;
  const org = await tx`select 1 from public.organisations where org_id = ${ev.orgId}`;
  if (org.length === 0) return { outcome: "unknown_org", effects: [] };

  const seen = await tx`select 1 from public.billing_events
    where provider = ${ev.provider} and event_id = ${ev.id}`;
  if (seen.length > 0) return { outcome: "duplicate", effects: [] };

  const prev = await getSubscription(tx, ev.orgId);
  const { outcome, next, effects } = applyEvent(prev, ev, config);
  // Not recorded, so the provider's retry is handled once the subscription is known.
  if (outcome === "needs_subscription") return { outcome, effects: [] };

  await tx`insert into public.billing_events (provider, event_id, org_id, type, event_at, outcome)
    values (${ev.provider}, ${ev.id}, ${ev.orgId}, ${ev.type}, ${ev.createdAt}, ${outcome})`;
  if (next) {
    await tx`insert into public.subscriptions (org_id, provider, provider_customer_id, provider_subscription_id,
        plan_id, billing_interval, status, current_period_end, trial_ends_at, grace_ends_at, cancel_at_period_end,
        last_event_at)
      values (${next.orgId}, ${next.provider}, ${next.customerId}, ${next.subscriptionId}, ${next.planId},
        ${next.interval}, ${next.status}, ${next.currentPeriodEnd}, ${next.trialEndsAt}, ${next.graceEndsAt},
        ${next.cancelAtPeriodEnd}, ${next.lastEventAt})
      on conflict (org_id) do update set provider = excluded.provider,
        provider_customer_id = excluded.provider_customer_id,
        provider_subscription_id = excluded.provider_subscription_id, plan_id = excluded.plan_id,
        billing_interval = excluded.billing_interval, status = excluded.status,
        current_period_end = excluded.current_period_end, trial_ends_at = excluded.trial_ends_at,
        grace_ends_at = excluded.grace_ends_at, cancel_at_period_end = excluded.cancel_at_period_end,
        last_event_at = excluded.last_event_at, updated_at = now()`;
  }
  return { outcome, effects };
}

/**
 * May this organisation add a site? Counts its sites and reads its subscription, which only the server may do
 * for any role (an admin adding a site is not an owner, so a person's own reads would see no subscription and
 * let everything through): so this refuses to run as anyone but service_role. The add-site code calls it first
 * and inserts the site only when `allowed` is true.
 */
export async function checkSiteLimit(
  tx: Tx,
  orgId: string,
  config: BillingConfig,
  now: Date,
): Promise<SiteCheck> {
  await assertServiceRole(tx);
  const sub = await getSubscription(tx, orgId);
  const count = (await tx`select count(*)::int as n from public.sites where org_id = ${orgId}`)[0]!
    .n as number;
  return checkAddSite(sub, count, config, now);
}
