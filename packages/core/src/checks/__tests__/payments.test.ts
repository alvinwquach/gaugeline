// check-community: allow-email (invented addresses at reserved example domains: Zelle emails are a payment detail).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { useCassette } from "../../../../testkit/src/index.js";
import { createFetcher, createNetworkTransport, type Transport } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import {
  ANCHOR_WINDOW,
  PAYMENT_RULES,
  configValue,
  extractPayments,
} from "../../payments/extract.js";
import { paymentsConfigSchema, type PaymentsConfig } from "../../payments/types.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { paymentHandleInconsistent } from "../payment-handle-inconsistent.js";
import { paymentHandleMismatch } from "../payment-handle-mismatch.js";
import { paymentHandleUnknown } from "../payment-handle-unknown.js";
import { paymentLinkDead } from "../payment-link-dead.js";

const PAYMENT_CHECKS = [
  "payment-handle-mismatch",
  "payment-handle-unknown",
  "payment-link-dead",
  "payment-handle-inconsistent",
];

function snap(path: string, body: string): PageSnapshot {
  return buildSnapshot([
    {
      url: `https://pop.example${path}`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

/** kind:value pairs a page shows, in order, deduplicated. */
function found(body: string): string[] {
  return [...new Set(extractPayments(snap("/", body)).map((d) => `${d.kind}:${d.value}`))];
}

const ctxWith = (pages: PageSnapshot[], payments?: PaymentsConfig): CheckContext => ({
  warn: () => undefined,
  pages: async () => pages,
  ...(payments ? { payments } : {}),
});

/** Fixture pages go to the local network; Square and Stripe answer from the recorded cassette. */
function withRecordedProviders(): Transport {
  const local = createNetworkTransport({ allowPrivate: true });
  const recorded = useCassette("payment-links", { mode: "replay" });
  return (url, req) =>
    /(?:^|\.)(?:square\.link|square\.site|stripe\.com)$/.test(url.hostname)
      ? recorded(url, req)
      : local(url, req);
}

describe("payments: unit (the extraction table)", () => {
  // One row per rule in PAYMENT_RULES: the body that must be read, and what it reads as.
  const ROWS: Record<string, [string, string]> = {
    "cashapp-link": ['<a href="https://cash.app/$SolanaTamales">Pay</a>', "cashapp:solanatamales"],
    "cashapp-text": ["<p>Cash App: $SolanaTamales</p>", "cashapp:solanatamales"],
    "venmo-link": ['<a href="https://venmo.com/u/solana-tamales">Pay</a>', "venmo:solana-tamales"],
    "venmo-text": ["<p>Venmo @Solana-Tamales</p>", "venmo:solana-tamales"],
    "paypal-link": [
      '<a href="https://www.paypal.me/SolanaTamales">PayPal</a>',
      "paypal:solanatamales",
    ],
    "zelle-phone": ["<p>Zelle us at (408) 555-0100</p>", "zelle:4085550100"],
    "zelle-email": ["<p>Zelle: pay@solana.example</p>", "zelle:pay@solana.example"],
    "square-link": [
      '<a href="https://square.link/u/Sol4Box9?src=site">Order</a>',
      "square-link:https://square.link/u/Sol4Box9",
    ],
    "square-checkout": [
      '<a href="https://checkout.square.site/merchant/ML1/checkout/AB12/">Order</a>',
      "square-link:https://checkout.square.site/merchant/ML1/checkout/AB12",
    ],
    "stripe-link": [
      '<a href="https://buy.stripe.com/solana-gift-28#x">Gift card</a>',
      "stripe-link:https://buy.stripe.com/solana-gift-28",
    ],
  };

  it("every rule has a row, and every row reads as expected", () => {
    expect(PAYMENT_RULES.map((r) => r.id).sort()).toEqual(Object.keys(ROWS).sort());
    for (const [id, [body, want]] of Object.entries(ROWS)) expect(found(body), id).toEqual([want]);
  });

  it("links written as text are read too, once", () => {
    expect(found("<p>Pay at cash.app/$SolanaTamales or venmo.com/u/solana-tamales</p>")).toEqual([
      "cashapp:solanatamales",
      "venmo:solana-tamales",
    ]);
  });

  it(`text handles need the provider's name within ${ANCHOR_WINDOW} characters, in the same sentence`, () => {
    expect(found("<p>Follow us @solana-tamales</p>")).toEqual([]);
    expect(found(`<p>Venmo${" x".repeat(ANCHOR_WINDOW / 2)} @solana-tamales</p>`)).toEqual([]);
    expect(found(`<p>Venmo${" x".repeat(ANCHOR_WINDOW / 2 - 2)} @solana-tamales</p>`)).toEqual([
      "venmo:solana-tamales",
    ]);
    // A block, a sentence or a list separator ends the window.
    expect(found("<p>Venmo</p><p>@solana-tamales</p>")).toEqual([]);
    expect(found("<p>Instagram: @solana · Venmo: @solana-pay</p>")).toEqual(["venmo:solana-pay"]);
  });

  it("phone normalisation for Zelle: (408) 555-0100, 408.555.0100 and +1 408 555 0100 are equal", () => {
    expect(found("<p>Zelle (408) 555-0100</p>")).toEqual(["zelle:4085550100"]);
    expect(found("<p>Zelle 408.555.0100</p>")).toEqual(["zelle:4085550100"]);
    expect(found("<p>Zelle +1 408 555 0100</p>")).toEqual(["zelle:4085550100"]);
    expect(configValue("zelle", "+1 (408) 555-0100")).toBe("4085550100");
  });

  it("a handle inside an image alt or an aria-label is still found", () => {
    const p = snap(
      "/",
      '<img src="/qr.png" alt="Venmo QR code for @solana-tamales"><button aria-label="Pay $SolanaTamales on Cash App">Pay</button>',
    );
    expect(extractPayments(p).map((d) => [d.kind, d.value, d.source])).toEqual([
      ["venmo", "solana-tamales", "image description"],
      ["cashapp", "solanatamales", "label"],
    ]);
  });

  it("configured values are read like the page: a handle, its link, or either spelling", () => {
    expect(configValue("venmo", "https://venmo.com/u/Solana-Tamales")).toBe("solana-tamales");
    expect(configValue("cashapp", "$SolanaTamales")).toBe("solanatamales");
    expect(configValue("square-link", "square.link/u/Sol4Box9")).toBe(
      "https://square.link/u/Sol4Box9",
    );
    expect(configValue("venmo", "not a handle!")).toBeUndefined();
  });

  it("the config schema accepts each kind and rejects an unknown kind or an unreadable value", () => {
    const ok = paymentsConfigSchema.safeParse({
      payments: [
        { kind: "venmo", value: "@solana-tamales", label: "Venmo" },
        { kind: "stripe-link", value: "https://buy.stripe.com/solana-gift-28" },
      ],
    });
    expect(ok.success).toBe(true);
    expect(
      paymentsConfigSchema.safeParse({ payments: [{ kind: "bitcoin", value: "x" }] }).success,
    ).toBe(false);
    const bad = paymentsConfigSchema.safeParse({ payments: [{ kind: "zelle", value: "call us" }] });
    expect(bad.error?.issues[0]?.message).toBe('"call us" is not a zelle phone number or email');
  });
});

describe("payments: integration (the payments-popup fixture, recorded provider answers)", () => {
  it("a stale Venmo handle on the Spanish page, an unknown PayPal and a deactivated Stripe link", async () => {
    const site = await startFixture("payments-popup");
    try {
      const payments = paymentsConfigSchema.parse(
        JSON.parse(readFileSync(`${SITES_DIR}payments-popup/gaugeline.payments.json`, "utf8")),
      );
      const fetcher = createFetcher({ transport: withRecordedProviders(), timeoutMs: 5000 });
      const { result, budget } = await checkSite({
        address: site.origin,
        fetcher,
        only: PAYMENT_CHECKS,
        payments,
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "payment-handle-mismatch",
          "high",
          'Venmo "@solana-tamale" on /es/ ("Paga con Venmo: @solana-tamale"); configured "@solana-tamales"',
        ],
        [
          "payment-handle-unknown",
          "high",
          'PayPal "paypal.me/solanatamales" on /order ("or with PayPal at paypal.me/solanatamales"), not configured',
        ],
        [
          "payment-link-dead",
          "high",
          'Stripe link https://buy.stripe.com/solana-gift-28 on 3 pages (/, /order, /es/) says "This link is no longer active"',
        ],
      ]);
      expect(budget.summary().checkoutLinks).toEqual({ limit: 5, sampled: 2, found: 2 });
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("a deactivated payment link page per provider, and a 404", async () => {
    const fetcher = createFetcher({ transport: useCassette("payment-links", { mode: "replay" }) });
    const p = snap(
      "/",
      [
        '<a href="https://square.link/u/OldBox01">Old box</a>',
        '<a href="https://buy.stripe.com/solana-gift-28">Gift</a>',
        '<a href="https://buy.stripe.com/gone-404">Gone</a>',
        '<a href="https://square.link/u/Sol4Box9">Box</a>',
      ].join(" "),
    );
    const out = await paymentLinkDead.run(p, {
      warn: () => undefined,
      fetcher,
      budget: createBudget(),
    });
    expect(out.map((f) => f.evidence)).toEqual([
      'Square link https://square.link/u/OldBox01 on / says "This link is no longer active"',
      'Stripe link https://buy.stripe.com/solana-gift-28 on / says "This link is no longer active"',
      "Stripe link https://buy.stripe.com/gone-404 on / returned 404",
    ]);
  });
});

describe("payments: edge cases", () => {
  const footer = (handle: string) => `<footer><p>Venmo: ${handle}</p></footer>`;

  it("a wrong handle in a footer on 40 pages is one finding listing the pages", async () => {
    const pages = Array.from({ length: 40 }, (_, i) =>
      snap(i === 0 ? "/" : `/p${i}`, footer("@solana-tamale")),
    );
    const config = paymentsConfigSchema.parse({
      payments: [{ kind: "venmo", value: "@solana-tamales" }],
    });
    const out = await paymentHandleMismatch.run(pages[0] as PageSnapshot, ctxWith(pages, config));
    expect(out.map((f) => f.evidence)).toEqual([
      'Venmo "@solana-tamale" on 40 pages (/, /p1, /p2 and 37 more) ("Venmo: @solana-tamale"); configured "@solana-tamales"',
    ]);
  });

  it('"$12" (a price) is never read as a Cash App tag', () => {
    expect(found("<p>Tamal box $12, pay with Cash App: $SolanaTamales</p>")).toEqual([
      "cashapp:solanatamales",
    ]);
    expect(found("<p>Cash App $12 · $12.50 · $5k</p>")).toEqual([]);
  });

  it("an email near the word Zelle is read; an unrelated contact email is not", () => {
    expect(
      found(
        "<footer><p>Zelle: pay@solana.example. Questions? Write to hello@solana.example</p></footer>",
      ),
    ).toEqual(["zelle:pay@solana.example"]);
    expect(found("<p>Questions? hello@solana.example</p>")).toEqual([]);
  });

  it("with no config, one kind with two values across pages is payment-handle-inconsistent", async () => {
    const pages = [snap("/", footer("@solana-tamales")), snap("/es/", footer("@solana-tamale"))];
    const out = await paymentHandleInconsistent.run(pages[0] as PageSnapshot, ctxWith(pages));
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ["medium", 'Venmo has 2 values: "@solana-tamales" on /; "@solana-tamale" on /es/'],
    ]);
    // With a config, the configured value decides instead.
    const config = paymentsConfigSchema.parse({
      payments: [{ kind: "venmo", value: "@solana-tamales" }],
    });
    expect(
      await paymentHandleInconsistent.run(pages[0] as PageSnapshot, ctxWith(pages, config)),
    ).toEqual([]);
  });

  it("a configured kind that differs is a mismatch; a kind nobody configured is unknown", async () => {
    const page = snap("/", "<p>Venmo: @someone-else · Cash App: $SolanaTamales</p>");
    const config = paymentsConfigSchema.parse({
      payments: [{ kind: "venmo", value: "@solana-tamales" }],
    });
    expect(
      (await paymentHandleMismatch.run(page, ctxWith([page], config))).map((f) => f.evidence),
    ).toEqual([
      'Venmo "@someone-else" on / ("Venmo: @someone-else"); configured "@solana-tamales"',
    ]);
    expect(
      (await paymentHandleUnknown.run(page, ctxWith([page], config))).map((f) => f.evidence),
    ).toEqual(['Cash App "$SolanaTamales" on / ("Cash App: $SolanaTamales"), not configured']);
  });

  it("a page with no payment details and no config requests no other pages", async () => {
    let asked = 0;
    const page = snap("/", "<p>Tamales on Saturday.</p>");
    const ctx: CheckContext = {
      warn: () => undefined,
      pages: async () => {
        asked += 1;
        return [page];
      },
    };
    expect(await paymentHandleInconsistent.run(page, ctx)).toEqual([]);
    expect(await paymentHandleUnknown.run(page, ctx)).toEqual([]);
    expect(asked).toBe(0);
  });
});
