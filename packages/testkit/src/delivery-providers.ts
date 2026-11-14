// check-community: allow-email (invented addresses at reserved example domains: the stand-ins for the providers need something to put in a response)
import { Readable } from "node:stream";
import type { Transport, TransportRequest } from "@gaugeline/core";

/**
 * Stand-ins for Stripe's and Resend's list endpoints, for the tests of `gaugeline delivery` and
 * `gaugeline platform`. They answer in the shape of the providers' list responses, written by hand
 * from the connectors' point of view: nothing here was recorded from an account, and every
 * customer, address and id is invented. A test builds one with `providerTransport`, hands it to the
 * fetcher as its transport, and reads `seen` to see every request that was made.
 */
export interface FakeOrder {
  /** ISO time the Checkout Session was created. */
  at: string;
  email: string | null;
  /** Stripe's payment_status: paid (default), unpaid or no_payment_required. */
  paymentStatus?: string;
  /** The charge behind it was refunded in full. */
  refunded?: boolean;
  /** Put the address in `customer_email` instead of `customer_details.email`. */
  emailOn?: "customer_email";
}

export interface FakeEmail {
  at: string;
  to: string[];
  /** Resend's last_event; "delivered" by default. */
  lastEvent?: string;
}

export interface FakeEndpoint {
  url: string;
  status?: "enabled" | "disabled";
  events?: string[];
}

export interface FakeEvent {
  type: string;
  at: string;
  /** Stripe's pending_webhooks: deliveries still not successful. */
  pending: number;
}

export interface FakeProviders {
  orders?: FakeOrder[];
  emails?: FakeEmail[];
  endpoints?: FakeEndpoint[];
  events?: FakeEvent[];
  /** The most rows any page returns, whatever limit was asked for (so a list needs several pages). */
  pageSize?: number;
  /** Answer every Stripe request with this status. */
  stripeStatus?: number;
  /** Answer every Resend request with this status. */
  resendStatus?: number;
  /** Resend no longer holds emails older than this (ISO time): they are not listed. */
  resendKeepsFrom?: string;
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const json = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** Newest first, as both providers list. */
function newestFirst<T extends { at: string }>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Date.parse(b.r.at) - Date.parse(a.r.at) || a.i - b.i)
    .map(({ r }) => r);
}

function page<T extends { id: string }>(
  rows: readonly T[],
  cursor: string | null,
  limit: number,
  pageSize: number,
): { data: T[]; more: boolean } {
  const start = cursor === null ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
  const size = Math.max(1, Math.min(limit, pageSize));
  return { data: rows.slice(start, start + size), more: start + size < rows.length };
}

export function providerTransport(spec: FakeProviders, seen: SeenRequest[] = []): Transport {
  const pageSize = spec.pageSize ?? 100;
  const orders = newestFirst(spec.orders ?? []).map((o, i) => ({
    ...o,
    id: `cs_live_a1B2c3D4e5_${i}`,
  }));
  const keeps = spec.resendKeepsFrom === undefined ? 0 : Date.parse(spec.resendKeepsFrom);
  const emails = newestFirst(spec.emails ?? [])
    .filter((e) => Date.parse(e.at) >= keeps)
    .map((e, i) => ({ ...e, id: `4ef9a417-02e9-4d39-ad75-9611e0fcc33c-${i}` }));
  const events = newestFirst(spec.events ?? []).map((e, i) => ({ ...e, id: `evt_1Pq${i}` }));

  return (url: URL, req: TransportRequest) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const q = url.searchParams;
    const limit = Number(q.get("limit") ?? "10");
    const cursor = q.get("starting_after") ?? q.get("after");
    if (url.hostname === "api.stripe.com") {
      if (spec.stripeStatus !== undefined)
        return json(spec.stripeStatus, { error: { type: "invalid_request_error" } });
      if (url.pathname === "/v1/checkout/sessions") {
        const from = Number(q.get("created[gte]") ?? "0");
        const inRange = orders.filter((o) => unix(o.at) >= from);
        const expanded = q.getAll("expand[]").some((e) => e.includes("payment_intent"));
        const { data, more } = page(inRange, cursor, limit, pageSize);
        return json(200, {
          object: "list",
          url: "/v1/checkout/sessions",
          has_more: more,
          data: data.map((o) => ({
            id: o.id,
            object: "checkout.session",
            created: unix(o.at),
            status: o.paymentStatus === "unpaid" ? "open" : "complete",
            payment_status: o.paymentStatus ?? "paid",
            amount_total: 4800,
            currency: "usd",
            customer_email: o.emailOn === "customer_email" ? o.email : null,
            customer_details:
              o.emailOn === "customer_email" ? null : { email: o.email, name: "Invented Name" },
            payment_intent: expanded
              ? { id: "pi_3Pq", latest_charge: { id: "ch_3Pq", refunded: o.refunded === true } }
              : "pi_3Pq",
          })),
        });
      }
      if (url.pathname === "/v1/webhook_endpoints") {
        const rows = (spec.endpoints ?? []).map((e, i) => ({
          id: `we_1Pq${i}`,
          object: "webhook_endpoint",
          url: e.url,
          status: e.status ?? "enabled",
          enabled_events: e.events ?? ["*"],
        }));
        const { data, more } = page(rows, cursor, limit, pageSize);
        return json(200, { object: "list", url: "/v1/webhook_endpoints", has_more: more, data });
      }
      if (url.pathname === "/v1/events") {
        const from = Number(q.get("created[gte]") ?? "0");
        const onlyUndelivered = q.get("delivery_success") === "false";
        const rows = events.filter(
          (e) => unix(e.at) >= from && (!onlyUndelivered || e.pending > 0),
        );
        const { data, more } = page(rows, cursor, limit, pageSize);
        return json(200, {
          object: "list",
          url: "/v1/events",
          has_more: more,
          data: data.map((e) => ({
            id: e.id,
            object: "event",
            type: e.type,
            created: unix(e.at),
            pending_webhooks: e.pending,
            data: { object: { id: "cs_live_x", customer_email: "invented@example.test" } },
          })),
        });
      }
    }
    if (url.hostname === "api.resend.com" && url.pathname === "/emails") {
      if (spec.resendStatus !== undefined)
        return json(spec.resendStatus, {
          name: "restricted_api_key",
          statusCode: spec.resendStatus,
        });
      const { data, more } = page(emails, cursor, limit, pageSize);
      return json(200, {
        object: "list",
        has_more: more,
        data: data.map((e) => ({
          id: e.id,
          to: e.to,
          from: "Invented Shop <orders@shop.example>",
          created_at: new Date(e.at).toISOString().replace("T", " ").replace("Z", "+00"),
          subject: "Your receipt",
          last_event: e.lastEvent ?? "delivered",
        })),
      });
    }
    return json(404, { error: "not found" });
  };
}
