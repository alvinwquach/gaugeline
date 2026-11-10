import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../../testkit/src/index.js";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { runConnectors } from "../run.js";
import {
  STRIPE_ENV_VARS,
  STRIPE_MAX_PAGES,
  buildProducts,
  classifyStripeKey,
  createStripeConnector,
  findTestPublishableKeys,
  guardStripeKey,
  stripeConnector,
} from "../stripe.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const key = (kind: "rk" | "sk" | "pk", mode: "live" | "test", rest = "PopUpKitchen0123456789") =>
  [kind, mode, rest].join("_");
const RK = key("rk", "live");
const SK_LIVE = key("sk", "live");
const SK_TEST = key("sk", "test");

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A fetcher that answers from a recorded Stripe cassette and logs every request it receives. */
function recorded(cassette: string, seen: Seen[] = []): Fetcher {
  const replay = useCassette(cassette, { mode: "replay" });
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    return replay(url, req);
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

type Answer = { status: number; body: unknown };

/** A fetcher whose network is one function: for the answers a cassette cannot hold. */
function serving(answer: (url: URL, headers: Record<string, string>) => Answer, seen: Seen[] = []) {
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const { status, body } = answer(url, req.headers);
    return Promise.resolve({
      status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]),
    });
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

const list = (url: string, data: unknown[], more: boolean) => ({
  status: 200,
  body: { object: "list", url, has_more: more, data },
});
const prod = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Name of ${id}`,
  active: true,
  metadata: {},
  default_price: null,
  ...extra,
});
const pr = (id: string, product: unknown, amount: number | null, extra = {}) => ({
  id,
  product,
  unit_amount: amount,
  currency: "usd",
  active: true,
  ...extra,
});

const ENV = { STRIPE_API_KEY: RK };

describe("classifyStripeKey: unit", () => {
  it("the table", () => {
    const table: Array<[string, ReturnType<typeof classifyStripeKey>]> = [
      [key("rk", "live"), "restricted"],
      [key("rk", "test"), "restricted"],
      [SK_LIVE, "secret-live"],
      [SK_TEST, "secret-test"],
      ["", "unknown"],
      ["   ", "unknown"],
      ["garbage", "unknown"],
      [key("pk", "live"), "unknown"],
      [`  ${RK}\n`, "restricted"],
      ["rk_", "unknown"],
      ["xrk_live_abc", "unknown"],
      ["SK_LIVE_abc", "unknown"],
    ];
    for (const [input, kind] of table) expect(classifyStripeKey(input), input).toBe(kind);
  });
});

describe("guardStripeKey: unit", () => {
  it("no variable or an empty one is nothing to guard", () => {
    expect(guardStripeKey({}, { allowSecretKey: false })).toEqual([]);
    expect(guardStripeKey({ STRIPE_API_KEY: "" }, { allowSecretKey: false })).toEqual([]);
  });

  it("a restricted key passes without a word", () => {
    expect(guardStripeKey(ENV, { allowSecretKey: false })).toEqual([]);
  });

  it("a live secret key is a ConfigError that says what to create, and never shows the key", () => {
    const env = { STRIPE_API_KEY: SK_LIVE };
    let caught: unknown;
    try {
      guardStripeKey(env, { allowSecretKey: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const text = `${(caught as ConfigError).message} ${(caught as ConfigError).hint ?? ""}`;
    expect(text).toMatch(/restricted key that can read products and prices/);
    expect(text).toContain("--allow-secret-key");
    expect(text).not.toContain(SK_LIVE);
    expect(text).not.toContain("PopUpKitchen");
  });

  it("any other sk_ key is refused the same way: an unknown secret is still a secret", () => {
    expect(() =>
      guardStripeKey(
        { STRIPE_API_KEY: ["sk", "org", "abc123"].join("_") },
        { allowSecretKey: false },
      ),
    ).toThrow(ConfigError);
  });

  it("--allow-secret-key turns the refusal into one notice", () => {
    const notices = guardStripeKey({ STRIPE_API_KEY: SK_LIVE }, { allowSecretKey: true });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/secret key/);
    expect(notices[0]).toMatch(/restricted key/);
    expect(notices[0]).not.toContain(SK_LIVE);
  });

  it("a test secret key is accepted with a notice, flag or not", () => {
    for (const allowSecretKey of [false, true]) {
      const notices = guardStripeKey({ STRIPE_API_KEY: SK_TEST }, { allowSecretKey });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/test/);
      expect(notices[0]).not.toContain(SK_TEST);
    }
  });

  it("a key that is not a Stripe key at all gets a notice and is not echoed", () => {
    const notices = guardStripeKey(
      { STRIPE_API_KEY: "hunter2-not-a-key" },
      { allowSecretKey: false },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/rk_/);
    expect(notices[0]).not.toContain("hunter2");
  });
});

describe("join: unit", () => {
  it("prices for three products that arrive interleaved land on the right product, in order", () => {
    const products = [prod("prod_a"), prod("prod_b"), prod("prod_c")];
    const prices = [
      pr("p1", "prod_c", 300),
      pr("p2", "prod_a", 100),
      pr("p3", "prod_b", 200),
      pr("p4", "prod_a", 150),
      pr("p5", "prod_c", 350),
      pr("p6", "prod_a", 175),
    ];
    const built = buildProducts(products, prices);
    expect(built.map((p) => [p.id, p.prices.map((x) => x.id)])).toEqual([
      ["prod_a", ["p2", "p4", "p6"]],
      ["prod_b", ["p3"]],
      ["prod_c", ["p1", "p5"]],
    ]);
  });

  it("a price whose product is not in the list is dropped, and an expanded product object still joins", () => {
    const built = buildProducts(
      [prod("prod_a")],
      [pr("p1", "prod_gone", 100), pr("p2", { id: "prod_a", object: "product" }, 200)],
    );
    expect(built[0]?.prices.map((p) => p.id)).toEqual(["p2"]);
  });

  it("keeps only the fields of the type: no description, no timestamps", () => {
    const built = buildProducts(
      [prod("prod_a", { description: "secret recipe", created: 1, default_price: "price_a" })],
      [pr("price_a", "prod_a", 4800, { created: 2, nickname: "x", unit_amount_decimal: "4800" })],
    );
    expect(built).toEqual([
      {
        id: "prod_a",
        name: "Name of prod_a",
        active: true,
        metadata: {},
        defaultPriceId: "price_a",
        prices: [{ id: "price_a", unitAmount: 4800, currency: "usd", active: true }],
      },
    ]);
  });

  it("a default price may be an expanded object; metadata keeps only text values", () => {
    const built = buildProducts(
      [
        prod("prod_a", {
          default_price: { id: "price_a" },
          metadata: { sanityId: "tamal-box", n: 5 },
        }),
      ],
      [],
    );
    expect(built[0]?.defaultPriceId).toBe("price_a");
    expect(built[0]?.metadata).toEqual({ sanityId: "tamal-box" });
  });

  it("an item with no id is refused, naming what was expected", () => {
    expect(() => buildProducts([{ name: "x" }], [])).toThrow(/product/);
    expect(() => buildProducts([prod("prod_a")], [{ product: "prod_a" }])).toThrow(/price/);
  });
});

describe("test-mode detector: unit", () => {
  const pk = key("pk", "test", "51HxPopUpKitchenTestKey0123456789");
  it("finds pk_test_ in an inline script, an attribute and plain text", () => {
    expect(findTestPublishableKeys(`Stripe("${pk}")`)).toEqual([pk]);
    expect(findTestPublishableKeys(`<stripe-buy-button publishable-key='${pk}'>`)).toEqual([pk]);
    expect(findTestPublishableKeys(`var a={k:"${pk}"}`)).toEqual([pk]);
  });

  it("does not match inside a longer word or a longer key", () => {
    expect(findTestPublishableKeys(`x${pk}`)).toEqual([]);
    expect(findTestPublishableKeys(`my_${pk}`)).toEqual([]);
    expect(findTestPublishableKeys(`${pk}`.replace("pk_", "spk_"))).toEqual([]);
    expect(findTestPublishableKeys("pk_test_ is how a test key starts")).toEqual([]);
    expect(findTestPublishableKeys("pk_test_short")).toEqual([]);
  });

  it("does not match a live publishable key or a secret one", () => {
    expect(findTestPublishableKeys(key("pk", "live", "51HxPopUpKitchenLiveKey0123456789"))).toEqual(
      [],
    );
    expect(findTestPublishableKeys(key("sk", "test", "51HxPopUpKitchenTestKey0123456789"))).toEqual(
      [],
    );
  });

  it("lists each distinct key once, in order", () => {
    const other = key("pk", "test", "51HxOtherKitchenTestKey012345678");
    expect(findTestPublishableKeys(`${pk} ${other} ${pk}`)).toEqual([pk, other]);
  });
});

describe("configured: unit", () => {
  it("needs STRIPE_API_KEY, and says so; only that variable is a key", () => {
    expect(stripeConnector.id).toBe("stripe");
    expect(stripeConnector.envVars).toEqual(["STRIPE_API_KEY"]);
    expect(stripeConnector.secretEnvVars).toEqual(["STRIPE_API_KEY"]);
    expect([...STRIPE_ENV_VARS]).toEqual(["STRIPE_API_KEY"]);
    expect(stripeConnector.configured(ENV)).toBe(true);
    expect(stripeConnector.configured({})).toBe(false);
    expect(stripeConnector.configured({ STRIPE_API_KEY: "" })).toBe(false);
  });
});

describe("integration: recorded responses", () => {
  it("250 products across three pages: three product requests, all 250 in order", async () => {
    const seen: Seen[] = [];
    const products = await stripeConnector.read(ENV, recorded("stripe-large", seen));
    expect(products).toHaveLength(250);
    expect(products.map((p) => p.id)).toEqual(
      Array.from({ length: 250 }, (_, i) => `prod_Big${String(i + 1).padStart(4, "0")}`),
    );
    const productRequests = seen.filter((s) => new URL(s.url).pathname === "/v1/products");
    expect(productRequests.map((s) => new URL(s.url).search)).toEqual([
      "?limit=100",
      "?limit=100&starting_after=prod_Big0100",
      "?limit=100&starting_after=prod_Big0200",
    ]);
    const priceRequests = seen.filter((s) => new URL(s.url).pathname === "/v1/prices");
    expect(priceRequests).toHaveLength(3);
    // The first 50 products have two prices (one archived), the rest one: joined without a request each.
    expect(products[0]?.prices.map((p) => [p.unitAmount, p.active])).toEqual([
      [1000, true],
      [2000, false],
    ]);
    expect(products[249]?.prices).toHaveLength(1);
    expect(seen).toHaveLength(6);
  });

  it("the pop-up kitchen: archived products and prices are data, a missing default price is null", async () => {
    const products = await stripeConnector.read(ENV, recorded("stripe-products"));
    expect(products.map((p) => [p.id, p.active, p.defaultPriceId])).toEqual([
      ["prod_PopTamalBox", true, "price_TamalBox4800"],
      ["prod_PopSalsa", true, "price_Salsa900"],
      ["prod_PopSupper", true, null],
      ["prod_PopWinter", false, "price_Winter500"],
      ["prod_PopFlight", true, "price_FlightTiers"],
    ]);
    const supper = products.find((p) => p.id === "prod_PopSupper");
    expect(supper?.defaultPriceId).toBeNull();
    expect(supper?.prices.map((p) => p.unitAmount)).toEqual([8500, 7500, 6000]);
    const tamal = products.find((p) => p.id === "prod_PopTamalBox");
    expect(tamal?.metadata).toEqual({ sanityId: "tamal-box" });
    expect(tamal?.prices.map((p) => [p.unitAmount, p.active])).toEqual([
      [4800, true],
      [4200, false],
    ]);
  });

  it("a tiered price keeps unitAmount null; it is never turned into 0", async () => {
    const products = await stripeConnector.read(ENV, recorded("stripe-products"));
    const flight = products.find((p) => p.id === "prod_PopFlight");
    expect(flight?.prices).toEqual([
      { id: "price_FlightTiers", unitAmount: null, currency: "usd", active: true },
    ]);
  });

  it("every request is a GET with the key in an Authorization header and never in the address", async () => {
    const seen: Seen[] = [];
    await stripeConnector.read(ENV, recorded("stripe-products", seen));
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    for (const s of seen) {
      expect(s.url.startsWith("https://api.stripe.com/v1/")).toBe(true);
      expect(s.url).not.toContain(RK);
      expect(s.headers.authorization).toBe(`Bearer ${RK}`);
    }
  });

  it("archived products are not filtered out: the address has no active parameter", async () => {
    const seen: Seen[] = [];
    await stripeConnector.read(ENV, recorded("stripe-products", seen));
    for (const s of seen) expect(new URL(s.url).searchParams.has("active")).toBe(false);
  });

  it("a live secret key: ConfigError and zero requests", async () => {
    const seen: Seen[] = [];
    const env = { STRIPE_API_KEY: SK_LIVE };
    await expect(stripeConnector.read(env, recorded("stripe-products", seen))).rejects.toThrow(
      ConfigError,
    );
    expect(seen).toEqual([]);
    const run = await runConnectors([stripeConnector], env, recorded("stripe-products", seen));
    expect(seen).toEqual([]);
    expect(run.data.has("stripe")).toBe(false);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.message).toMatch(/restricted key that can read products and prices/);
    expect(JSON.stringify(run)).not.toContain(SK_LIVE);
  });

  it("with --allow-secret-key: one notice and a normal read", async () => {
    const seen: Seen[] = [];
    const env = { STRIPE_API_KEY: SK_LIVE };
    const run = await runConnectors(
      [createStripeConnector({ allowSecretKey: true })],
      env,
      recorded("stripe-products", seen),
    );
    expect(run.data.get("stripe")).toHaveLength(5);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("advice");
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${SK_LIVE}`);
    expect(JSON.stringify(run)).not.toContain(SK_LIVE);
  });

  it("a test secret key is read, with one notice", async () => {
    const run = await runConnectors(
      [stripeConnector],
      { STRIPE_API_KEY: SK_TEST },
      recorded("stripe-products"),
    );
    expect(run.data.get("stripe")).toHaveLength(5);
    expect(run.notices.map((n) => n.kind)).toEqual(["advice"]);
    expect(JSON.stringify(run)).not.toContain(SK_TEST);
  });

  it("403 on prices: the notice names the permission to add, and not the key", async () => {
    const run = await runConnectors([stripeConnector], ENV, recorded("stripe-no-prices"));
    expect(run.data.has("stripe")).toBe(false);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("refused");
    expect(run.notices[0]?.message).toMatch(/Prices/);
    expect(run.notices[0]?.message).toMatch(/Read/);
    expect(run.notices[0]?.message).toMatch(/403/);
    expect(JSON.stringify(run)).not.toContain(RK);
  });

  it("403 on products names Products, 401 says the key was not accepted", async () => {
    const denied = (status: number) =>
      serving(() => ({ status, body: { error: { message: `No such key: ${RK}` } } }));
    const products = await runConnectors([stripeConnector], ENV, denied(403));
    expect(products.notices[0]?.kind).toBe("refused");
    expect(products.notices[0]?.message).toMatch(/Products/);
    const wrong = await runConnectors([stripeConnector], ENV, denied(401));
    expect(wrong.notices[0]?.kind).toBe("refused");
    expect(wrong.notices[0]?.message).toMatch(/not accept/);
    expect(JSON.stringify([products, wrong])).not.toContain(RK);
  });

  it("no STRIPE_API_KEY: zero requests and a not-configured notice, which is never a pass", async () => {
    const seen: Seen[] = [];
    for (const env of [{}, { STRIPE_API_KEY: "" }]) {
      const run = await runConnectors([stripeConnector], env, recorded("stripe-products", seen));
      expect(run.data.has("stripe")).toBe(false);
      expect(run.notices).toEqual([
        {
          connector: "stripe",
          kind: "not-configured",
          message: "stripe is not set up, so it was left out. Set STRIPE_API_KEY to include it.",
        },
      ]);
    }
    expect(seen).toEqual([]);
  });
});

describe("edge cases", () => {
  it("has_more true with an empty page: stop and add a notice, do not loop", async () => {
    const seen: Seen[] = [];
    const fetcher = serving((url) => {
      if (url.pathname === "/v1/prices") return list("/v1/prices", [], false);
      return url.searchParams.has("starting_after")
        ? list("/v1/products", [], true)
        : list(
            "/v1/products",
            Array.from({ length: 100 }, (_, i) => prod(`prod_${i}`)),
            true,
          );
    }, seen);
    const run = await runConnectors([stripeConnector], ENV, fetcher);
    expect(run.data.get("stripe")).toHaveLength(100);
    expect(seen.filter((s) => s.url.includes("/v1/products"))).toHaveLength(2);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("advice");
    expect(run.notices[0]?.message).toMatch(/products/);
    expect(run.notices[0]?.message).toMatch(/empty/);
  });

  it("a cursor that does not move stops the loop with a notice", async () => {
    const seen: Seen[] = [];
    const fetcher = serving((url) => {
      if (url.pathname === "/v1/prices") return list("/v1/prices", [], false);
      return list("/v1/products", [prod("prod_same")], true);
    }, seen);
    const run = await runConnectors([stripeConnector], ENV, fetcher);
    expect(seen.filter((s) => s.url.includes("/v1/products")).length).toBeLessThanOrEqual(2);
    expect(run.notices).toHaveLength(1);
  });

  it(`pagination stops at ${STRIPE_MAX_PAGES} pages per list and says so`, async () => {
    const seen: Seen[] = [];
    let n = 0;
    const fetcher = serving((url) => {
      if (url.pathname === "/v1/prices") return list("/v1/prices", [], false);
      n += 1;
      return list("/v1/products", [prod(`prod_${n}`)], true);
    }, seen);
    const run = await runConnectors([stripeConnector], ENV, fetcher);
    expect(seen.filter((s) => s.url.includes("/v1/products"))).toHaveLength(STRIPE_MAX_PAGES);
    expect(run.data.get("stripe")).toHaveLength(STRIPE_MAX_PAGES);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.message).toContain(String(STRIPE_MAX_PAGES));
    expect(run.notices[0]?.message).toMatch(/products/);
  });

  it("the cap applies to prices too, with its own notice", async () => {
    let n = 0;
    const fetcher = serving((url) => {
      if (url.pathname === "/v1/products") return list("/v1/products", [prod("prod_a")], false);
      n += 1;
      return list("/v1/prices", [pr(`price_${n}`, "prod_a", n)], true);
    });
    const run = await runConnectors([stripeConnector], ENV, fetcher);
    expect(n).toBe(STRIPE_MAX_PAGES);
    expect((run.data.get("stripe") as Array<{ prices: unknown[] }>)[0]?.prices).toHaveLength(
      STRIPE_MAX_PAGES,
    );
    expect(run.notices[0]?.message).toMatch(/prices/);
  });

  it("an answer that is not a Stripe list is unreachable, with no body in the message", async () => {
    const run = await runConnectors(
      [stripeConnector],
      ENV,
      serving(() => ({ status: 200, body: { hello: `world ${RK}` } })),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(JSON.stringify(run)).not.toContain("world");
    expect(JSON.stringify(run)).not.toContain(RK);
  });

  it("a 429 is unreachable and says when to try again", async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 429,
        headers: { "retry-after": "30" },
        body: Readable.from([Buffer.from("{}")]),
      });
    const run = await runConnectors([stripeConnector], ENV, createFetcher({ transport }));
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).toMatch(/30 seconds/);
  });
});

describe("promise: read only, key nowhere", () => {
  it("every request over a full run is a GET; the key is in no notice, debug line or row", async () => {
    const seen: Seen[] = [];
    const debug: string[] = [];
    const planted = key("rk", "live", "PlantedKeyMustNeverAppear01");
    const env = { STRIPE_API_KEY: planted };
    const run = await runConnectors([stripeConnector], env, recorded("stripe-large", seen), {
      debug: (l) => debug.push(l),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    const everything = JSON.stringify([run.data.get("stripe"), run.notices, debug]);
    expect(everything).not.toContain(planted);
    expect(everything).not.toContain("PlantedKeyMustNeverAppear01");
  });

  it("a server that echoes the key in a 500 body leaks nothing into the notice", async () => {
    const run = await runConnectors(
      [stripeConnector],
      ENV,
      serving(() => ({ status: 500, body: `oops ${RK}` })),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(JSON.stringify(run)).not.toContain(RK);
  });
});

describe("subscription prices", () => {
  const rawProduct = { id: "prod_a", name: "Pro", active: true };
  const rawPrice = (extra: Record<string, unknown>) => ({
    id: "price_a",
    product: "prod_a",
    currency: "usd",
    unit_amount: 4900,
    active: true,
    ...extra,
  });
  const priceOf = (extra: Record<string, unknown>) =>
    buildProducts([rawProduct], [rawPrice(extra)])[0]?.prices[0];

  it("keeps the interval, the count and the trial of a recurring price", () => {
    expect(
      priceOf({ recurring: { interval: "month", interval_count: 3, trial_period_days: 7 } })
        ?.recurring,
    ).toEqual({ interval: "month", intervalCount: 3, trialPeriodDays: 7 });
  });

  it("defaults the count to 1 and the trial to null", () => {
    expect(priceOf({ recurring: { interval: "year" } })?.recurring).toEqual({
      interval: "year",
      intervalCount: 1,
      trialPeriodDays: null,
    });
    expect(
      priceOf({ recurring: { interval: "week", interval_count: 0, trial_period_days: -1 } })
        ?.recurring,
    ).toEqual({ interval: "week", intervalCount: 1, trialPeriodDays: null });
  });

  it("a price without a recurring object, or with an unknown interval, has none", () => {
    expect(priceOf({})).not.toHaveProperty("recurring");
    expect(priceOf({ recurring: null })).not.toHaveProperty("recurring");
    expect(priceOf({ recurring: { interval: "fortnight" } })).not.toHaveProperty("recurring");
  });

  it("keeps tax_behavior only when it says inclusive or exclusive", () => {
    expect(priceOf({ tax_behavior: "exclusive" })?.taxBehavior).toBe("exclusive");
    expect(priceOf({ tax_behavior: "inclusive" })?.taxBehavior).toBe("inclusive");
    expect(priceOf({ tax_behavior: "unspecified" })).not.toHaveProperty("taxBehavior");
  });

  it("keeps the fixed amounts of currency_options, lower-cased", () => {
    expect(
      priceOf({ currency_options: { EUR: { unit_amount: 4500 }, gbp: { unit_amount: null } } })
        ?.currencyOptions,
    ).toEqual({ eur: 4500 });
    expect(priceOf({ currency_options: {} })).not.toHaveProperty("currencyOptions");
  });

  it("reads the recorded studio: three subscription products, a yearly price and an archived one", async () => {
    const seen: Seen[] = [];
    const products = await stripeConnector.read(ENV, recorded("stripe-plans-harbor", seen));
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    const prices = products.flatMap((p) => p.prices);
    expect(
      prices.map((p) => [p.id, p.recurring?.interval, p.recurring?.trialPeriodDays, p.active]),
    ).toEqual([
      ["price_HarborFound4900", "month", 7, true],
      ["price_HarborFound49000", "year", 7, true],
      ["price_HarborMoment12900", "year", null, true],
      ["price_HarborElite24900", "month", null, false],
      ["price_HarborElite29900", "month", null, true],
    ]);
  });

  it("one-time prices keep the shape they had", async () => {
    const products = await stripeConnector.read(ENV, recorded("stripe-products"));
    for (const p of products.flatMap((x) => x.prices))
      expect(Object.keys(p).sort()).toEqual(["active", "currency", "id", "unitAmount"]);
  });
});
