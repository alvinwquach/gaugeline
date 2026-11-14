// check-community: allow-email (invented addresses at reserved example domains: the stand-ins for Stripe and Resend need something to put in a response)
import { describe, expect, it } from "vitest";
import {
  providerTransport,
  type FakeProviders,
  type SeenRequest,
} from "../../../../testkit/src/index.js";
import { ConfigError } from "../../errors.js";
import { createFetcher } from "../../fetcher.js";
import { parseWindow } from "../../delivery/window.js";
import { runConnectors } from "../run.js";
import { createResendSentConnector, RESEND_API_KEY } from "../resend-sent.js";
import { createStripeOrdersConnector } from "../stripe-orders.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const RK = ["rk", "live", "Tideline0123456789abcdef"].join("_");
const SK = ["sk", "live", "Tideline0123456789abcdef"].join("_");
const RESEND = ["re", "Tideline0123456789abcdef"].join("_");
const NOW = new Date("2026-11-10T12:00:00Z");
const WEEK = parseWindow("7d", NOW);
const noSleep = () => Promise.resolve();

function fetcherFor(spec: FakeProviders, seen: SeenRequest[] = []) {
  return createFetcher({ transport: providerTransport(spec, seen), timeoutMs: 5000 });
}

/** n orders an hour apart, newest first on the provider's side, all inside the week. */
const orders = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    at: new Date(NOW.getTime() - (i + 1) * 30 * 60 * 1000).toISOString(),
    email: `buyer${i}@tideline.example`,
  }));
const emails = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    at: new Date(NOW.getTime() - (i + 1) * 30 * 60 * 1000).toISOString(),
    to: [`buyer${i}@tideline.example`],
  }));

describe("stripe-orders: integration", () => {
  it("reads 250 orders across three pages, newest first, and keeps counts only", async () => {
    const seen: SeenRequest[] = [];
    const rows = await createStripeOrdersConnector({ window: WEEK, sleep: noSleep }).read(
      { STRIPE_API_KEY: RK },
      fetcherFor({ orders: orders(250), pageSize: 100 }, seen),
    );
    expect(rows).toHaveLength(250);
    expect(seen).toHaveLength(3);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["at", "email"]);
  });

  it("sends the key in an Authorization header only, and every request is a GET", async () => {
    const seen: SeenRequest[] = [];
    await createStripeOrdersConnector({ window: WEEK, sleep: noSleep }).read(
      { STRIPE_API_KEY: RK },
      fetcherFor({ orders: orders(3) }, seen),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url).not.toContain(RK);
      expect(s.headers.authorization ?? s.headers.Authorization).toBe(`Bearer ${RK}`);
      expect(new URL(s.url).hostname).toBe("api.stripe.com");
    }
  });

  it("asks only for the window: created[gte] is the window's start in seconds", async () => {
    const seen: SeenRequest[] = [];
    await createStripeOrdersConnector({ window: WEEK, sleep: noSleep }).read(
      { STRIPE_API_KEY: RK },
      fetcherFor({ orders: orders(1) }, seen),
    );
    const first = new URL(seen[0]?.url ?? "");
    expect(first.pathname).toBe("/v1/checkout/sessions");
    expect(first.searchParams.get("created[gte]")).toBe(String(WEEK.from.getTime() / 1000));
  });

  it("an unpaid, a no-payment-required and a fully refunded session are not paid", async () => {
    const at = "2026-11-09T10:00:00Z";
    const rows = await createStripeOrdersConnector({ window: WEEK, sleep: noSleep }).read(
      { STRIPE_API_KEY: RK },
      fetcherFor({
        orders: [
          { at, email: "paid@tideline.example" },
          { at, email: "unpaid@tideline.example", paymentStatus: "unpaid" },
          { at, email: "free@tideline.example", paymentStatus: "no_payment_required" },
          { at, email: "refunded@tideline.example", refunded: true },
        ],
      }),
    );
    expect(rows).toEqual([{ at: Date.parse(at), email: "paid@tideline.example" }]);
  });

  it("the address is read from customer_details, or from customer_email", async () => {
    const at = "2026-11-09T10:00:00Z";
    const rows = await createStripeOrdersConnector({ window: WEEK, sleep: noSleep }).read(
      { STRIPE_API_KEY: RK },
      fetcherFor({
        orders: [
          { at, email: "a@tideline.example" },
          { at, email: "b@tideline.example", emailOn: "customer_email" },
          { at, email: null },
        ],
      }),
    );
    expect(rows.map((r) => r.email).sort()).toEqual([
      "a@tideline.example",
      "b@tideline.example",
      null,
    ]);
  });

  it("orders before the window or after now are left out", async () => {
    const rows = await createStripeOrdersConnector({ window: WEEK, sleep: noSleep }).read(
      { STRIPE_API_KEY: RK },
      fetcherFor({
        orders: [
          { at: "2026-11-02T10:00:00Z", email: "old@tideline.example" },
          { at: "2026-11-09T10:00:00Z", email: "in@tideline.example" },
          { at: "2026-11-11T10:00:00Z", email: "future@tideline.example" },
        ],
      }),
    );
    expect(rows.map((r) => r.email)).toEqual(["in@tideline.example"]);
  });

  it("reports the whole window as read when the list ends", async () => {
    let from: Date | undefined;
    await createStripeOrdersConnector({
      window: WEEK,
      sleep: noSleep,
      onReadable: (d) => (from = d),
    }).read({ STRIPE_API_KEY: RK }, fetcherFor({ orders: orders(5) }));
    expect(from).toEqual(WEEK.from);
  });

  it("stops at the page cap, says so, and reports where the readable window starts", async () => {
    let from: Date | undefined;
    const notes: string[] = [];
    const rows = await createStripeOrdersConnector({
      window: WEEK,
      sleep: noSleep,
      maxPages: 2,
      onReadable: (d) => (from = d),
    }).read(
      { STRIPE_API_KEY: RK },
      fetcherFor({ orders: orders(250), pageSize: 100 }),
      (m) => void notes.push(m),
    );
    expect(rows).toHaveLength(200);
    expect(notes.join(" ")).toMatch(/200/);
    // The oldest order read is 200 half-hours back: the readable window starts there.
    expect(from?.toISOString()).toBe(new Date(NOW.getTime() - 200 * 30 * 60 * 1000).toISOString());
  });

  it("401 and 403 are refusals that name the key and the permission", async () => {
    const env = { STRIPE_API_KEY: RK };
    const c = createStripeOrdersConnector({ window: WEEK, sleep: noSleep });
    const denied = await runConnectors([c], env, fetcherFor({ stripeStatus: 403 }));
    expect(denied.notices[0]).toMatchObject({ connector: "stripe-orders", kind: "refused" });
    expect(denied.notices[0]?.message).toMatch(/Checkout Sessions/);
    const unknown = await runConnectors([c], env, fetcherFor({ stripeStatus: 401 }));
    expect(unknown.notices[0]?.message).toMatch(/STRIPE_API_KEY/);
    for (const n of [...denied.notices, ...unknown.notices]) expect(n.message).not.toContain(RK);
  });

  it("a live secret key is refused before any request, unless allowed", async () => {
    const seen: SeenRequest[] = [];
    const c = createStripeOrdersConnector({ window: WEEK, sleep: noSleep });
    await expect(c.read({ STRIPE_API_KEY: SK }, fetcherFor({}, seen))).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(seen).toHaveLength(0);
    const notes: string[] = [];
    const allowed = createStripeOrdersConnector({
      window: WEEK,
      sleep: noSleep,
      allowSecretKey: true,
    });
    await allowed.read(
      { STRIPE_API_KEY: SK },
      fetcherFor({ orders: orders(1) }),
      (m) => void notes.push(m),
    );
    expect(notes.join(" ")).toMatch(/secret key/);
    expect(notes.join(" ")).not.toContain(SK);
  });

  it("the refusal of a secret key says which permission a restricted key needs", async () => {
    const c = createStripeOrdersConnector({ window: WEEK, sleep: noSleep });
    await expect(c.read({ STRIPE_API_KEY: SK }, fetcherFor({}))).rejects.toThrow(
      /Checkout Sessions/,
    );
  });

  it("is not configured without the variable", () => {
    const c = createStripeOrdersConnector({ window: WEEK });
    expect(c.configured({})).toBe(false);
    expect(c.configured({ STRIPE_API_KEY: RK })).toBe(true);
    expect(c.id).toBe("stripe-orders");
  });
});

describe("resend-sent: integration", () => {
  const env = { [RESEND_API_KEY]: RESEND };
  const make = (extra = {}) =>
    createResendSentConnector({ window: WEEK, now: NOW, sleep: noSleep, ...extra });

  it("reads 250 emails across three pages", async () => {
    const seen: SeenRequest[] = [];
    const rows = await make().read(env, fetcherFor({ emails: emails(250), pageSize: 100 }, seen));
    expect(rows).toHaveLength(250);
    expect(seen).toHaveLength(3);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["at", "to"]);
  });

  it("sends the key in an Authorization header only, and every request is a GET", async () => {
    const seen: SeenRequest[] = [];
    await make().read(env, fetcherFor({ emails: emails(3) }, seen));
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url).not.toContain(RESEND);
      expect(s.headers.authorization ?? s.headers.Authorization).toBe(`Bearer ${RESEND}`);
      expect(new URL(s.url).hostname).toBe("api.resend.com");
    }
  });

  it("stops asking once a page reaches back past the window", async () => {
    const seen: SeenRequest[] = [];
    const day = 24 * 60 * 60 * 1000;
    const spread = Array.from({ length: 60 }, (_, i) => ({
      at: new Date(NOW.getTime() - i * 0.25 * day).toISOString(),
      to: [`buyer${i}@tideline.example`],
    }));
    const rows = await make().read(env, fetcherFor({ emails: spread, pageSize: 10 }, seen));
    // 7 days at 4 a day: 28 inside the window (the 29th, at exactly 7 days, is the start).
    expect(rows.length).toBeLessThanOrEqual(29);
    expect(seen.length).toBeLessThan(6);
  });

  it("counts an email as sent unless the provider says it failed, bounced or never left", async () => {
    const at = "2026-11-09T10:00:00Z";
    const rows = await make().read(
      env,
      fetcherFor({
        emails: [
          { at, to: ["ok@tideline.example"] },
          { at, to: ["opened@tideline.example"], lastEvent: "opened" },
          { at, to: ["late@tideline.example"], lastEvent: "delivery_delayed" },
          { at, to: ["bounced@tideline.example"], lastEvent: "bounced" },
          { at, to: ["failed@tideline.example"], lastEvent: "failed" },
          { at, to: ["later@tideline.example"], lastEvent: "scheduled" },
          { at, to: ["cancelled@tideline.example"], lastEvent: "canceled" },
        ],
      }),
    );
    expect(rows.flatMap((r) => r.to).sort()).toEqual([
      "late@tideline.example",
      "ok@tideline.example",
      "opened@tideline.example",
    ]);
  });

  it("reads Resend's own timestamp format", async () => {
    const rows = await make().read(
      env,
      fetcherFor({ emails: [{ at: "2026-11-09T10:00:00.250Z", to: ["a@tideline.example"] }] }),
    );
    expect(rows[0]?.at).toBe(Date.parse("2026-11-09T10:00:00.250Z"));
  });

  it("states the readable window when the provider keeps less than was asked for", async () => {
    let from: Date | undefined;
    await make({ retentionDays: 3, onReadable: (d: Date) => (from = d) }).read(
      env,
      fetcherFor({ emails: emails(4) }),
    );
    expect(from?.toISOString()).toBe("2026-11-07T12:00:00.000Z");
  });

  it("a window inside the retention is read in full", async () => {
    let from: Date | undefined;
    await make({ onReadable: (d: Date) => (from = d) }).read(env, fetcherFor({ emails: [] }));
    expect(from).toEqual(WEEK.from);
  });

  it("a page cap is reported as where the readable window starts", async () => {
    let from: Date | undefined;
    const notes: string[] = [];
    const rows = await make({ maxPages: 1, onReadable: (d: Date) => (from = d) }).read(
      env,
      fetcherFor({ emails: emails(250), pageSize: 100 }),
      (m) => void notes.push(m),
    );
    expect(rows).toHaveLength(100);
    expect(notes[0]).toMatch(/100/);
    expect(from?.toISOString()).toBe(new Date(NOW.getTime() - 100 * 30 * 60 * 1000).toISOString());
  });

  it("401 is a refusal that names RESEND_API_KEY and never shows the key", async () => {
    const out = await runConnectors([make()], env, fetcherFor({ resendStatus: 401 }));
    expect(out.notices[0]).toMatchObject({ connector: "resend-sent", kind: "refused" });
    expect(out.notices[0]?.message).toMatch(/RESEND_API_KEY/);
    expect(out.notices[0]?.message).not.toContain(RESEND);
  });

  it("is not configured without the variable", () => {
    expect(make().configured({})).toBe(false);
    expect(make().configured(env)).toBe(true);
    expect(make().id).toBe("resend-sent");
  });
});
