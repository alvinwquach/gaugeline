import { describe, expect, it } from "vitest";
import { runChecks } from "../../run.js";
import {
  RECEIPT_CHECKS,
  WEBHOOK_CHECKS,
  createReceiptRegistry,
  createWebhookRegistry,
  deliveryReceiptMissing,
  webhookDisabled,
  webhookFailing,
  type ReceiptInput,
} from "../delivery.js";

const CTX = { warn: () => undefined };
const input = (unmatched: number, paid = 12, sent = 9): ReceiptInput => ({
  reconciled: {
    paid,
    sent,
    unmatched,
    byDay: [
      { day: "2026-11-08", paid: 4, sent: 2 },
      { day: "2026-11-09", paid: 8, sent: 7 },
    ],
  },
  window: "the last 7 days",
  comparedFrom: "2026-11-03",
  comparedTo: "2026-11-10",
});

describe("delivery-receipt-missing: unit", () => {
  it("is high, and says the counts and the days: 12 paid, 9 sent", async () => {
    const [f, ...rest] = await deliveryReceiptMissing.run(input(3), CTX);
    expect(rest).toEqual([]);
    expect(f?.severity).toBe("high");
    expect(f?.checkId).toBe("delivery-receipt-missing");
    expect(f?.evidence).toMatch(
      /^12 paid, 9 sent in the last 7 days \(2026-11-03 to 2026-11-10 UTC\)/,
    );
    expect(f?.evidence).toContain("3 paid orders have no matching email");
    expect(f?.evidence).toContain("2026-11-08 (4 paid, 2 sent)");
    expect(f?.evidence).toContain("2026-11-09 (8 paid, 7 sent)");
  });

  it("one order is singular", async () => {
    const [f] = await deliveryReceiptMissing.run(input(1, 5, 4), CTX);
    expect(f?.evidence).toContain("1 paid order has no matching email");
  });

  it("no unmatched orders: no finding", async () => {
    expect(await deliveryReceiptMissing.run(input(0, 9, 12), CTX)).toEqual([]);
  });

  it("lists at most ten days and counts the rest", async () => {
    const byDay = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-10-${String(10 + i).padStart(2, "0")}`,
      paid: 2,
      sent: 1,
    }));
    const [f] = await deliveryReceiptMissing.run(
      { ...input(14, 28, 14), reconciled: { paid: 28, sent: 14, unmatched: 14, byDay } },
      CTX,
    );
    expect(f?.evidence).toContain("and 4 more");
  });

  it("a mismatch by recipient with equal days adds no day sentence", async () => {
    const [f] = await deliveryReceiptMissing.run(
      {
        ...input(1, 2, 2),
        reconciled: {
          paid: 2,
          sent: 2,
          unmatched: 1,
          byDay: [{ day: "2026-11-08", paid: 2, sent: 2 }],
        },
      },
      CTX,
    );
    expect(f?.evidence).not.toContain("Paid is above sent");
  });
});

describe("webhook checks: unit", () => {
  const endpoint = (extra = {}) => ({
    host: "hooks.tideline.example",
    enabled: true,
    undelivered: 14,
    oldestAgeSeconds: 6 * 86400,
    ...extra,
  });

  it("webhook-failing: high, with the host, the count and the oldest age", async () => {
    const [f, ...rest] = await webhookFailing.run({ endpoints: [endpoint()] }, CTX);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ checkId: "webhook-failing", severity: "high" });
    expect(f?.evidence).toBe(
      "hooks.tideline.example: 14 events older than 1 hour not delivered, the oldest 6 days old.",
    );
  });

  it("webhook-failing: nothing for a clean, a disabled or an empty endpoint", async () => {
    for (const e of [
      endpoint({ undelivered: 0, oldestAgeSeconds: null }),
      endpoint({ enabled: false, undelivered: 0, oldestAgeSeconds: null }),
    ])
      expect(await webhookFailing.run({ endpoints: [e] }, CTX)).toEqual([]);
  });

  it("webhook-disabled: medium, for a disabled endpoint only", async () => {
    const findings = await webhookDisabled.run(
      {
        endpoints: [
          endpoint(),
          endpoint({
            host: "old.tideline.example",
            enabled: false,
            undelivered: 0,
            oldestAgeSeconds: null,
          }),
        ],
      },
      CTX,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: "webhook-disabled", severity: "medium" });
    expect(findings[0]?.evidence).toBe(
      "old.tideline.example is disabled, so Stripe sends it no events.",
    );
  });

  it("an invisible character in a host is shown as an escape", async () => {
    const [f] = await webhookFailing.run(
      { endpoints: [endpoint({ host: "a\u202Eb.example" })] },
      CTX,
    );
    expect(f?.evidence).not.toContain("\u202E");
    expect(f?.evidence).toContain("\\u{202E}");
  });
});

describe("the registries", () => {
  it("hold exactly the three ids, each with the four texts the reference prints", () => {
    expect([...RECEIPT_CHECKS, ...WEBHOOK_CHECKS].map((c) => c.id)).toEqual([
      "delivery-receipt-missing",
      "webhook-failing",
      "webhook-disabled",
    ]);
    for (const c of [...RECEIPT_CHECKS, ...WEBHOOK_CHECKS])
      for (const f of ["what", "why", "fix", "tech"] as const)
        expect(c[f].length).toBeGreaterThan(20);
  });

  it("a clean run passes the check, and a finding does not", async () => {
    const clean = await runChecks(input(0), createReceiptRegistry());
    expect(clean.passed).toEqual(["delivery-receipt-missing"]);
    const dirty = await runChecks(input(3), createReceiptRegistry());
    expect(dirty.passed).toEqual([]);
    expect(dirty.findings).toHaveLength(1);
    const hooks = await runChecks({ endpoints: [] }, createWebhookRegistry());
    expect(hooks.passed).toEqual(["webhook-failing", "webhook-disabled"]);
  });
});
