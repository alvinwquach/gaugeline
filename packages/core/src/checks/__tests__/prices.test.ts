import { describe, expect, it } from "vitest";
import type { PrintfulProduct, PrintfulVariant } from "../../connectors/printful.js";
import type { SanityProduct } from "../../connectors/sanity.js";
import type { StripePrice, StripeProduct } from "../../connectors/stripe.js";
import type { Finding } from "../../model.js";
import { matchProducts, type ProductGroup, type Tier } from "../../products/match.js";
import { readSupperStore } from "../../products/__tests__/price-store.js";
import { runChecks, type RunResult } from "../../run.js";
import {
  PRICE_CHECK_IDS,
  PRICE_CHECKS,
  createPriceRegistry,
  type PriceCheckInput,
} from "../prices.js";

// ---- builders -----------------------------------------------------------------------------------

const sanity = (id: string, price: number | null, extra: Partial<SanityProduct> = {}) =>
  ({ _id: id, name: id, price, ...extra }) satisfies SanityProduct;

const usd = (id: string, unitAmount: number | null, currency = "usd"): StripePrice => ({
  id,
  unitAmount,
  currency,
  active: true,
});

const stripe = (
  id: string,
  amount: number | null,
  extra: Partial<StripeProduct> & { currency?: string } = {},
): StripeProduct => {
  const { currency, ...rest } = extra;
  return {
    id,
    name: id,
    active: true,
    metadata: {},
    defaultPriceId: `price_${id}`,
    prices: [usd(`price_${id}`, amount, currency)],
    ...rest,
  };
};

const variant = (id: string, retail: number | null, extra: Partial<PrintfulVariant> = {}) =>
  ({ id, synced: true, retailPrice: retail, currency: "USD", ...extra }) satisfies PrintfulVariant;

const printful = (id: string, variants: PrintfulVariant[]): PrintfulProduct => ({
  id,
  name: id,
  variants,
});

const group = (
  s: SanityProduct | undefined,
  st?: StripeProduct,
  pf?: PrintfulProduct,
  tiers: { stripe?: Tier; printful?: Tier } = {},
): ProductGroup => ({
  ...(s ? { sanity: s } : {}),
  ...(st ? { stripe: st, stripeTier: tiers.stripe ?? "saved-id" } : {}),
  ...(pf ? { printful: pf, printfulTier: tiers.printful ?? "saved-id" } : {}),
});

async function run(groups: ProductGroup[], extra: Partial<PriceCheckInput> = {}) {
  return runChecks({ groups, ...extra }, createPriceRegistry());
}

const only = (r: RunResult, id: string): Finding[] => r.findings.filter((f) => f.checkId === id);
const notes = (r: RunResult, id: string): string[] =>
  r.couldNotCheck.filter((c) => c.id === id).map((c) => c.reason);

// ---- unit ---------------------------------------------------------------------------------------

describe("price checks: registration", () => {
  it("the four checks are registered with the model, in order, in Sales & prices", () => {
    expect(PRICE_CHECK_IDS).toEqual([
      "price-mismatch",
      "price-stored-twice",
      "printful-price",
      "stripe-no-price",
    ]);
    expect(PRICE_CHECKS.map((c) => c.id)).toEqual([...PRICE_CHECK_IDS]);
    expect(PRICE_CHECKS.map((c) => c.severity)).toEqual(["high", "low", "medium", "medium"]);
    for (const c of PRICE_CHECKS) {
      expect(c.area).toBe("Sales & prices");
      for (const field of ["title", "what", "why", "fix", "tech"] as const)
        expect(c[field].trim()).not.toBe("");
    }
    expect(createPriceRegistry().size).toBe(4);
  });

  it("no check says which system is right", () => {
    for (const c of PRICE_CHECKS)
      expect(`${c.title} ${c.what} ${c.why} ${c.fix}`).not.toMatch(
        /is (the )?(right|correct|wrong)|should win|source of truth/i,
      );
  });
});

describe("price-mismatch: unit", () => {
  it("fires when Sanity says 48 and the Stripe default price says 52, quoting both", async () => {
    const r = await run([group(sanity("apron", 4800), stripe("prod_a", 5200))]);
    const [f] = only(r, "price-mismatch");
    expect(only(r, "price-mismatch")).toHaveLength(1);
    expect(f?.severity).toBe("high");
    expect(f?.evidence).toContain("Sanity");
    expect(f?.evidence).toContain("48.00 USD");
    expect(f?.evidence).toContain("Stripe");
    expect(f?.evidence).toContain("52.00 USD");
    expect(f?.evidence).toContain("matched by saved id");
    expect(f?.url).toBe("sanity:apron");
  });

  it("does not fire when the two agree", async () => {
    const r = await run([group(sanity("apron", 5200), stripe("prod_a", 5200))]);
    expect(only(r, "price-mismatch")).toEqual([]);
    expect(r.passed).toContain("price-mismatch");
  });

  it("compares the default price, not another price the product has", async () => {
    const st = stripe("prod_a", 5200, {
      prices: [usd("price_prod_a", 5200), usd("price_old", 4800)],
    });
    expect(only(await run([group(sanity("a", 4800), st)]), "price-mismatch")).toHaveLength(1);
    expect(only(await run([group(sanity("a", 5200), st)]), "price-mismatch")).toEqual([]);
  });

  it("says nothing without a Sanity price, a Stripe partner or a Sanity product", async () => {
    const r = await run([
      group(sanity("no-price", null), stripe("prod_a", 5200)),
      group(sanity("no-partner", 4800)),
      group(undefined, stripe("prod_b", 5200)),
    ]);
    expect(r.findings).toEqual([]);
    expect(notes(r, "price-mismatch")).toEqual([]);
  });

  it("does not name a winner in the evidence", async () => {
    const r = await run([group(sanity("a", 4800), stripe("prod_a", 5200))]);
    expect(only(r, "price-mismatch")[0]?.evidence).not.toMatch(
      /\b(right|correct|wrong|outdated)\b/i,
    );
  });
});

describe("price-stored-twice: unit", () => {
  it("fires when both store a price and they agree, as one low finding", async () => {
    const r = await run([group(sanity("sauce", 1200), stripe("prod_s", 1200))]);
    const found = only(r, "price-stored-twice");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("low");
    expect(found[0]?.evidence).toContain("1 product");
    expect(found[0]?.evidence).toContain("sauce");
  });

  it("names the match rule in the list only for the weaker rules", async () => {
    const r = await run([
      group(sanity("exact", 1200), stripe("prod_e", 1200), undefined, { stripe: "saved-id" }),
      group(sanity("by-sku", 1300), stripe("prod_s", 1300), undefined, { stripe: "sku" }),
      group(sanity("by-name", 1400), stripe("prod_n", 1400), undefined, { stripe: "name" }),
    ]);
    const text = only(r, "price-stored-twice")[0]?.evidence ?? "";
    expect(text).toContain("3 products");
    expect(text).toContain("by-sku (matched by SKU)");
    expect(text).toContain("by-name (matched by name)");
    expect(text).not.toContain("exact (");
  });

  it("does not fire when they disagree (that is a mismatch), or one side has no price", async () => {
    const r = await run([
      group(sanity("a", 4800), stripe("prod_a", 5200)),
      group(sanity("b", null), stripe("prod_b", 1200)),
      group(sanity("c", 1200), stripe("prod_c", null)),
      group(sanity("d", 1200), stripe("prod_d", 1200, { defaultPriceId: null })),
      group(sanity("e", 1200)),
    ]);
    expect(only(r, "price-stored-twice")).toEqual([]);
    expect(r.passed).toContain("price-stored-twice");
  });
});

describe("printful-price: unit", () => {
  it("fires when a synced variant's retail price differs from the Stripe default price", async () => {
    const r = await run([
      group(
        sanity("tote", 2450),
        stripe("prod_t", 2450),
        printful("5002", [
          variant("n", 2450, { sku: "TOTE-N" }),
          variant("b", 2900, { sku: "TOTE-B" }),
        ]),
      ),
    ]);
    const found = only(r, "printful-price");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("medium");
    expect(found[0]?.evidence).toContain("Printful");
    expect(found[0]?.evidence).toContain("29.00 USD");
    expect(found[0]?.evidence).toContain("TOTE-B");
    expect(found[0]?.evidence).not.toContain("TOTE-N");
    expect(found[0]?.evidence).toContain("Stripe");
    expect(found[0]?.evidence).toContain("24.50 USD");
  });

  it("does not fire when every synced variant agrees with Stripe", async () => {
    const r = await run([
      group(sanity("a", 5200), stripe("prod_a", 5200), printful("1", [variant("v", 5200)])),
    ]);
    expect(only(r, "printful-price")).toEqual([]);
    expect(r.passed).toContain("printful-price");
  });

  it("ignores a variant that is not synced", async () => {
    const r = await run([
      group(
        sanity("a", 5200),
        stripe("prod_a", 5200),
        printful("1", [variant("v", 5200), variant("w", 5850, { synced: false })]),
      ),
    ]);
    expect(only(r, "printful-price")).toEqual([]);
  });

  it("says nothing without a Stripe partner, a default price or a Printful product", async () => {
    const r = await run([
      group(sanity("a", 1), undefined, printful("1", [variant("v", 100)])),
      group(
        sanity("b", 1),
        stripe("prod_b", 5200, { defaultPriceId: null }),
        printful("2", [variant("v", 100)]),
      ),
      group(sanity("c", 1), stripe("prod_c", 5200)),
    ]);
    expect(only(r, "printful-price")).toEqual([]);
  });
});

describe("stripe-no-price: unit", () => {
  it("fires for a matched, active Stripe product with no default price", async () => {
    const r = await run([
      group(sanity("box", 4500), stripe("prod_b", 4500, { defaultPriceId: null })),
    ]);
    const found = only(r, "stripe-no-price");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("medium");
    expect(found[0]?.evidence).toContain("prod_b");
    expect(found[0]?.evidence).toContain("no default price");
  });

  it("does not fire for a default price, an archived product or a product with no Sanity partner", async () => {
    const r = await run([
      group(sanity("a", 4500), stripe("prod_a", 4500)),
      group(sanity("b", 4500), stripe("prod_b", 4500, { defaultPriceId: null, active: false })),
      group(undefined, stripe("prod_c", 4500, { defaultPriceId: null })),
    ]);
    expect(only(r, "stripe-no-price")).toEqual([]);
    expect(r.passed).toContain("stripe-no-price");
  });
});

describe("price checks: units and currencies", () => {
  it("500 yen in Sanity (major units, read as 50000) equals 500 in Stripe: no mismatch", async () => {
    const g = group(sanity("ramen", 50000), stripe("prod_r", 500, { currency: "jpy" }));
    expect(only(await run([g]), "price-mismatch")).toEqual([]);
    const off = group(sanity("ramen", 60000), stripe("prod_r", 500, { currency: "jpy" }));
    const found = only(await run([off]), "price-mismatch");
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("600 JPY");
    expect(found[0]?.evidence).toContain("500 JPY");
  });

  it("a Sanity price already in minor units is compared as it is", async () => {
    const g = group(sanity("ramen", 500), stripe("prod_r", 500, { currency: "jpy" }));
    expect(only(await run([g], { sanityPriceUnit: "cents" }), "price-mismatch")).toEqual([]);
    expect(only(await run([g], { sanityPriceUnit: "major" }), "price-mismatch")).toHaveLength(1);
  });

  it("three-decimal currencies: 1.250 kwd in Sanity is 1250 in Stripe", async () => {
    const g = group(sanity("tea", 125), stripe("prod_t", 1250, { currency: "kwd" }));
    expect(only(await run([g]), "price-mismatch")).toEqual([]);
  });

  it("a fractional yen price in Sanity cannot be compared and is a notice", async () => {
    const g = group(sanity("ramen", 50050), stripe("prod_r", 500, { currency: "jpy" }));
    const r = await run([g]);
    expect(only(r, "price-mismatch")).toEqual([]);
    expect(notes(r, "price-mismatch")).toHaveLength(1);
    expect(r.passed).not.toContain("price-mismatch");
  });

  it("a Stripe price with an upper-case currency still compares", async () => {
    const g = group(sanity("a", 4800), stripe("prod_a", 4800, { currency: "USD" }));
    expect(only(await run([g]), "price-mismatch")).toEqual([]);
  });

  it("a Stripe price with no currency is a notice, not a finding", async () => {
    const g = group(sanity("a", 4800), stripe("prod_a", 5200, { currency: "" }));
    const r = await run([g]);
    expect(only(r, "price-mismatch")).toEqual([]);
    expect(notes(r, "price-mismatch")[0]).toContain("currency");
  });
});

// ---- integration --------------------------------------------------------------------------------

describe("price checks: the Ember Supper Club store, read through the connectors", () => {
  it("$48 on the site and $52 in Stripe is one high finding quoting both", async () => {
    const store = await readSupperStore();
    const r = await run(store.match.groups);
    const found = only(r, "price-mismatch");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
    expect(found[0]?.url).toBe("sanity:supper-apron");
    expect(found[0]?.evidence).toContain("48.00 USD");
    expect(found[0]?.evidence).toContain("52.00 USD");
    expect(found[0]?.evidence).toContain("Supper apron");
  });

  it("the same apron at $52 in Printful and $52 in Stripe has no Printful finding", async () => {
    const store = await readSupperStore();
    const r = await run(store.match.groups);
    const apron = only(r, "printful-price").filter((f) => f.url === "sanity:supper-apron");
    expect(apron).toEqual([]);
  });

  it("the whole store: one finding per rule that fires and the notices that were skipped", async () => {
    const store = await readSupperStore();
    const r = await run(store.match.groups);
    expect(r.findings.map((f) => [f.checkId, f.url])).toEqual([
      ["price-mismatch", "sanity:supper-apron"],
      ["printful-price", "sanity:ember-tote"],
      ["stripe-no-price", "sanity:tasting-box"],
      ["price-stored-twice", "sanity:hot-sauce"],
    ]);
    // The tote is matched to Printful by name only, and says so.
    expect(only(r, "printful-price")[0]?.evidence).toContain("Printful matched by name");
    // The sticker pack is priced in USD in Stripe and EUR in Printful: a notice, not a finding.
    expect(notes(r, "printful-price")).toHaveLength(1);
    expect(notes(r, "printful-price")[0]).toContain("EUR");
    expect(notes(r, "printful-price")[0]).toContain("USD");
    // Four products store a price twice and agree: the sauce, the tote, the stickers and the free gift card.
    expect(only(r, "price-stored-twice")[0]?.evidence).toContain("4 products");
  });

  it("the result is the same every time (same input, same findings)", async () => {
    const store = await readSupperStore();
    const a = await run(store.match.groups);
    const b = await run(store.match.groups);
    expect(b).toEqual(a);
  });
});

// ---- edge cases ---------------------------------------------------------------------------------

describe("price checks: edge cases", () => {
  it("a product priced in usd in Stripe and eur in Printful: no finding, one notice naming both", async () => {
    const r = await run([
      group(
        sanity("stickers", 600),
        stripe("prod_s", 600),
        printful("1", [
          variant("a", 600, { currency: "EUR" }),
          variant("b", 650, { currency: "EUR" }),
        ]),
      ),
    ]);
    expect(only(r, "printful-price")).toEqual([]);
    const n = notes(r, "printful-price");
    expect(n).toHaveLength(1);
    expect(n[0]).toContain("EUR");
    expect(n[0]).toContain("USD");
    expect(r.passed).not.toContain("printful-price");
  });

  it("a Sanity price of 0 against a Stripe price of 0 (a free product) is equal", async () => {
    const r = await run([group(sanity("gift", 0), stripe("prod_g", 0))]);
    expect(only(r, "price-mismatch")).toEqual([]);
    expect(only(r, "price-stored-twice")).toHaveLength(1);
    const off = await run([group(sanity("gift", 0), stripe("prod_g", 100))]);
    expect(only(off, "price-mismatch")).toHaveLength(1);
  });

  it("a product matched by name only says so in the finding", async () => {
    const r = await run([
      group(sanity("a", 4800), stripe("prod_a", 5200), undefined, { stripe: "name" }),
    ]);
    expect(only(r, "price-mismatch")[0]?.evidence).toContain("matched by name");
  });

  it.each([
    ["saved-id", "matched by saved id"],
    ["metadata-id", "matched by metadata id"],
    ["sku", "matched by SKU"],
    ["name", "matched by name"],
  ] as const)("the %s tier is written as %j", async (tier, words) => {
    const r = await run([
      group(sanity("a", 4800), stripe("prod_a", 5200), undefined, { stripe: tier }),
    ]);
    expect(only(r, "price-mismatch")[0]?.evidence).toContain(words);
  });

  it("40 products that all agree: exactly one low finding for the stored-twice rule", async () => {
    const groups = Array.from({ length: 40 }, (_, i) =>
      group(sanity(`p${i}`, 1000 + i), stripe(`prod_${i}`, 1000 + i)),
    );
    const r = await run(groups);
    expect(r.findings).toHaveLength(1);
    const [f] = only(r, "price-stored-twice");
    expect(f?.severity).toBe("low");
    expect(f?.evidence).toContain("40 products");
    // The list is short, with the rest counted.
    expect(f?.evidence).toContain("and 35 more");
    expect(f?.evidence.length).toBeLessThan(600);
  });

  it("a Stripe product with prices but no default price: the no-default finding and no mismatch", async () => {
    const st = stripe("prod_b", 4500, {
      defaultPriceId: null,
      prices: [usd("price_1", 4500), usd("price_2", 5500)],
    });
    const r = await run([group(sanity("box", 4800), st)]);
    expect(r.findings.map((f) => f.checkId)).toEqual(["stripe-no-price"]);
    expect(only(r, "stripe-no-price")[0]?.evidence).toContain("2 prices");
  });

  it("a null Stripe amount (tiered pricing) is skipped with a notice", async () => {
    const r = await run([group(sanity("a", 4800), stripe("prod_a", null))]);
    expect(r.findings).toEqual([]);
    expect(notes(r, "price-mismatch")[0]).toMatch(/tiered|custom/);
    expect(r.passed).not.toContain("price-mismatch");
  });

  it("a default price that was not in the price list is a notice and not a no-price finding", async () => {
    const st = stripe("prod_a", 5200, { defaultPriceId: "price_missing" });
    const r = await run([group(sanity("a", 4800), st)]);
    expect(r.findings).toEqual([]);
    expect(notes(r, "price-mismatch")[0]).toContain("price_missing");
  });

  it("a Printful variant with no retail price is skipped with one notice", async () => {
    const r = await run([
      group(
        sanity("a", 5200),
        stripe("prod_a", 5200),
        printful("1", [variant("a", null), variant("b", null), variant("c", 5200)]),
      ),
    ]);
    expect(only(r, "printful-price")).toEqual([]);
    expect(notes(r, "printful-price")).toHaveLength(1);
    expect(notes(r, "printful-price")[0]).toContain("2 synced Printful variants");
  });

  it("product text is shown as escapes, not as it came", async () => {
    const hostile = `Tee <script>alert(1)</script>\u202E\u200B`;
    const r = await run([
      group(sanity("t", 4800, { name: hostile }), stripe("prod_t", 5200, { name: hostile })),
    ]);
    const text = only(r, "price-mismatch")[0]?.evidence ?? "";
    expect(text).not.toMatch(/[\u202E\u200B]/);
    expect(text).toContain("\\u{202E}");
  });

  it("a very long name is cut", async () => {
    const r = await run([
      group(sanity("t", 4800, { name: "x".repeat(500) }), stripe("prod_t", 5200)),
    ]);
    expect(only(r, "price-mismatch")[0]?.evidence.length).toBeLessThan(400);
  });

  it("no groups, no findings: every check passes", async () => {
    const r = await run([]);
    expect(r.findings).toEqual([]);
    expect(r.passed).toEqual([...PRICE_CHECK_IDS]);
  });

  it("works on groups from the real matcher", async () => {
    const result = matchProducts(
      [sanity("tee", 2800, { sku: "TEE-1" })],
      [stripe("prod_tee", 3000, { metadata: { sku: "tee-1" } })],
      undefined,
    );
    const r = await run(result.groups);
    const [f] = only(r, "price-mismatch");
    expect(f?.evidence).toContain("matched by SKU");
    expect(f?.evidence).toContain("28.00 USD");
    expect(f?.evidence).toContain("30.00 USD");
  });
});
