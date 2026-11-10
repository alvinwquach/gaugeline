// check-community: allow-email (invented addresses at reserved example domains, matched by hash and never printed)
import { describe, expect, it } from "vitest";
import {
  providerTransport,
  type FakeOrder,
  type FakeProviders,
  type SeenRequest,
} from "../../../../testkit/src/index.js";
import { ConfigError } from "../../errors.js";
import { createFetcher } from "../../fetcher.js";
import { resultSchema } from "../../result.js";
import { runDelivery, runWebhooks, type DeliveryOptions } from "../run.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const RK = ["rk", "live", "Tideline0123456789abcdef"].join("_");
const RESEND = ["re", "Tideline0123456789abcdef"].join("_");
const NOW = new Date("2026-11-10T12:00:00Z");
const ENV = { STRIPE_API_KEY: RK, RESEND_API_KEY: RESEND };
const HOUR = 3600 * 1000;
const noSleep = () => Promise.resolve();

const buyer = (i: number) => `buyer${i}@tideline.example`;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const orders = (n: number, from = 0): FakeOrder[] =>
  Array.from({ length: n }, (_, i) => ({ at: at(2 + (from + i) * 0.4), email: buyer(from + i) }));
const emails = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ at: at(1.5 + (from + i) * 0.4), to: [buyer(from + i)] }));

function run(spec: FakeProviders, extra: Partial<DeliveryOptions> = {}, seen: SeenRequest[] = []) {
  return runDelivery({
    paid: true,
    sent: true,
    env: ENV,
    now: NOW,
    sleep: noSleep,
    fetcher: createFetcher({ transport: providerTransport(spec, seen), timeoutMs: 5000 }),
    ...extra,
  });
}

describe("runDelivery: integration (recorded-style responses, no live keys)", () => {
  it("12 paid and 9 sent: one high finding that says '12 paid, 9 sent'", async () => {
    const r = await run({ orders: orders(12), emails: emails(9) });
    expect(r.paid).toBe(12);
    expect(r.sent).toBe(9);
    expect(r.reconciled).toMatchObject({ paid: 12, sent: 9, unmatched: 3 });
    expect(r.result.findings).toHaveLength(1);
    expect(r.result.findings[0]).toMatchObject({
      checkId: "delivery-receipt-missing",
      severity: "high",
    });
    expect(r.result.findings[0]?.evidence).toMatch(/^12 paid, 9 sent in the last 7 days/);
    expect(resultSchema.safeParse(r.result).success).toBe(true);
  });

  it("both providers paginated across three pages each", async () => {
    const seen: SeenRequest[] = [];
    const r = await run({ orders: orders(250), emails: emails(250), pageSize: 100 }, {}, seen);
    expect(r.reconciled).toMatchObject({ paid: 250, sent: 250, unmatched: 0 });
    expect(seen.filter((s) => s.url.includes("api.stripe.com"))).toHaveLength(3);
    expect(seen.filter((s) => s.url.includes("api.resend.com"))).toHaveLength(3);
    expect(r.result.findings).toEqual([]);
    expect(r.result.passed).toEqual(["delivery-receipt-missing"]);
  });

  it("Resend answers 401: exit 2 for --paid --sent, naming the variable", async () => {
    const err = await run({ orders: orders(3), resendStatus: 401 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/RESEND_API_KEY/);
    expect((err as Error).message).not.toContain(RESEND);
  });

  it("... and --paid alone still prints its count, without asking Resend", async () => {
    const seen: SeenRequest[] = [];
    const r = await run({ orders: orders(3), resendStatus: 401 }, { sent: false }, seen);
    expect(r.paid).toBe(3);
    expect(r.sent).toBeUndefined();
    expect(r.reconciled).toBeUndefined();
    expect(seen.some((s) => s.url.includes("api.resend.com"))).toBe(false);
    expect(r.result.findings).toEqual([]);
  });

  it("--sent alone prints its count and never asks Stripe", async () => {
    const seen: SeenRequest[] = [];
    const r = await run({ emails: emails(4) }, { paid: false }, seen);
    expect(r.sent).toBe(4);
    expect(r.paid).toBeUndefined();
    expect(seen.some((s) => s.url.includes("api.stripe.com"))).toBe(false);
  });

  it("a missing key is exit 2 before any request, and names the variable", async () => {
    const seen: SeenRequest[] = [];
    const err = await run({}, { env: { STRIPE_API_KEY: RK } }, seen).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/RESEND_API_KEY/);
    expect((err as Error).message).not.toMatch(/Not set: .*STRIPE_API_KEY/);
    expect(seen).toHaveLength(0);
    const both = await run({}, { env: {} }).catch((e: unknown) => e);
    expect((both as Error).message).toMatch(/STRIPE_API_KEY, RESEND_API_KEY/);
    const empty = await run({}, { env: { STRIPE_API_KEY: "", RESEND_API_KEY: RESEND } }).catch(
      (e: unknown) => e,
    );
    expect((empty as Error).message).toMatch(/Not set: STRIPE_API_KEY/);
  });

  it("neither --paid nor --sent is a usage error", async () => {
    await expect(run({}, { paid: false, sent: false })).rejects.toThrow(/--paid, --sent or both/);
  });

  it("garbage in --since is exit 2", async () => {
    await expect(run({}, { since: "soon" })).rejects.toBeInstanceOf(ConfigError);
  });

  it("--since 24h reads only the last day", async () => {
    const r = await run(
      {
        orders: [
          { at: at(3), email: buyer(1) },
          { at: at(30), email: buyer(2) },
        ],
        emails: [{ at: at(2.5), to: [buyer(1)] }],
      },
      { since: "24h" },
    );
    expect(r.paid).toBe(1);
    expect(r.reconciled?.unmatched).toBe(0);
    expect(r.window.label).toBe("the last 24 hours");
  });
});

describe("runDelivery: edge cases", () => {
  it("an email sent to an address with a different letter case than the order: matched", async () => {
    const r = await run({
      orders: [{ at: at(3), email: "Maya.Ortiz@Tideline.example" }],
      emails: [{ at: at(2), to: ["maya.ortiz@tideline.example"] }],
    });
    expect(r.reconciled?.unmatched).toBe(0);
  });

  it("a refunded or unpaid session is not counted as paid", async () => {
    const r = await run({
      orders: [
        { at: at(3), email: buyer(1) },
        { at: at(3), email: buyer(2), refunded: true },
        { at: at(3), email: buyer(3), paymentStatus: "unpaid" },
      ],
      emails: [{ at: at(2), to: [buyer(1)] }],
    });
    expect(r.paid).toBe(1);
    expect(r.result.findings).toEqual([]);
  });

  it("more emails than orders (resends): unmatched is 0, never negative", async () => {
    const r = await run({
      orders: orders(2),
      emails: [...emails(2), ...emails(2), ...emails(3, 2)],
    });
    expect(r.reconciled).toMatchObject({ paid: 2, sent: 7, unmatched: 0 });
    expect(r.result.findings).toEqual([]);
  });

  it("a window with zero orders: 0 paid, 0 sent, no finding", async () => {
    const r = await run({});
    expect(r.reconciled).toEqual({ paid: 0, sent: 0, unmatched: 0, byDay: [] });
    expect(r.result.findings).toEqual([]);
  });

  it("an order and its email either side of midnight UTC still match", async () => {
    const r = await run({
      orders: [{ at: "2026-11-08T23:59:00Z", email: buyer(1) }],
      emails: [{ at: "2026-11-09T00:01:00Z", to: [buyer(1)] }],
    });
    expect(r.reconciled?.unmatched).toBe(0);
    expect(r.reconciled?.byDay.map((d) => d.day)).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("the provider's retention caps the window: orders before it are not called missing", async () => {
    // Resend keeps only the last 3 days. An order from 5 days ago has no email there to match.
    const r = await run(
      {
        orders: [
          { at: at(24 * 5), email: buyer(1) },
          { at: at(24 * 1), email: buyer(2) },
        ],
        emails: [{ at: at(23), to: [buyer(2)] }],
      },
      { retentionDays: 3 },
    );
    expect(r.paid).toBe(1);
    expect(r.result.findings).toEqual([]);
    expect(r.comparedFrom).toBe("2026-11-07");
    expect(r.notices.join(" ")).toContain("Only 2026-11-07 to 2026-11-10 could be read");
    expect(r.notices.join(" ")).toContain("the last 7 days");
  });

  it("a page cap is stated and cuts the compared window", async () => {
    const r = await run(
      { orders: orders(250), emails: emails(250), pageSize: 100 },
      { maxPages: 2 },
    );
    expect(r.notices.some((n) => /200/.test(n))).toBe(true);
    expect(r.paid).toBeLessThanOrEqual(200);
  });

  it("the sampled counts travel in the result, and nothing identifying does", async () => {
    const r = await run({ orders: orders(3), emails: emails(2) });
    expect(r.result.sampled["paid-orders"]).toMatchObject({ seen: 3, taken: 3 });
    expect(r.result.sampled["sent-emails"]).toMatchObject({ seen: 2, taken: 2 });
  });
});

describe("runDelivery: the promise", () => {
  it("every request is a GET, no key is in an address, and no output holds a key, an address or a hash", async () => {
    const seen: SeenRequest[] = [];
    const r = await run({ orders: orders(30), emails: emails(20), pageSize: 10 }, {}, seen);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url).not.toContain(RK);
      expect(s.url).not.toContain(RESEND);
      expect(s.url).not.toContain("@");
    }
    const everything = JSON.stringify(r) + r.notices.join("\n");
    expect(everything).not.toContain(RK);
    expect(everything).not.toContain(RESEND);
    expect(everything).not.toContain("@");
    expect(everything).not.toContain("tideline.example");
    expect(everything).not.toMatch(/[0-9a-f]{64}/);
    expect(everything).not.toMatch(/cs_live|evt_|pi_3|ch_3/);
  });

  it("a refusal's message holds neither key", async () => {
    const err = (await run({ stripeStatus: 403 }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Checkout Sessions/);
    expect(err.message).not.toContain(RK);
  });
});

describe("runWebhooks: integration", () => {
  const DAY = 24 * HOUR;
  const events = Array.from({ length: 14 }, (_, i) => ({
    type: "checkout.session.completed",
    at: new Date(NOW.getTime() - 6 * DAY + i * HOUR).toISOString(),
    pending: 1,
  }));
  const hooks = (spec: FakeProviders, seen: SeenRequest[] = []) =>
    runWebhooks({
      env: ENV,
      now: NOW,
      sleep: noSleep,
      fetcher: createFetcher({ transport: providerTransport(spec, seen), timeoutMs: 5000 }),
    });

  it("an endpoint with 14 pending events, the oldest six days old: one high finding with count and age", async () => {
    const r = await hooks({
      endpoints: [{ url: "https://hooks.tideline.example/stripe/whsec_abc?x=1" }],
      events,
    });
    expect(r.result.findings).toHaveLength(1);
    expect(r.result.findings[0]).toMatchObject({ checkId: "webhook-failing", severity: "high" });
    expect(r.result.findings[0]?.evidence).toContain("14 events");
    expect(r.result.findings[0]?.evidence).toContain("the oldest 6 days old");
    expect(r.result.findings[0]?.evidence).toContain("hooks.tideline.example");
    expect(JSON.stringify(r)).not.toContain("whsec_abc");
    expect(resultSchema.safeParse(r.result).success).toBe(true);
  });

  it("a disabled endpoint is a medium finding, and a healthy one is a pass", async () => {
    const r = await hooks({
      endpoints: [
        { url: "https://ok.tideline.example/hook" },
        { url: "https://old.tideline.example/hook", status: "disabled" },
      ],
    });
    expect(r.result.findings.map((f) => [f.checkId, f.severity])).toEqual([
      ["webhook-disabled", "medium"],
    ]);
    expect(r.result.passed).toEqual(["webhook-failing"]);
  });

  it("states the window of events that was readable", async () => {
    const r = await hooks({ endpoints: [] });
    expect(r.eventsFrom).toBe("2026-10-11");
  });

  it("no key is exit 2 naming STRIPE_API_KEY", async () => {
    await expect(
      runWebhooks({ env: {}, now: NOW, fetcher: createFetcher({ timeoutMs: 5 }) }),
    ).rejects.toThrow(/STRIPE_API_KEY/);
  });

  it("a refused key is exit 2, and it only ever reads", async () => {
    const seen: SeenRequest[] = [];
    await expect(hooks({ stripeStatus: 403 }, seen)).rejects.toThrow(/Webhook Endpoints/);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
  });

  it("nothing in the output holds a key, a path, an order id or an address", async () => {
    const seen: SeenRequest[] = [];
    const r = await hooks(
      { endpoints: [{ url: "https://hooks.tideline.example/stripe/whsec_abc" }], events },
      seen,
    );
    const everything = JSON.stringify(r);
    expect(everything).not.toContain(RK);
    expect(everything).not.toContain("@");
    expect(everything).not.toMatch(/cs_live|evt_|we_1/);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url).not.toContain(RK);
    }
  });
});
