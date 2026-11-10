import { createReceiptRegistry, createWebhookRegistry } from "../checks/delivery.js";
import { RESEND_API_KEY, createResendSentConnector } from "../connectors/resend-sent.js";
import { missingVars } from "../connectors/env.js";
import { runConnectors } from "../connectors/run.js";
import { STRIPE_API_KEY } from "../connectors/stripe.js";
import { createStripeOrdersConnector } from "../connectors/stripe-orders.js";
import { createStripeWebhooksConnector } from "../connectors/stripe-webhooks.js";
import type { Connector, ConnectorNotice, Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { buildResult, type Result } from "../result.js";
import { runChecks } from "../run.js";
import { reconcile, type PaidOrder, type Reconciled, type SentEmail } from "./reconcile.js";
import { STRIPE_EVENT_RETENTION_DAYS, type WebhookEndpointState } from "./webhooks.js";
import { parseWindow, type Window } from "./window.js";

export interface DeliveryOptions {
  /** --paid: read the paid orders. */
  paid: boolean;
  /** --sent: read the sent emails. */
  sent: boolean;
  /** --since: 7d, 24h or a date. Defaults to 7d. */
  since?: string;
  env: Env;
  fetcher: Fetcher;
  now: Date;
  allowSecretKey?: boolean;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests: how many days Resend is taken to keep. */
  retentionDays?: number;
  /** Tests: pages read at most, per provider. */
  maxPages?: number;
}

export interface DeliveryRun {
  /** The window that was asked for. */
  window: Window;
  /** UTC days compared, first and last: the window, cut to what both providers could be read for. */
  comparedFrom: string;
  comparedTo: string;
  /** Orders paid in the compared window, when --paid was given. */
  paid?: number;
  /** Emails sent in the compared window, when --sent was given. */
  sent?: number;
  /** Only with both flags. */
  reconciled?: Reconciled;
  /** Plain-language lines for stderr: a key worth swapping, a page cap, a window cut short. Never a key. */
  notices: string[];
  result: Result;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * A requested connector that gave no data stops the run (exit 2) with every reason, redacted. Advice
 * notices are not failures: they travel with the run.
 */
function failures(notices: readonly ConnectorNotice[]): string | undefined {
  const bad = notices.filter((n) => n.kind !== "advice");
  return bad.length === 0 ? undefined : bad.map((n) => n.message).join(" ");
}

/** Before any request: every variable the chosen sides need, named. */
function requireVariables(env: Env, names: readonly string[], command: string, hint: string): void {
  const missing = missingVars(env, names);
  if (missing.length > 0)
    throw new ConfigError(
      `${command} needs ${names.join(" and ")} in the environment. Not set: ${missing.join(", ")}.`,
      { hint },
    );
}

/**
 * `gaugeline delivery --paid --sent`: count the orders paid in a window, count the emails the mail
 * provider sent in it, and say whether every paid order has an email. Read only; the numbers and the
 * UTC days are all that is kept, printed or put in the result. Either side alone gives that side's
 * count. A missing or refused key, or an unreadable provider, is a ConfigError (exit 2).
 */
export async function runDelivery(options: DeliveryOptions): Promise<DeliveryRun> {
  const { env, now } = options;
  if (!options.paid && !options.sent)
    throw new ConfigError("gaugeline delivery needs --paid, --sent or both.", {
      hint: "For example: gaugeline delivery --paid --sent --since 7d.",
    });
  const window = parseWindow(options.since, now);
  const command = `gaugeline delivery ${[options.paid ? "--paid" : "", options.sent ? "--sent" : ""].filter(Boolean).join(" ")}`;
  requireVariables(
    env,
    [...(options.paid ? [STRIPE_API_KEY] : []), ...(options.sent ? [RESEND_API_KEY] : [])],
    command,
    "Keys are read from the environment only and never printed. The steps are in docs/delivery.",
  );

  const readable: { paid?: Date; sent?: Date } = {};
  const connectors: Connector<unknown>[] = [];
  if (options.paid)
    connectors.push(
      createStripeOrdersConnector({
        window,
        ...(options.allowSecretKey ? { allowSecretKey: true } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.maxPages ? { maxPages: options.maxPages } : {}),
        onReadable: (d) => (readable.paid = d),
      }) as Connector<unknown>,
    );
  if (options.sent)
    connectors.push(
      createResendSentConnector({
        window,
        now,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.retentionDays ? { retentionDays: options.retentionDays } : {}),
        ...(options.maxPages ? { maxPages: options.maxPages } : {}),
        onReadable: (d) => (readable.sent = d),
      }) as Connector<unknown>,
    );
  const read = await runConnectors(connectors, env, options.fetcher);
  const stopped = failures(read.notices);
  if (stopped !== undefined)
    throw new ConfigError(stopped, { hint: "The steps are in docs/delivery." });
  const notices = read.notices.map((n) => n.message);

  // Compare only what both sides could be read for: an order older than the emails Resend still
  // holds would otherwise look like a receipt that never went out.
  const starts = [window.from.getTime(), readable.paid?.getTime(), readable.sent?.getTime()].filter(
    (t): t is number => t !== undefined,
  );
  const from = new Date(Math.max(...starts));
  const inside = <T extends { at: number }>(rows: readonly T[]): T[] =>
    rows.filter((r) => r.at >= from.getTime());
  const orders = options.paid ? inside((read.data.get("stripe-orders") ?? []) as PaidOrder[]) : [];
  const emails = options.sent ? inside((read.data.get("resend-sent") ?? []) as SentEmail[]) : [];
  if (from.getTime() > window.from.getTime())
    notices.push(
      `Only ${day(from)} to ${day(now)} could be read on every side asked for, so that is the window compared; you asked for ${window.label}.`,
    );

  const both = options.paid && options.sent;
  const reconciled = both ? reconcile(orders, emails) : undefined;
  const input = {
    reconciled: reconciled ?? { paid: 0, sent: 0, unmatched: 0, byDay: [] },
    window: window.label,
    comparedFrom: day(from),
    comparedTo: day(now),
  };
  const checked = both
    ? await runChecks(input, createReceiptRegistry())
    : {
        findings: [],
        passed: [],
        failed: [] as { id: string; error: string }[],
        couldNotCheck: [],
      };
  const cap = (options.maxPages ?? 50) * 100;
  const sampled: Result["sampled"] = {
    ...(options.paid
      ? { "paid-orders": { seen: orders.length, taken: orders.length, limit: cap } }
      : {}),
    ...(options.sent
      ? { "sent-emails": { seen: emails.length, taken: emails.length, limit: cap } }
      : {}),
  };
  return {
    window,
    comparedFrom: day(from),
    comparedTo: day(now),
    ...(options.paid ? { paid: orders.length } : {}),
    ...(options.sent ? { sent: emails.length } : {}),
    ...(reconciled ? { reconciled } : {}),
    notices,
    result: buildResult({
      url: "delivery",
      startedAt: now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
      sampled,
    }),
  };
}

export interface WebhooksOptions {
  env: Env;
  fetcher: Fetcher;
  now: Date;
  allowSecretKey?: boolean;
  sleep?: (ms: number) => Promise<void>;
  maxPages?: number;
}

export interface WebhooksRun {
  endpoints: WebhookEndpointState[];
  /** The first day of events that were read, UTC. */
  eventsFrom: string;
  notices: string[];
  result: Result;
}

/**
 * `gaugeline platform --webhooks`: read the Stripe webhook endpoints and the recent events that
 * still have deliveries pending, and report an enabled endpoint with events older than an hour that
 * were never delivered, and an endpoint that is disabled. Read only; it never replays, retries,
 * resends or enqueues, and prints a host, a count and an age.
 */
export async function runWebhooks(options: WebhooksOptions): Promise<WebhooksRun> {
  const { env, now } = options;
  requireVariables(
    env,
    [STRIPE_API_KEY],
    "gaugeline platform --webhooks",
    "Keys are read from the environment only and never printed. The steps are in docs/delivery.",
  );
  let readFrom = new Date(now.getTime() - STRIPE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const read = await runConnectors(
    [
      createStripeWebhooksConnector({
        now,
        ...(options.allowSecretKey ? { allowSecretKey: true } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.maxPages ? { maxPages: options.maxPages } : {}),
        onReadable: (d) => (readFrom = d),
      }) as Connector<unknown>,
    ],
    env,
    options.fetcher,
  );
  const stopped = failures(read.notices);
  if (stopped !== undefined)
    throw new ConfigError(stopped, { hint: "The steps are in docs/delivery." });
  const endpoints = (read.data.get("stripe-webhooks") ?? []) as WebhookEndpointState[];
  const checked = await runChecks({ endpoints }, createWebhookRegistry());
  return {
    endpoints,
    eventsFrom: day(readFrom),
    notices: read.notices.map((n) => n.message),
    result: buildResult({
      url: "platform",
      startedAt: now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
      sampled: {
        "webhook-endpoints": {
          seen: endpoints.length,
          taken: endpoints.length,
          limit: 100 * (options.maxPages ?? 50),
        },
      },
    }),
  };
}
