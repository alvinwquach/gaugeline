import { describe, expect, it } from "vitest";
import type { StripePrice, StripeProduct } from "../../connectors/stripe.js";
import type { Finding } from "../../model.js";
import { PLAN_METADATA_KEY } from "../../plans/config.js";
import type { PagePlan } from "../../plans/read.js";
import { readHarbor } from "../../plans/__tests__/plan-store.js";
import { runChecks, type RunResult } from "../../run.js";
import {
  SUBSCRIPTION_CHECKS,
  SUBSCRIPTION_CHECK_IDS,
  createSubscriptionRegistry,
  type SubscriptionCheckInput,
} from "../plans.js";

// ---- builders -----------------------------------------------------------------------------------

const USD = ["usd", "cad", "aud", "nzd", "mxn", "sgd", "hkd"];

const shown = (text: string, mark = "$", currencies = USD) => ({
  text,
  shown: `${mark}${text}`,
  currencies,
});

const plan = (name: string, extra: Partial<PagePlan> = {}): PagePlan => ({
  id: name.toLowerCase(),
  name,
  url: "https://studio.example/plans",
  state: "found",
  heading: name,
  amount: shown("49"),
  cadence: { unit: "month", count: 1 },
  cadenceUnclear: false,
  trial: null,
  tax: null,
  promo: false,
  ...extra,
});

const price = (id: string, extra: Partial<StripePrice> = {}): StripePrice => ({
  id,
  unitAmount: 4900,
  currency: "usd",
  active: true,
  recurring: { interval: "month", intervalCount: 1, trialPeriodDays: null },
  ...extra,
});

const product = (
  id: string,
  name: string,
  prices: StripePrice[],
  extra: Partial<StripeProduct> = {},
): StripeProduct => ({
  id,
  name,
  active: true,
  metadata: {},
  defaultPriceId: prices[0]?.id ?? null,
  prices,
  ...extra,
});

/** One plan "Pro" with the page's reading, against one Stripe product "Pro" with one price. */
function run(
  planExtra: Partial<PagePlan>,
  priceExtra: Partial<StripePrice> = {},
  input: Partial<SubscriptionCheckInput> = {},
): Promise<RunResult> {
  return runChecks(
    {
      plans: [plan("Pro", planExtra)],
      stripe: [product("prod_pro", "Pro", [price("price_pro", priceExtra)])],
      ...input,
    },
    createSubscriptionRegistry(),
  );
}

const only = (r: RunResult, id: string): Finding[] => r.findings.filter((f) => f.checkId === id);
const notes = (r: RunResult, id: string): string[] =>
  r.couldNotCheck.filter((c) => c.id === id).map((c) => c.reason);

// ---- unit ---------------------------------------------------------------------------------------

describe("subscription checks: registration", () => {
  it("five checks, in id order, in Sales & prices, with every line of the reference", () => {
    expect(SUBSCRIPTION_CHECKS.map((c) => c.id)).toEqual([...SUBSCRIPTION_CHECK_IDS]);
    expect(SUBSCRIPTION_CHECKS.map((c) => c.severity)).toEqual([
      "high",
      "high",
      "low",
      "high",
      "medium",
    ]);
    for (const c of SUBSCRIPTION_CHECKS) {
      expect(c.area).toBe("Sales & prices");
      for (const field of ["title", "what", "why", "fix", "tech"] as const)
        expect(c[field].trim()).not.toBe("");
      expect(`${c.title} ${c.what} ${c.why} ${c.fix}`).not.toMatch(
        /is (the )?(right|correct|wrong)|should win|source of truth/i,
      );
    }
    expect(createSubscriptionRegistry().size).toBe(5);
  });
});

describe("plan-price-mismatch", () => {
  it("fires when the amounts differ, quoting both and the rule", async () => {
    const r = await run({ amount: shown("59") });
    const [f] = only(r, "plan-price-mismatch");
    expect(only(r, "plan-price-mismatch")).toHaveLength(1);
    expect(f?.severity).toBe("high");
    expect(f?.evidence).toContain("$59");
    expect(f?.evidence).toContain("49.00 USD");
    expect(f?.evidence).toContain("price_pro");
    expect(f?.evidence).toContain("matched by name");
    expect(f?.url).toBe("https://studio.example/plans");
  });

  it("is silent when the amounts agree", async () => {
    const r = await run({});
    expect(r.findings).toEqual([]);
    expect(r.passed).toEqual(
      expect.arrayContaining([
        ...SUBSCRIPTION_CHECK_IDS.filter((i) => i !== "plan-missing-on-page"),
      ]),
    );
  });

  it("reads a yen price as whole yen and a dinar price with three places", async () => {
    const yen = await run(
      { amount: { text: "5000", shown: "\u00A55000", currencies: ["jpy", "cny"] } },
      { unitAmount: 5000, currency: "jpy" },
    );
    expect(yen.findings).toEqual([]);
    const dinar = await run(
      { amount: { text: "4.9", shown: "4.9 KWD", currencies: ["kwd"] } },
      { unitAmount: 4900, currency: "kwd" },
    );
    expect(dinar.findings).toEqual([]);
  });

  it("explains a price Stripe has no fixed amount for, without a finding", async () => {
    const r = await run({}, { unitAmount: null });
    expect(only(r, "plan-price-mismatch")).toEqual([]);
    expect(notes(r, "plan-price-mismatch")[0]).toContain("no fixed amount");
  });

  it("a plan with no matching price is a notice", async () => {
    const r = await run({}, {}, { stripe: [] });
    expect(r.findings).toEqual([]);
    expect(notes(r, "plan-price-mismatch")[0]).toContain("no Stripe price to compare with");
  });

  it("a plan that is not on the page is a notice", async () => {
    const r = await run({ state: "missing" });
    expect(r.findings).toEqual([]);
    expect(notes(r, "plan-price-mismatch")[0]).toContain("was not found on the page");
  });

  it("a page with no price next to the plan is a notice", async () => {
    const r = await run({ amount: null });
    expect(only(r, "plan-price-mismatch")).toEqual([]);
    expect(notes(r, "plan-price-mismatch")[0]).toContain("shows no price");
  });
});

describe("plan-price-mismatch: tax, currencies and coupons", () => {
  it("equal amounts, but the page says tax is included and Stripe adds it: a finding about tax", async () => {
    const r = await run({ tax: "inclusive" }, { taxBehavior: "exclusive" });
    const [f] = only(r, "plan-price-mismatch");
    expect(f?.evidence).toContain("the same amount");
    expect(f?.evidence).toContain("tax is included");
    expect(f?.evidence).toContain("tax exclusive");
  });

  it("equal amounts and the same tax display agree; an unsaid side is not a difference", async () => {
    expect((await run({ tax: "exclusive" }, { taxBehavior: "exclusive" })).findings).toEqual([]);
    expect((await run({ tax: "inclusive" }, {})).findings).toEqual([]);
    expect((await run({ tax: null }, { taxBehavior: "exclusive" })).findings).toEqual([]);
  });

  it("different amounts are reported with the tax note when tax also differs", async () => {
    const r = await run({ amount: shown("59"), tax: "exclusive" }, { taxBehavior: "inclusive" });
    expect(only(r, "plan-price-mismatch")[0]?.evidence).toContain("tax is extra");
  });

  it("never converts: a euro page against a dollar price is a notice", async () => {
    const r = await run({ amount: shown("49", "\u20AC", ["eur"]) });
    expect(only(r, "plan-price-mismatch")).toEqual([]);
    expect(notes(r, "plan-price-mismatch")[0]).toContain("never converts");
  });

  it("a price with several currencies is compared in the one the page shows", async () => {
    const options = { currencyOptions: { eur: 4500 } };
    const agree = await run({ amount: shown("45", "\u20AC", ["eur"]) }, options);
    expect(agree.findings).toEqual([]);
    const differ = await run({ amount: shown("49", "\u20AC", ["eur"]) }, options);
    expect(only(differ, "plan-price-mismatch")[0]?.evidence).toContain("45.00 EUR");
  });

  it("a dollar sign is any dollar currency: it meets Stripe's Canadian dollars", async () => {
    expect((await run({}, { currency: "cad" })).findings).toEqual([]);
  });

  it("a coupon shown as the price ('first month $1') is could-not-check unless configured", async () => {
    const r = await run({ amount: shown("1"), promo: true });
    expect(only(r, "plan-price-mismatch")).toEqual([]);
    expect(notes(r, "plan-price-mismatch")[0]).toContain("introAmount");
  });

  it("an amount with more places than the currency has is a notice, not a guess", async () => {
    const r = await run({ amount: shown("49.123") });
    expect(only(r, "plan-price-mismatch")).toEqual([]);
    expect(notes(r, "plan-price-mismatch")[0]).toContain("not a whole amount");
  });
});

describe("plan-interval-mismatch", () => {
  it("fires when the page says per month and Stripe bills yearly", async () => {
    const r = await run(
      {},
      { recurring: { interval: "year", intervalCount: 1, trialPeriodDays: null } },
    );
    const [f] = only(r, "plan-interval-mismatch");
    expect(f?.severity).toBe("high");
    expect(f?.evidence).toContain("every month");
    expect(f?.evidence).toContain("every year");
  });

  it("fires for every 3 months against monthly, and for a one-time price", async () => {
    const quarter = await run(
      { cadence: { unit: "month", count: 1 } },
      { recurring: { interval: "month", intervalCount: 3, trialPeriodDays: null } },
    );
    expect(only(quarter, "plan-interval-mismatch")[0]?.evidence).toContain("every 3 months");
    // A one-time price is reached only by its configured id: the other rules look at subscriptions.
    const once = await run({ priceId: "price_pro" }, { recurring: undefined });
    expect(only(once, "plan-interval-mismatch")[0]?.evidence).toContain("one-time price");
  });

  it("12 months and a year agree", async () => {
    const r = await run(
      { cadence: { unit: "month", count: 12 } },
      { recurring: { interval: "year", intervalCount: 1, trialPeriodDays: null } },
    );
    expect(only(r, "plan-interval-mismatch")).toEqual([]);
  });

  it("is a notice when the card names no interval or two", async () => {
    const none = await run({ cadence: null });
    expect(notes(none, "plan-interval-mismatch")[0]).toContain("does not say how often");
    const two = await run({ cadence: null, cadenceUnclear: true });
    expect(notes(two, "plan-interval-mismatch")[0]).toContain("two different billing intervals");
    expect(only(two, "plan-interval-mismatch")).toEqual([]);
  });
});

describe("plan-trial-mismatch", () => {
  const seven = { trial: { min: 7, max: 7 } };
  const trial = (days: number | null) => ({
    recurring: { interval: "month" as const, intervalCount: 1, trialPeriodDays: days },
  });

  it("fires when the page promises a trial Stripe does not apply", async () => {
    const r = await run(seven, trial(null));
    expect(only(r, "plan-trial-mismatch")[0]?.severity).toBe("medium");
    expect(only(r, "plan-trial-mismatch")[0]?.evidence).toContain("7-day trial");
    expect(only(r, "plan-trial-mismatch")[0]?.evidence).toContain("has no trial");
  });

  it("fires the other way: Stripe gives a trial the page never mentions", async () => {
    const r = await run({}, trial(14));
    expect(only(r, "plan-trial-mismatch")[0]?.evidence).toContain(
      "14-day trial and the page does not mention",
    );
  });

  it("fires when the lengths differ, and not when they agree", async () => {
    expect(only(await run(seven, trial(14)), "plan-trial-mismatch")).toHaveLength(1);
    expect(await run(seven, trial(7))).toMatchObject({ findings: [] });
  });

  it("a month's trial agrees with 30 and 31 days, not 14", async () => {
    const month = { trial: { min: 28, max: 31 } };
    expect((await run(month, trial(30))).findings).toEqual([]);
    expect(only(await run(month, trial(14)), "plan-trial-mismatch")).toHaveLength(1);
  });
});

describe("plan-archived", () => {
  it("fires when the matched price is inactive, and skips the other comparisons", async () => {
    const r = await run({ amount: shown("59") }, { active: false });
    expect(only(r, "plan-archived")).toHaveLength(1);
    expect(only(r, "plan-archived")[0]?.severity).toBe("high");
    expect(only(r, "plan-archived")[0]?.evidence).toContain("archived");
    expect(r.findings).toHaveLength(1);
  });

  it("is silent for an active price", async () => {
    expect(only(await run({}), "plan-archived")).toEqual([]);
  });
});

describe("plan-missing-on-page", () => {
  const stripe = [
    product("prod_pro", "Pro", [
      price("price_m"),
      price("price_y", {
        unitAmount: 49000,
        recurring: { interval: "year", intervalCount: 1, trialPeriodDays: null },
      }),
      price("price_old", { active: false }),
    ]),
  ];

  it("fires for an active subscription price of a configured product that no plan stands for", async () => {
    const r = await run(
      { cadence: { unit: "month", count: 1 } },
      {},
      { stripe, products: ["prod_pro"] },
    );
    const [f] = only(r, "plan-missing-on-page");
    expect(only(r, "plan-missing-on-page")).toHaveLength(1);
    expect(f?.severity).toBe("low");
    expect(f?.evidence).toContain("price_y");
    expect(f?.evidence).not.toContain("price_m ");
    expect(f?.evidence).not.toContain("price_old");
    expect(f?.url).toBe("stripe:prod_pro");
  });

  it("says nothing for a product that is not configured, an archived one, or one fully on the page", async () => {
    expect(only(await run({}, {}, { stripe }), "plan-missing-on-page")).toEqual([]);
    const archived = [{ ...stripe[0]!, active: false }];
    expect(
      only(await run({}, {}, { stripe: archived, products: ["prod_pro"] }), "plan-missing-on-page"),
    ).toEqual([]);
    const whole = [product("prod_pro", "Pro", [price("price_m")])];
    expect(
      only(await run({}, {}, { stripe: whole, products: ["prod_pro"] }), "plan-missing-on-page"),
    ).toEqual([]);
  });

  it("a configured product Stripe did not return is a notice", async () => {
    const r = await run({}, {}, { products: ["prod_nowhere"] });
    expect(notes(r, "plan-missing-on-page")[0]).toContain("prod_nowhere");
  });
});

describe("matching order in the checks", () => {
  it("the configured price id is used before the name", async () => {
    const stripe = [
      product("prod_pro", "Pro", [price("price_name", { unitAmount: 5900 })]),
      product("prod_other", "Other", [price("price_id")]),
    ];
    const r = await runChecks(
      { plans: [plan("Pro", { priceId: "price_id" })], stripe },
      createSubscriptionRegistry(),
    );
    expect(r.findings).toEqual([]);
  });

  it("metadata is used before the name", async () => {
    const stripe = [
      product("prod_pro", "Pro", [price("price_name", { unitAmount: 5900 })]),
      product("prod_x", "Elsewhere", [price("price_meta")], {
        metadata: { [PLAN_METADATA_KEY]: "pro" },
      }),
    ];
    const r = await runChecks({ plans: [plan("Pro")], stripe }, createSubscriptionRegistry());
    expect(r.findings).toEqual([]);
  });
});

describe("evidence is escaped", () => {
  it("a plan name with a control character or invisible character is printed as an escape", async () => {
    const r = await runChecks(
      {
        plans: [plan("Pro\u200B\u0007", { amount: shown("59") })],
        stripe: [product("prod_pro", "Pro", [price("price_pro")])],
      },
      createSubscriptionRegistry(),
    );
    const evidence = only(r, "plan-price-mismatch")[0]?.evidence ?? "";
    expect(evidence).toContain("\\u{200B}");
    expect(evidence).not.toContain("\u200B");
    expect(evidence).not.toContain("\u0007");
  });
});

// ---- integration: recorded Stripe responses -----------------------------------------------------

describe("Harbor Street Yoga: three tiers, one with the wrong interval, one archived", () => {
  it("finds the interval, the archived price and the yearly price nobody put on the page", async () => {
    const { plans, stripe } = await readHarbor();
    expect(plans.map((p) => [p.name, p.state, p.amount?.text, p.cadence?.unit])).toEqual([
      ["Foundation", "found", "49", "month"],
      ["Momentum", "found", "129", "month"],
      ["Elite", "found", "249", "month"],
    ]);
    const r = await runChecks(
      { plans, stripe, products: ["prod_HarborFoundation"] },
      createSubscriptionRegistry(),
    );
    expect(r.findings.map((f) => f.checkId)).toEqual([
      "plan-archived",
      "plan-interval-mismatch",
      "plan-missing-on-page",
    ]);
    expect(r.findings[0]?.evidence).toContain('"Elite"');
    expect(r.findings[1]?.evidence).toContain('"Momentum"');
    expect(r.findings[2]?.evidence).toContain("price_HarborFound49000");
    expect(r.passed).toEqual(
      expect.arrayContaining(["plan-price-mismatch", "plan-trial-mismatch"]),
    );
  });
});
