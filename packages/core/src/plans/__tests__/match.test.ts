import { describe, expect, it } from "vitest";
import type { StripePrice, StripeProduct } from "../../connectors/stripe.js";
import { TIERS } from "../../products/match.js";
import { plansConfigSchema, PLAN_METADATA_KEY } from "../config.js";
import { PLAN_TIERS, matchPlans } from "../match.js";
import { readPagePlans, type PagePlan, type PlanPage } from "../read.js";

const recurring = (interval: "month" | "year", id: string, extra: Partial<StripePrice> = {}) =>
  ({
    id,
    unitAmount: interval === "month" ? 4900 : 49000,
    currency: "usd",
    active: true,
    recurring: { interval, intervalCount: 1, trialPeriodDays: null },
    ...extra,
  }) satisfies StripePrice;

const product = (
  id: string,
  name: string,
  prices: StripePrice[],
  extra: Partial<StripeProduct> = {},
) =>
  ({
    id,
    name,
    active: true,
    metadata: {},
    defaultPriceId: prices[0]?.id ?? null,
    prices,
    ...extra,
  }) satisfies StripeProduct;

const plan = (name: string, extra: Partial<PagePlan> = {}): PagePlan => ({
  id: name.toLowerCase(),
  name,
  url: "https://shop.example/plans",
  state: "found",
  heading: name,
  amount: null,
  cadence: null,
  cadenceUnclear: false,
  trial: null,
  tax: null,
  promo: false,
  ...extra,
});

describe("matchPlans: the product matcher's order, without SKU", () => {
  it("is the product matcher's TIERS, in its order, minus sku", () => {
    expect(PLAN_TIERS).toEqual(TIERS.filter((t) => t !== "sku"));
    expect([...PLAN_TIERS]).toEqual(["saved-id", "metadata-id", "name"]);
  });

  it("the configured price id wins over metadata and name", () => {
    const stripe = [
      product("prod_a", "Pro", [recurring("month", "price_a")], {
        metadata: { [PLAN_METADATA_KEY]: "pro" },
      }),
      product("prod_b", "Other", [recurring("month", "price_b")]),
    ];
    const [m] = matchPlans([plan("Pro", { priceId: "price_b" })], stripe).matches;
    expect([m?.tier, m?.price?.id]).toEqual(["saved-id", "price_b"]);
  });

  it("metadata wins over the name", () => {
    const stripe = [
      product("prod_a", "Pro", [recurring("month", "price_a")]),
      product("prod_b", "Something else", [recurring("month", "price_b")], {
        metadata: { [PLAN_METADATA_KEY]: "pro" },
      }),
    ];
    const [m] = matchPlans([plan("Pro")], stripe).matches;
    expect([m?.tier, m?.price?.id]).toEqual(["metadata-id", "price_b"]);
  });

  it("falls back to the name, ignoring case, accents and punctuation", () => {
    const stripe = [product("prod_a", "PRO!", [recurring("month", "price_a")])];
    const [m] = matchPlans([plan("Pr\u00F3")], stripe).matches;
    expect([m?.tier, m?.price?.id]).toEqual(["name", "price_a"]);
  });

  it("a configured id that Stripe does not have falls through to the next rule", () => {
    const stripe = [product("prod_a", "Pro", [recurring("month", "price_a")])];
    const [m] = matchPlans([plan("Pro", { priceId: "price_gone" })], stripe).matches;
    expect([m?.tier, m?.price?.id]).toEqual(["name", "price_a"]);
  });

  it("the name rule looks only at products that have a subscription price", () => {
    const oneTime = product("prod_a", "Pro", [
      { id: "price_a", unitAmount: 100, currency: "usd", active: true },
    ]);
    expect(matchPlans([plan("Pro")], [oneTime]).matches[0]?.price).toBeUndefined();
  });

  it("picks the price that bills as often as the page says, then the amount, then the default", () => {
    const stripe = [
      product("prod_a", "Pro", [recurring("year", "price_y"), recurring("month", "price_m")]),
    ];
    const byCadence = matchPlans([plan("Pro", { cadence: { unit: "month", count: 1 } })], stripe);
    expect(byCadence.matches[0]?.price?.id).toBe("price_m");
    const two = [
      product("prod_a", "Pro", [
        recurring("month", "price_1", { unitAmount: 5900 }),
        recurring("month", "price_2"),
      ]),
    ];
    const amount = { text: "49.00", shown: "$49", currencies: ["usd"] };
    expect(matchPlans([plan("Pro", { amount })], two).matches[0]?.price?.id).toBe("price_2");
    expect(matchPlans([plan("Pro")], two).matches[0]?.price?.id).toBe("price_1");
  });

  it("prefers an active price and uses an archived one only when it is the only one", () => {
    const stripe = [
      product("prod_a", "Pro", [
        recurring("month", "price_old", { active: false }),
        recurring("month", "price_new"),
      ]),
      product("prod_b", "Gone", [recurring("month", "price_dead", { active: false })]),
    ];
    expect(matchPlans([plan("Pro")], stripe).matches[0]?.price?.id).toBe("price_new");
    expect(matchPlans([plan("Gone")], stripe).matches[0]?.price?.active).toBe(false);
  });

  it("gives each price to one plan: two plans on one product take its two prices", () => {
    const stripe = [
      product("prod_a", "Pro", [recurring("month", "price_m"), recurring("year", "price_y")]),
    ];
    const r = matchPlans(
      [
        plan("Pro", { cadence: { unit: "year", count: 1 } }),
        plan("Pro", { cadence: { unit: "month", count: 1 } }),
      ],
      stripe,
    );
    expect(r.matches.map((m) => m.price?.id)).toEqual(["price_y", "price_m"]);
    expect(r.matches.map((m) => m.price?.id).includes(undefined)).toBe(false);
  });

  it("a price another plan has taken ends the search and says so", () => {
    const stripe = [product("prod_a", "Pro", [recurring("month", "price_m")])];
    const r = matchPlans([plan("Pro"), plan("Pro")], stripe);
    expect(r.matches[1]?.price).toBeUndefined();
    expect(r.matches[1]?.why).toContain("belongs to another plan");
  });

  it("does not match a plan that is not on the page", () => {
    const stripe = [product("prod_a", "Pro", [recurring("month", "price_m")])];
    const r = matchPlans([plan("Pro", { state: "missing" })], stripe);
    expect(r.matches).toEqual([]);
    expect(r.claimed.size).toBe(0);
  });
});

describe("readPagePlans", () => {
  const config = plansConfigSchema.parse({
    plans: [
      { name: "Starter", page: "/plans" },
      { name: "Pro", page: "/plans", introAmount: "1.00" },
      { name: "Studio", page: "/plans" },
    ],
  });
  const text = [
    "Pricing",
    "Pro tip: pick the plan that fits.",
    "Starter",
    "$19 per month",
    "Pro",
    "First month $1, then $49 a month",
    "7-day free trial",
    "Studio",
    "$99 al mes (IVA incluido)",
  ].join("\n");
  const page: PlanPage = { url: "https://shop.example/plans", text };

  it("starts a plan at the line that is its name and stops at the next plan", () => {
    const [starter, pro, studio] = readPagePlans(config, () => page);
    expect(starter?.heading).toBe("Starter");
    expect(starter?.amount?.text).toBe("19");
    expect(starter?.trial).toBeNull();
    expect(pro?.amount?.text).toBe("49");
    expect(pro?.cadence).toEqual({ unit: "month", count: 1 });
    expect(pro?.trial).toEqual({ min: 7, max: 7 });
    expect(studio?.tax).toBe("inclusive");
    expect(studio?.cadence).toEqual({ unit: "month", count: 1 });
  });

  it("sets the configured introductory amount aside; without it the plan is promo", () => {
    const without = plansConfigSchema.parse({ plans: [{ name: "Pro", page: "/plans" }] });
    expect(readPagePlans(config, () => page)[1]?.promo).toBe(false);
    const [pro] = readPagePlans(without, () => page);
    expect(pro?.promo).toBe(true);
  });

  it("a plan whose name or page is not there is missing", () => {
    const other = { url: "https://shop.example/plans", text: "Nothing here" };
    expect(readPagePlans(config, () => other).map((p) => p.state)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
    expect(readPagePlans(config, () => undefined)[0]).toMatchObject({
      state: "missing",
      url: "/plans",
    });
  });
});

describe("plansConfigSchema", () => {
  it("accepts names, paths, Stripe ids and an optional intro amount", () => {
    expect(() =>
      plansConfigSchema.parse({
        plans: [{ name: "Pro", page: "/plans", price: "price_1Abc", introAmount: "1.00" }],
        products: ["prod_Abc"],
      }),
    ).not.toThrow();
  });

  it.each([
    [{ plans: [] }, "expected array"],
    [{ plans: [{ name: "Pro", page: "plans" }] }, "path on the site"],
    [{ plans: [{ name: "Pro", page: "/plans", price: "prod_1" }] }, "price id"],
    [
      {
        plans: [
          { name: "Pro", page: "/plans" },
          { name: "pro", page: "/plans" },
        ],
      },
      "twice",
    ],
    [
      {
        plans: [
          { name: "Pro", page: "/a" },
          { name: "Pro", page: "/b" },
        ],
      },
      "share the id",
    ],
    [{ plans: [{ name: "Pro", page: "/plans", key: "sk_x" }] }, "Unrecognized"],
  ])("refuses %j", (value, message) => {
    const r = plansConfigSchema.safeParse(value);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(message);
  });
});
