import type { Reconciled } from "../delivery/reconcile.js";
import { STALE_AFTER_SECONDS, formatAge, type WebhookEndpointState } from "../delivery/webhooks.js";
import { CheckRegistry, defineCheck, type Check, type Finding } from "../model.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/** What `delivery-receipt-missing` reads: the counts, and the window they cover. */
export interface ReceiptInput {
  reconciled: Reconciled;
  /** "the last 7 days", "since 2026-11-01". */
  window: string;
  /** The UTC days the counts cover, first and last. */
  comparedFrom: string;
  comparedTo: string;
}

/** What the webhook checks read: one state per endpoint. */
export interface WebhookInput {
  endpoints: readonly WebhookEndpointState[];
}

const MAX_DAYS_LISTED = 10;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function daysAbove(r: Reconciled): string {
  const days = r.byDay.filter((d) => d.paid > d.sent);
  if (days.length === 0) return "";
  const shown = days
    .slice(0, MAX_DAYS_LISTED)
    .map((d) => `${d.day} (${d.paid} paid, ${d.sent} sent)`)
    .join(", ");
  const more = days.length > MAX_DAYS_LISTED ? `, and ${days.length - MAX_DAYS_LISTED} more` : "";
  return ` Paid is above sent on ${shown}${more}.`;
}

export const deliveryReceiptMissing = defineCheck<ReceiptInput>({
  id: "delivery-receipt-missing",
  size: "M",
  done: "Every paid order in the window has a receipt sent, and the missing ones are sent.",
  estimateChanges:
    "The cause may be the code, the sender setup or the provider, and resending takes care with customers' email.",
  area: "Sales & prices",
  severity: "high",
  title: "Orders were paid and no receipt went out",
  what: "More orders were paid in Stripe than the mail provider has sent emails for, in the same window.",
  why: "A customer who paid and got nothing has no receipt, no download link and no booking confirmation, and does not know whether the payment worked. Your application's log says the send succeeded, because it records the attempt; the mail provider records what it accepted and sent.",
  fix: "Open the mail provider's dashboard on the days listed and find the sends that failed or never happened, then fix the code or the sender setup behind them. Send the missing emails yourself from the provider: Gaugeline never resends.",
  tech: "paid Checkout Sessions (payment_status paid, not refunded in full) and the emails Resend lists as sent (not bounced, failed, cancelled, queued, scheduled or suppressed) in the same window are compared in memory with a Map<string, number> keyed by the SHA-256 of the lower-cased recipient, one count per key (a multiset), dropped when the comparison returns; an order takes one email from its recipient's count, and the orders left over are the finding, so unmatched is never negative and more emails than orders is a pass; matching is by recipient across the window, not by day, so an email sent to a different address than the order's shows as unmatched; the evidence is two counts and UTC days, never an address, a name, an order id or a payload",
  run(input) {
    const r = input.reconciled;
    if (r.unmatched <= 0) return [];
    const finding: Finding = {
      checkId: "delivery-receipt-missing",
      severity: "high",
      title: this.title,
      evidence: `${r.paid} paid, ${r.sent} sent in ${escapeInvisible(input.window, 60)} (${input.comparedFrom} to ${input.comparedTo} UTC): ${plural(r.unmatched, "paid order has", "paid orders have")} no matching email.${daysAbove(r)} Orders and emails are matched by recipient, not by day.`,
      url: "delivery:stripe-resend",
    };
    return [finding];
  },
});

export const webhookFailing = defineCheck<WebhookInput>({
  id: "webhook-failing",
  size: "M",
  done: "The endpoint answers the provider's events with 2xx and the failed events are resent.",
  estimateChanges:
    "The fault may be in the route, the host or the signing secret, and events missed in the meantime have to be replayed.",
  area: "Sales & prices",
  severity: "high",
  title: "A webhook endpoint is not receiving its events",
  what: "An enabled Stripe webhook endpoint has events older than an hour that were never delivered.",
  why: "Stripe tells your site about a payment through a webhook. If the endpoint is down or answering with an error, the payment happened and your site was never told, so no order is recorded, no file is released and no email is sent.",
  fix: "Open the endpoint in the Stripe dashboard, read the failed attempts to see what it answered, fix the route (or the host behind it), then let Stripe retry or resend the events from the dashboard. Gaugeline never replays or retries them.",
  tech: "GET /v1/webhook_endpoints and GET /v1/events with delivery_success=false from the last 30 days; an event counts against an enabled endpoint that takes its type (or *) when it is older than 1 hour and still has pending deliveries, so two endpoints that take the same type are each told about the same event; the evidence is the endpoint's host (never its path, query or secret), the count and the age of the oldest; nothing from an event's payload is read into a result",
  run(input) {
    return input.endpoints.flatMap((e): Finding[] =>
      e.enabled && e.undelivered > 0 && e.oldestAgeSeconds !== null
        ? [
            {
              checkId: "webhook-failing",
              severity: "high",
              title: this.title,
              evidence: `${escapeInvisible(e.host, 120)}: ${plural(e.undelivered, "event", "events")} older than ${formatAge(STALE_AFTER_SECONDS)} not delivered, the oldest ${formatAge(e.oldestAgeSeconds)} old.`,
              url: `stripe:webhook:${escapeInvisible(e.host, 120)}`,
            },
          ]
        : [],
    );
  },
});

export const webhookDisabled = defineCheck<WebhookInput>({
  id: "webhook-disabled",
  size: "S",
  done: "The endpoint is enabled in the Stripe dashboard, or deleted if it is no longer needed.",
  estimateChanges:
    "Stripe disables an endpoint after days of failures, so the failures need reading first.",
  area: "Sales & prices",
  severity: "medium",
  title: "A webhook endpoint is switched off",
  what: "A Stripe webhook endpoint has the status disabled.",
  why: "Stripe sends a disabled endpoint nothing. If your site still depends on it, payments are made and the site is not told.",
  fix: "If the endpoint is still needed, enable it in the Stripe dashboard (Stripe may have disabled it after days of failures, so read its last attempts first). If it is not, delete it so the list says what is live.",
  tech: "GET /v1/webhook_endpoints; an endpoint whose status is disabled is a finding, whatever it takes; the evidence is the endpoint's host only",
  run(input) {
    return input.endpoints.flatMap((e): Finding[] =>
      e.enabled
        ? []
        : [
            {
              checkId: "webhook-disabled",
              severity: "medium",
              title: this.title,
              evidence: `${escapeInvisible(e.host, 120)} is disabled, so Stripe sends it no events.`,
              url: `stripe:webhook:${escapeInvisible(e.host, 120)}`,
            },
          ],
    );
  },
});

/** The check `gaugeline delivery --paid --sent` runs. It reads a ReceiptInput, not a page. */
export const RECEIPT_CHECKS: readonly Check<ReceiptInput>[] = [deliveryReceiptMissing];
/** The checks `gaugeline platform --webhooks` runs. They read a WebhookInput, not a page. */
export const WEBHOOK_CHECKS: readonly Check<WebhookInput>[] = [webhookFailing, webhookDisabled];

export function createReceiptRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of RECEIPT_CHECKS) registry.register(c);
  return registry;
}

export function createWebhookRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of WEBHOOK_CHECKS) registry.register(c);
  return registry;
}
