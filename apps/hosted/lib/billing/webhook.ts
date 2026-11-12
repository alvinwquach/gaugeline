/**
 * The inbound payment webhook: POST /api/v1/billing/webhook.
 *
 * Order matters, and nothing before the signature trusts the body:
 *   1. only POST; a declared length over the cap is refused (413) without reading;
 *   2. the body is read as raw bytes, never past the cap (413);
 *   3. the signature is checked over those exact bytes, in constant time, inside a timestamp window (400);
 *   4. only then is the body parsed, down to the provider's ids (an unknown event type is acknowledged);
 *   5. the event is saved in one transaction, once however often it arrives (store.ts).
 * Nothing here makes a network request. The signature scheme is this app's own, modelled on the common
 * `t=<seconds>,v1=<hex>` header with HMAC-SHA256 over `<t>.<raw body>`; a real provider's adapter will
 * replace sign() and verifySignature() with that provider's documented scheme (none exists yet).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { withService, type Sql } from "../api/db.js";
import { problem, json } from "../api/http.js";
import type { BillingConfig } from "./config.js";
import type { BillingEvent, Effect } from "./state.js";
import { recordEvent } from "./store.js";

export const SIGNATURE_HEADER = "gl-signature";
/** Billing events are a few hundred bytes; 64 KB leaves room for a provider adding fields. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;
export const PAST_TOLERANCE_S = 300;
export const FUTURE_TOLERANCE_S = 60;
const MAX_HEADER = 1024;
const HEX64 = /^[0-9a-f]{64}$/;

const mac = (secret: string, timestamp: number, body: Uint8Array): Buffer =>
  createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();

/** The header value for a body: used by the local stand-in and by tests. */
export const sign = (secret: string, body: Uint8Array, timestamp: number): string =>
  `t=${timestamp},v1=${mac(secret, timestamp, body).toString("hex")}`;

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "too_old" | "too_new" | "mismatch" };

/**
 * Checks `header` against the raw `body` for any of `secrets` (more than one while a secret is being
 * rotated) and any `v1` in the header. Every candidate is compared, in constant time, with no early exit.
 */
export function verifySignature(
  header: string | null,
  body: Uint8Array,
  secrets: readonly string[],
  now: Date,
): SignatureResult {
  if (header === null) return { ok: false, reason: "missing" };
  if (header.length === 0 || header.length > MAX_HEADER) return { ok: false, reason: "malformed" };
  let timestamp: number | undefined;
  const candidates: Buffer[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (eq < 0) continue;
    if (key === "t" && /^[0-9]{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && HEX64.test(value)) candidates.push(Buffer.from(value, "hex"));
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: "malformed" };
  const age = Math.floor(now.getTime() / 1000) - timestamp;
  if (age > PAST_TOLERANCE_S) return { ok: false, reason: "too_old" };
  if (-age > FUTURE_TOLERANCE_S) return { ok: false, reason: "too_new" };
  let matched = false;
  for (const secret of secrets) {
    const expected = mac(secret, timestamp, body);
    for (const c of candidates) matched = timingSafeEqual(c, expected) || matched;
  }
  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}

// ---- the body ------------------------------------------------------------------------------------------

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/);
const seconds = z.number().int().min(0).max(4_102_444_800);
const TYPES = [
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "payment.failed",
  "payment.succeeded",
] as const;

const envelope = z.object({ id, type: z.string().max(64) });
const wire = z.object({
  id,
  type: z.enum(TYPES),
  created: seconds,
  org_id: z.uuid(),
  customer_id: id,
  subscription_id: id,
  subscription: z
    .object({
      plan_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      interval: z.enum(["month", "year"]).nullable(),
      status: z.enum(["trialing", "active", "past_due", "canceled"]),
      current_period_end: seconds.nullable(),
      trial_end: seconds.nullable(),
      cancel_at_period_end: z.boolean(),
    })
    .optional(),
});

export type Parsed =
  { kind: "event"; event: BillingEvent } | { kind: "ignored" } | { kind: "invalid" };

const date = (s: number | null): Date | null => (s === null ? null : new Date(s * 1000));

/**
 * The verified body as a billing event. Fields not named above are dropped here, so nothing a provider adds
 * (a card, an address) can be stored: the event type has no place for it.
 */
export function parseWebhookEvent(body: Uint8Array): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { kind: "invalid" };
  }
  const head = envelope.safeParse(raw);
  if (!head.success) return { kind: "invalid" };
  if (!(TYPES as readonly string[]).includes(head.data.type)) return { kind: "ignored" };
  const parsed = wire.safeParse(raw);
  if (!parsed.success) return { kind: "invalid" };
  const w = parsed.data;
  const base = {
    provider: "stand-in",
    id: w.id,
    createdAt: new Date(w.created * 1000),
    orgId: w.org_id.toLowerCase(),
    customerId: w.customer_id,
    subscriptionId: w.subscription_id,
  };
  if (w.type === "subscription.created" || w.type === "subscription.updated") {
    const s = w.subscription;
    if (!s) return { kind: "invalid" };
    return {
      kind: "event",
      event: {
        ...base,
        type: w.type,
        subscription: {
          planId: s.plan_id,
          interval: s.interval,
          status: s.status,
          currentPeriodEnd: date(s.current_period_end),
          trialEndsAt: date(s.trial_end),
          cancelAtPeriodEnd: s.cancel_at_period_end,
        },
      },
    };
  }
  return { kind: "event", event: { ...base, type: w.type } };
}

// ---- the handler ---------------------------------------------------------------------------------------

export interface WebhookDeps {
  sql: Sql;
  /** The signing secret(s), server-only. */
  secrets: readonly string[];
  config: BillingConfig;
  now: () => Date;
  /** Carries out an effect after the event is saved (the failed-payment notice). Never receives a secret. */
  notify: (effect: Effect) => Promise<void>;
}

/** The body as bytes, or undefined when it is over the cap; never reads past the cap. */
async function readCapped(req: Request): Promise<Uint8Array | undefined> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return undefined;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function postWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST")
    return problem(405, "method_not_allowed", "Use POST.", { allow: "POST" });
  const body = await readCapped(req);
  if (!body)
    return problem(
      413,
      "too_large",
      `The body is over ${MAX_WEBHOOK_BYTES / 1024} KB; nothing was read.`,
    );
  const checked = verifySignature(
    req.headers.get(SIGNATURE_HEADER),
    body,
    deps.secrets,
    deps.now(),
  );
  // One answer for every failure: the reason would only help someone guessing.
  if (!checked.ok) return problem(400, "invalid_signature", "The signature could not be verified.");
  const parsed = parseWebhookEvent(body);
  if (parsed.kind === "invalid")
    return problem(400, "invalid_event", "The body is not a billing event.");
  if (parsed.kind === "ignored") return json(200, { status: "ignored" });

  let result;
  try {
    result = await withService(deps.sql, (tx) => recordEvent(tx, parsed.event, deps.config));
  } catch (e) {
    // The error's code only: a database message can quote a row. The provider retries on a 500.
    console.error(
      "billing webhook: the event was not saved",
      (e as { code?: string }).code ?? "error",
    );
    return problem(500, "internal_error", "The event was not saved; try again.");
  }
  // The subscription is not known yet (its created event is still on the way): not saved, so the retry works.
  if (result.outcome === "needs_subscription")
    return problem(409, "subscription_unknown", "Not saved yet; send this event again later.", {
      "retry-after": "30",
    });
  for (const effect of result.effects) {
    try {
      await deps.notify(effect);
    } catch {
      console.error("billing webhook: a notice could not be sent");
    }
  }
  return json(200, { status: result.outcome });
}
