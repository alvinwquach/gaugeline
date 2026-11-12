/**
 * The inbound webhook, without a database: the signature, the size cap, the parser, and the promise that
 * nothing reaches the database (or a payment host) before the body is verified.
 */
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_WEBHOOK_BYTES,
  parseWebhookEvent,
  postWebhook,
  SIGNATURE_HEADER,
  sign,
  verifySignature,
  type WebhookDeps,
} from "../../lib/billing/webhook.js";
import { at, ORG, T0, TEST_CONFIG } from "./billing-fixtures.js";

const SECRET = "test-webhook-secret-not-real-0123456789abcdef";
const OLD_SECRET = "older-webhook-secret-not-real-0123456789abcdef";
const bytes = (s: string) => new TextEncoder().encode(s);
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

const wire = (over: Record<string, unknown> = {}) => ({
  id: "sa_evt_1",
  type: "subscription.created",
  created: seconds(T0),
  org_id: ORG,
  customer_id: "sa_cus_1",
  subscription_id: "sa_sub_1",
  subscription: {
    plan_id: "small",
    interval: "month",
    status: "active",
    current_period_end: seconds(at(60 * 24 * 30)),
    trial_end: null,
    cancel_at_period_end: false,
  },
  ...over,
});

describe("signature", () => {
  const body = bytes(JSON.stringify(wire()));
  const good = sign(SECRET, body, seconds(T0));
  const check = (header: string | null, b = body, secrets = [SECRET], now = T0) =>
    verifySignature(header, b, secrets, now);

  it("accepts the body it was made for", () => {
    expect(check(good)).toEqual({ ok: true });
  });

  it("refuses another secret, another body, and the same JSON written differently", () => {
    expect(check(good, body, ["another-secret-0123456789abcdef0123456789"])).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(check(good, bytes(JSON.stringify(wire({ id: "sa_evt_2" }))))).toEqual({
      ok: false,
      reason: "mismatch",
    });
    // Parsed and written again, the JSON means the same and the bytes do not: only the raw body is signed.
    const again = bytes(JSON.stringify(JSON.parse(new TextDecoder().decode(body)), null, 2));
    expect(check(good, again)).toEqual({ ok: false, reason: "mismatch" });
    expect(check(good, new Uint8Array([...body, 32]))).toEqual({ ok: false, reason: "mismatch" });
  });

  it("holds the timestamp to a window: 300 seconds old and 60 seconds ahead are the edges", () => {
    const at_ = (t: number) => sign(SECRET, body, t);
    const now = seconds(T0);
    expect(check(at_(now - 300))).toEqual({ ok: true });
    expect(check(at_(now - 301))).toEqual({ ok: false, reason: "too_old" });
    expect(check(at_(now + 60))).toEqual({ ok: true });
    expect(check(at_(now + 61))).toEqual({ ok: false, reason: "too_new" });
  });

  it("refuses a missing, empty, malformed or oversized header", () => {
    const h = (v: string | null) => check(v);
    expect(h(null)).toEqual({ ok: false, reason: "missing" });
    for (const bad of [
      "",
      "garbage",
      `t=abc,v1=${"a".repeat(64)}`,
      `t=${seconds(T0)}`,
      `t=${seconds(T0)},v1=zz`,
      `t=${seconds(T0)},v1=${"a".repeat(63)}`,
      `t=${seconds(T0)},v1=${"A".repeat(64)}`,
      `t=1.5,v1=${"a".repeat(64)}`,
      `t=${seconds(T0)},v1=${"a".repeat(64)},${"x=1,".repeat(400)}`,
    ])
      expect(h(bad), bad.slice(0, 40)).toEqual({
        ok: false,
        reason: expect.stringMatching(/malformed|mismatch/),
      });
  });

  it("accepts a rotation: either of two signatures in the header, or the old secret still configured", () => {
    const t = seconds(T0);
    const fresh = sign(SECRET, body, t);
    const old = sign(OLD_SECRET, body, t);
    const both = `${old},${fresh.split(",")[1]}`;
    expect(check(both)).toEqual({ ok: true });
    expect(check(old, body, [SECRET, OLD_SECRET])).toEqual({ ok: true });
    expect(check(old, body, [SECRET])).toEqual({ ok: false, reason: "mismatch" });
  });

  it("is HMAC-SHA256 over `timestamp.body`, in lower-case hex", () => {
    const t = seconds(T0);
    const expected = createHmac("sha256", SECRET).update(`${t}.`).update(body).digest("hex");
    expect(sign(SECRET, body, t)).toBe(`t=${t},v1=${expected}`);
  });

  it("compares with timingSafeEqual and never with === on the signature", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../lib/billing/webhook.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).not.toMatch(/(?:signature|digest|expected|provided)\s*[!=]==/);
  });
});

describe("parseWebhookEvent", () => {
  const parse = (o: unknown) => parseWebhookEvent(bytes(JSON.stringify(o)));

  it("maps the wire shape onto a billing event with dates", () => {
    const r = parse(wire());
    expect(r).toMatchObject({
      kind: "event",
      event: {
        provider: "stand-in",
        id: "sa_evt_1",
        type: "subscription.created",
        createdAt: T0,
        orgId: ORG,
        customerId: "sa_cus_1",
        subscriptionId: "sa_sub_1",
        subscription: {
          planId: "small",
          interval: "month",
          status: "active",
          cancelAtPeriodEnd: false,
        },
      },
    });
  });

  it("keeps only the provider's ids: anything else in the body is dropped, never carried on", () => {
    const card = { number: "4".repeat(16), cvc: "123" };
    const r = parse(wire({ card, payment_method: card, email: "x@example.test" }));
    expect(r.kind).toBe("event");
    expect(JSON.stringify(r)).not.toMatch(/4444|cvc|payment_method|x@example/);
  });

  it("an event type this app does not know is ignored (acknowledged, not retried)", () => {
    expect(parse(wire({ type: "invoice.finalized" }))).toEqual({ kind: "ignored" });
  });

  it("refuses what is not an event: not JSON, wrong shapes, bad ids, a created event with no subscription", () => {
    expect(parseWebhookEvent(bytes("{nope")).kind).toBe("invalid");
    expect(parseWebhookEvent(bytes("[]")).kind).toBe("invalid");
    for (const bad of [
      wire({ id: "has space" }),
      wire({ id: "" }),
      wire({ org_id: "not-a-uuid" }),
      wire({ created: 1.5 }),
      wire({ created: -1 }),
      wire({ created: 99_999_999_999 }),
      wire({ subscription: undefined }),
      wire({ subscription: { ...wire().subscription, status: "free_forever" } }),
      wire({ subscription: { ...wire().subscription, plan_id: "Has Capitals" } }),
    ])
      expect(parse(bad).kind, JSON.stringify(bad).slice(0, 60)).toBe("invalid");
  });

  it("payment and cancel events need no subscription block", () => {
    expect(parse({ ...wire({ type: "payment.failed" }), subscription: undefined }).kind).toBe(
      "event",
    );
  });
});

describe("postWebhook before the database", () => {
  const untouched = new Proxy(
    {},
    {
      get: () => {
        throw new Error("the database was reached");
      },
    },
  ) as WebhookDeps["sql"];
  const deps: WebhookDeps = {
    sql: untouched,
    secrets: [SECRET],
    config: TEST_CONFIG,
    now: () => T0,
    notify: async () => {},
  };
  const post = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
    postWebhook(
      new Request("https://hosted.example/api/v1/billing/webhook", {
        method: "POST",
        headers,
        body,
      }),
      deps,
    );
  const signed = (body: Uint8Array) => ({ [SIGNATURE_HEADER]: sign(SECRET, body, seconds(T0)) });
  afterEach(() => vi.restoreAllMocks());

  it("refuses a body over the cap by its declared length, and by its real length when none is declared", async () => {
    const big = new Uint8Array(MAX_WEBHOOK_BYTES + 1);
    expect((await post(big, { "content-length": String(big.length) })).status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(MAX_WEBHOOK_BYTES));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    });
    const res = await postWebhook(
      new Request("https://hosted.example/api/v1/billing/webhook", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
      deps,
    );
    expect(res.status).toBe(413);
  });

  it("a body exactly at the cap gets as far as the signature check", async () => {
    const edge = new Uint8Array(MAX_WEBHOOK_BYTES);
    expect((await post(edge, signed(edge))).status).toBe(400); // signed fine, but not an event
  });

  it("refuses a bad or missing signature with 400 before parsing, and says nothing about why", async () => {
    const body = bytes(JSON.stringify(wire()));
    const none = await post(body);
    const wrong = await post(body, {
      [SIGNATURE_HEADER]: sign("other-secret-0123456789abcdef0123456789", body, seconds(T0)),
    });
    const stale = await post(body, { [SIGNATURE_HEADER]: sign(SECRET, body, seconds(T0) - 3600) });
    for (const r of [none, wrong, stale]) {
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({
        code: "invalid_signature",
        message: "The signature could not be verified.",
      });
    }
  });

  it("a verified body that is not an event is 400; an unknown event type is acknowledged with 200", async () => {
    const junk = bytes("{nope");
    expect((await post(junk, signed(junk))).status).toBe(400);
    const other = bytes(JSON.stringify(wire({ type: "invoice.finalized" })));
    const res = await post(other, signed(other));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
  });

  it("only POST", async () => {
    const res = await postWebhook(
      new Request("https://hosted.example/api/v1/billing/webhook"),
      deps,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("logs and answers without the secret or the signature", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = bytes(JSON.stringify(wire()));
    const header = sign("other-secret-0123456789abcdef0123456789", body, seconds(T0));
    const res = await post(body, { [SIGNATURE_HEADER]: header });
    const everything = JSON.stringify(log.mock.calls) + (await res.text());
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(header.split("v1=")[1]!);
  });
});

describe("no payment host is ever called", () => {
  it("the billing code has no network client and names no payment host", () => {
    const dir = fileURLToPath(new URL("../../lib/billing/", import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(src, f).not.toMatch(
        /\bfetch\s*\(|node:https?|node:net|node:tls|XMLHttpRequest|undici|stripe/i,
      );
      expect(src, f).not.toMatch(/https?:\/\/(?!hosted\.example|127\.0\.0\.1)/);
    }
  });
});
