/**
 * The payment provider as this app sees it, and the local stand-in that plays it. There is no real provider
 * yet: no account, no key, no payment host is ever called. The stand-in keeps customers and subscriptions in
 * memory and "pays" by delivering a signed webhook (the same bytes a real provider would post) through
 * `deliver`, so the app is built and tested against the real inbound path.
 *
 * A card never reaches this app: checkout and the portal are the provider's own pages, so what comes back
 * is a link to follow and, later, ids in a webhook.
 */
import { randomUUID } from "node:crypto";
import type { Interval } from "./config.js";
import { sign, SIGNATURE_HEADER } from "./webhook.js";

export interface PaymentProvider {
  readonly name: string;
  /** Start a checkout for an organisation's plan; the person is sent to `url` to pay. */
  createCheckout(input: {
    orgId: string;
    planId: string;
    interval: Interval;
  }): Promise<{ id: string; url: string }>;
  /** A link to the provider's portal, where the customer changes plan, payment details, or cancels. */
  createPortalSession(input: { customerId: string }): Promise<{ url: string }>;
  cancelSubscription(input: { subscriptionId: string }): Promise<void>;
}

/** A webhook as it would arrive: the exact body and the headers to post it with. */
export interface Delivery {
  body: string;
  headers: Record<string, string>;
}

interface StandInSub {
  id: string;
  customerId: string;
  orgId: string;
  planId: string;
  interval: Interval;
  status: "active" | "past_due" | "canceled";
}

const PERIOD_S = 30 * 86_400;
const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;

export class StandInProvider implements PaymentProvider {
  readonly name = "stand-in";
  private readonly checkouts = new Map<
    string,
    { orgId: string; planId: string; interval: Interval }
  >();
  private readonly subs = new Map<string, StandInSub>();
  private readonly customers = new Map<string, string>();

  constructor(
    private readonly opts: {
      secret: string;
      now: () => Date;
      /** Where deliveries go: the webhook handler in tests and development. */
      deliver: (d: Delivery) => Promise<unknown>;
    },
  ) {}

  async createCheckout(input: { orgId: string; planId: string; interval: Interval }) {
    const id = newId("sa_cs");
    this.checkouts.set(id, input);
    return { id, url: `/billing/stand-in/checkout/${id}` };
  }

  async createPortalSession(input: { customerId: string }) {
    return { url: `/billing/stand-in/portal/${input.customerId}` };
  }

  async cancelSubscription(input: { subscriptionId: string }): Promise<void> {
    const s = this.need(input.subscriptionId);
    s.status = "canceled";
    await this.send("subscription.canceled", s);
  }

  /** The person "paid": the subscription exists and the webhook says so. Returns its id. */
  async completeCheckout(checkoutId: string): Promise<string> {
    const c = this.checkouts.get(checkoutId);
    if (!c) throw new Error("no such checkout");
    this.checkouts.delete(checkoutId);
    const customerId = this.customers.get(c.orgId) ?? newId("sa_cus");
    this.customers.set(c.orgId, customerId);
    const s: StandInSub = { id: newId("sa_sub"), customerId, ...c, status: "active" };
    this.subs.set(s.id, s);
    await this.send("subscription.created", s);
    return s.id;
  }

  /** The portal's "change plan". */
  async changePlan(subscriptionId: string, planId: string, interval: Interval): Promise<void> {
    const s = this.need(subscriptionId);
    Object.assign(s, { planId, interval });
    await this.send("subscription.updated", s);
  }

  async failPayment(subscriptionId: string): Promise<void> {
    const s = this.need(subscriptionId);
    s.status = "past_due";
    await this.send("payment.failed", s);
  }

  async succeedPayment(subscriptionId: string): Promise<void> {
    const s = this.need(subscriptionId);
    s.status = "active";
    await this.send("payment.succeeded", s);
  }

  private need(id: string): StandInSub {
    const s = this.subs.get(id);
    if (!s) throw new Error("no such subscription");
    return s;
  }

  /** Builds the signed delivery for an event and sends it; returns it so a test can send it again. */
  private async send(type: string, s: StandInSub): Promise<Delivery> {
    const now = Math.floor(this.opts.now().getTime() / 1000);
    const subscription =
      type === "subscription.created" || type === "subscription.updated"
        ? {
            plan_id: s.planId,
            interval: s.interval,
            status: s.status,
            current_period_end: now + PERIOD_S,
            trial_end: null,
            cancel_at_period_end: false,
          }
        : undefined;
    const body = JSON.stringify({
      id: newId("sa_evt"),
      type,
      created: now,
      org_id: s.orgId,
      customer_id: s.customerId,
      subscription_id: s.id,
      ...(subscription ? { subscription } : {}),
    });
    const delivery: Delivery = {
      body,
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: sign(this.opts.secret, new TextEncoder().encode(body), now),
      },
    };
    this.last = delivery;
    await this.opts.deliver(delivery);
    return delivery;
  }

  /** The newest delivery sent, for a test that wants to send the same one again. */
  last: Delivery | undefined;
}
