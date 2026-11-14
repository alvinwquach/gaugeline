import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import type { PaidOrder } from "../delivery/reconcile.js";
import type { Window } from "../delivery/window.js";
import { isConfigured } from "./env.js";
import { getJson, isRecord } from "./get-json.js";
import { ConnectorRateLimitedError, ConnectorRefusedError } from "./http.js";
import { createRedactor } from "./redact.js";
import { STRIPE_API_KEY, STRIPE_MAX_PAGES, STRIPE_PAGE_SIZE, guardStripeKey } from "./stripe.js";
import type { Connector } from "./types.js";

const API = "https://api.stripe.com/v1/checkout/sessions";

/** What the restricted key reads. PaymentIntents and Charges are only for telling a refunded order from a paid one. */
export const STRIPE_ORDERS_NEEDS = "Checkout Sessions, PaymentIntents and Charges";

export interface StripeOrdersOptions {
  /** The span to read. Only orders paid inside it are returned. */
  window: Window;
  /** Turn the refusal of a live secret key into a notice (--allow-secret-key). */
  allowSecretKey?: boolean;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Told where the readable window starts: the window's start, or later if the page cap cut it short. */
  onReadable?: (from: Date) => void;
  /** Pages read at most. Defaults to the Stripe connector's STRIPE_MAX_PAGES. */
  maxPages?: number;
}

/** Stripe's `created` (seconds) as milliseconds, or null for anything that is not a time. */
function createdMs(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v * 1000 : null;
}

/** An order from one Checkout Session, or null when it is not a paid order. Only a time and an address are kept. */
function orderOf(raw: unknown): PaidOrder | null {
  if (!isRecord(raw)) return null;
  const at = createdMs(raw.created);
  if (at === null || raw.payment_status !== "paid") return null;
  // Refunded in full: the charge behind it says so when payment_intent.latest_charge is expanded.
  const intent = raw.payment_intent;
  const charge = isRecord(intent) ? intent.latest_charge : undefined;
  if (isRecord(charge) && charge.refunded === true) return null;
  const details = isRecord(raw.customer_details) ? raw.customer_details.email : undefined;
  const email =
    typeof details === "string" && details.trim() !== ""
      ? details
      : typeof raw.customer_email === "string" && raw.customer_email.trim() !== ""
        ? raw.customer_email
        : null;
  return { at, email };
}

function refusal(err: ConnectorRefusedError): ConnectorRefusedError {
  return new ConnectorRefusedError(
    err.status,
    err.status === 401
      ? `Stripe did not accept ${STRIPE_API_KEY}. Check it is a restricted key from the right Stripe account.`
      : `${STRIPE_API_KEY} cannot read ${STRIPE_ORDERS_NEEDS}. In Stripe, edit the restricted key and set Checkout Sessions, PaymentIntents and Charges to Read; nothing else is needed.`,
  );
}

/**
 * Stripe as a source of paid orders ("stripe-orders"). Read only: GETs of the Checkout Sessions
 * list, 100 a page, newest first, from the window's start, following `starting_after` while
 * `has_more` is true, at most STRIPE_MAX_PAGES pages. The key goes in an Authorization header.
 * Each paid session becomes {when, address}: no id, name, amount or payload is kept, and a session
 * that is unpaid, free, or refunded in full is not an order. A list the cap cut short says where the
 * readable window starts.
 */
export function createStripeOrdersConnector(options: StripeOrdersOptions): Connector<PaidOrder> {
  const { window } = options;
  const maxPages = options.maxPages ?? STRIPE_MAX_PAGES;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "stripe-orders",
    envVars: [STRIPE_API_KEY],
    secretEnvVars: [STRIPE_API_KEY],
    configured: (env) => isConfigured(env, [STRIPE_API_KEY]),
    async read(env, fetcher: Fetcher, note = () => undefined) {
      try {
        for (const n of guardStripeKey(env, {
          allowSecretKey: options.allowSecretKey === true,
          needs: STRIPE_ORDERS_NEEDS,
          steps: "docs/delivery",
        }))
          note(n);
        const key = (env[STRIPE_API_KEY] ?? "").trim();
        const source = {
          fetcher,
          request: { authorization: `Bearer ${key}` },
          sleep,
          system: "Stripe",
        };
        const orders: PaidOrder[] = [];
        let cursor: string | undefined;
        let oldest: number | undefined;
        let complete = false;
        for (let page = 1; page <= maxPages && !complete; page++) {
          const url =
            `${API}?limit=${STRIPE_PAGE_SIZE}` +
            `&created%5Bgte%5D=${Math.floor(window.from.getTime() / 1000)}` +
            `&expand%5B%5D=data.payment_intent.latest_charge` +
            (cursor === undefined ? "" : `&starting_after=${encodeURIComponent(cursor)}`);
          let body: unknown;
          try {
            body = (await getJson(source, url)).body;
          } catch (err) {
            if (err instanceof ConnectorRefusedError) throw refusal(err);
            throw err;
          }
          if (!isRecord(body) || !Array.isArray(body.data) || typeof body.has_more !== "boolean")
            throw new Error(
              "Stripe answered with something that is not a list of Checkout Sessions.",
            );
          const data: unknown[] = body.data;
          const last = data.at(-1);
          const lastId = isRecord(last) && typeof last.id === "string" ? last.id : null;
          if (data.length > 0 && lastId === null)
            throw new Error("Stripe answered with a Checkout Session that has no id.");
          if (lastId !== null && lastId === cursor) {
            note(
              "Stripe sent the same page of Checkout Sessions twice, so Gaugeline stopped reading them.",
            );
            break;
          }
          for (const raw of data) {
            const at = isRecord(raw) ? createdMs(raw.created) : null;
            if (at !== null) oldest = oldest === undefined ? at : Math.min(oldest, at);
            const order = orderOf(raw);
            if (order && order.at >= window.from.getTime() && order.at <= window.to.getTime())
              orders.push(order);
          }
          if (!body.has_more || lastId === null) complete = true;
          else cursor = lastId;
        }
        if (complete) options.onReadable?.(window.from);
        else {
          // The cap ended the read with orders still unread, all older than the oldest one read.
          const from = new Date(Math.max(oldest ?? window.from.getTime(), window.from.getTime()));
          options.onReadable?.(from);
          note(
            `Stripe has more Checkout Sessions in this window than Gaugeline reads in one run: it read the newest ${maxPages * STRIPE_PAGE_SIZE} sessions (${maxPages} pages of ${STRIPE_PAGE_SIZE}), back to ${from.toISOString().slice(0, 10)}, and left the older ones out.`,
          );
        }
        return orders;
      } catch (err) {
        if (
          err instanceof ConfigError ||
          err instanceof ConnectorRefusedError ||
          err instanceof ConnectorRateLimitedError
        )
          throw err;
        const text = err instanceof Error ? err.message : String(err);
        throw new Error(createRedactor(env, [STRIPE_API_KEY])(text));
      }
    },
  };
}
