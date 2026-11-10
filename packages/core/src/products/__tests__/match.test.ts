import { describe, expect, it } from "vitest";
import type { PrintfulProduct } from "../../connectors/printful.js";
import type { SanityProduct } from "../../connectors/sanity.js";
import type { StripeProduct } from "../../connectors/stripe.js";
import { createFetcher } from "../../fetcher.js";
import { runConnectors } from "../../connectors/run.js";
import { sanityConnector } from "../../connectors/sanity.js";
import { printfulConnector } from "../../connectors/printful.js";
import { stripeConnector } from "../../connectors/stripe.js";
import { useCassette } from "../../../../testkit/src/index.js";
import { TIERS, matchProducts, normaliseName, normaliseSku } from "../match.js";

// Invented products only: a coach's merch (Ridgeline Strength Coaching) and a pop-up kitchen's
// tamal boxes (La Olla Pop-Up).

function sanity(id: string, name: string, more: Partial<SanityProduct> = {}): SanityProduct {
  return { _id: id, name, price: null, ...more };
}
function stripe(
  id: string,
  name: string,
  metadata: Record<string, string> = {},
  active = true,
): StripeProduct {
  return { id, name, active, metadata, defaultPriceId: null, prices: [] };
}
function printful(
  id: string,
  name: string,
  more: { externalId?: string; skus?: (string | undefined)[] } = {},
): PrintfulProduct {
  const p: PrintfulProduct = {
    id,
    name,
    variants: (more.skus ?? []).map((sku, i) => ({
      id: `${id}0${i}`,
      ...(sku === undefined ? {} : { sku }),
      synced: true,
      retailPrice: null,
      currency: "USD",
    })),
  };
  if (more.externalId !== undefined) p.externalId = more.externalId;
  return p;
}

describe("normaliseName: unit", () => {
  it('"Tee", "tee!", " TEE " and "T\u00E9e" are equal; "Tee 2" is different', () => {
    const forms = ["Tee", "tee!", " TEE ", "T\u00E9e"].map(normaliseName);
    expect(new Set(forms)).toEqual(new Set(["tee"]));
    expect(normaliseName("Tee 2")).toBe("tee2");
    expect(normaliseName("Tee 2")).not.toBe(normaliseName("Tee"));
  });

  it("ignores punctuation and spacing inside the name, and reads full-width letters as plain ones", () => {
    expect(normaliseName("Tamal box (a dozen)")).toBe("tamalboxadozen");
    expect(normaliseName("Tamal-Box,  a dozen")).toBe("tamalboxadozen");
    expect(normaliseName("\uFF34\uFF45\uFF45")).toBe("tee");
    expect(normaliseName("Ca\u00F1on")).toBe("canon");
  });

  it("a name with no letters or digits becomes the empty string", () => {
    expect(normaliseName("\u{1F32E}\u{1F32E}")).toBe("");
    expect(normaliseName(" - . ")).toBe("");
  });
});

describe("normaliseSku: unit", () => {
  it("trims and ignores case; an empty or blank SKU has no key", () => {
    expect(normaliseSku(" RL-Tote ")).toBe("rl-tote");
    expect(normaliseSku("")).toBeNull();
    expect(normaliseSku("   ")).toBeNull();
    expect(normaliseSku(undefined)).toBeNull();
  });
});

describe("matchProducts: one table per tier (a pair that matches at that tier and at none higher)", () => {
  it("lists the four tiers in the documented order", () => {
    expect(TIERS).toEqual(["saved-id", "metadata-id", "sku", "name"]);
  });

  it.each([
    [
      "saved-id",
      sanity("tamal-box", "Tamal box", { stripeId: "prod_PopTamal" }),
      stripe("prod_PopTamal", "Something else entirely"),
    ],
    [
      "metadata-id",
      sanity("tamal-box", "Tamal box"),
      stripe("prod_PopTamal", "Something else entirely", { sanityId: "tamal-box" }),
    ],
    [
      "sku",
      sanity("tamal-box", "Tamal box", { sku: "LO-TAMAL-12" }),
      stripe("prod_PopTamal", "Something else entirely", { sku: "lo-tamal-12" }),
    ],
    ["name", sanity("tamal-box", "Tamal box"), stripe("prod_PopTamal", "TAMAL BOX!")],
  ] as const)("Stripe, tier %s", (tier, s, st) => {
    const r = matchProducts([s], [st], []);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ sanity: s, stripe: st, stripeTier: tier });
    expect(r.groups[0]?.printful).toBeUndefined();
    expect(r.groups[0]?.stripeEvidence?.tier).toBe(tier);
    expect(r.unmatchedStripe).toEqual([]);
  });

  it.each([
    [
      "saved-id",
      sanity("hoodie", "Training hoodie", { printfulId: "5002" }),
      printful("5002", "Unrelated", { externalId: "nope" }),
    ],
    [
      "metadata-id",
      sanity("ridgeline-hoodie", "Training hoodie"),
      printful("5002", "Unrelated", { externalId: "ridgeline-hoodie" }),
    ],
    [
      "sku",
      sanity("hoodie", "Training hoodie", { sku: "RL-HOOD-L" }),
      printful("5002", "Unrelated", { skus: ["RL-HOOD-M", "RL-HOOD-L"] }),
    ],
    ["name", sanity("hoodie", "Training hoodie"), printful("5002", "training  HOODIE")],
  ] as const)("Printful, tier %s", (tier, s, pf) => {
    const r = matchProducts([s], [], [pf]);
    expect(r.groups[0]).toMatchObject({ sanity: s, printful: pf, printfulTier: tier });
    expect(r.groups[0]?.stripe).toBeUndefined();
    expect(r.unmatchedPrintful).toEqual([]);
  });

  it("each match names the fields that agreed, never the text of the products", () => {
    const r = matchProducts(
      [sanity("tamal-box", "Tamal box", { sku: "LO-TAMAL" })],
      [stripe("prod_1", "Other", { sku: "LO-TAMAL" })],
      [printful("9", "Tamal box")],
    );
    expect(r.groups[0]?.stripeEvidence).toEqual({
      tier: "sku",
      sanityField: "sku",
      otherField: "metadata.sku",
      sharedWith: [],
    });
    expect(r.groups[0]?.printfulEvidence).toEqual({
      tier: "name",
      sanityField: "name",
      otherField: "name",
      sharedWith: [],
    });
  });

  it("a product matched in Stripe and not in Printful keeps its group and says nothing about Printful", () => {
    const r = matchProducts(
      [sanity("a", "Alpha")],
      [stripe("s1", "Alpha")],
      [printful("p1", "Beta")],
    );
    expect(r.groups[0]?.printfulTier).toBeUndefined();
    expect(r.groups[0]?.printfulEvidence).toBeUndefined();
    expect(r.unmatchedPrintful.map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("matchProducts: precedence", () => {
  it("a product that matches A by saved id and B by SKU gets A, and B stays unmatched", () => {
    const s = sanity("tamal-box", "Tamal box", { stripeId: "prod_A", sku: "LO-TAMAL" });
    const a = stripe("prod_A", "Totally different");
    const b = stripe("prod_B", "Also different", { sku: "LO-TAMAL" });
    const r = matchProducts([s], [b, a], []);
    expect(r.groups[0]?.stripe).toBe(a);
    expect(r.groups[0]?.stripeTier).toBe("saved-id");
    expect(r.unmatchedStripe).toEqual([b]);
  });

  it("metadata beats SKU, and SKU beats name", () => {
    const s = sanity("x", "Tamal box", { sku: "S-1" });
    const byName = stripe("n", "Tamal box");
    const bySku = stripe("k", "Zzz", { sku: "S-1" });
    const byMeta = stripe("m", "Yyy", { sanityId: "x" });
    expect(matchProducts([s], [byName, bySku, byMeta], []).groups[0]?.stripe).toBe(byMeta);
    expect(matchProducts([s], [byName, bySku], []).groups[0]?.stripe).toBe(bySku);
    expect(matchProducts([s], [byName], []).groups[0]?.stripe).toBe(byName);
  });

  it("the two systems are matched on their own: Stripe by SKU and Printful by saved id in the same group", () => {
    const s = sanity("tee", "Tee", { sku: "T-1", printfulId: "77" });
    const st = stripe("s", "Zzz", { sku: "T-1" });
    const pf = printful("77", "Qqq");
    const g = matchProducts([s], [st], [pf]).groups[0];
    expect([g?.stripeTier, g?.printfulTier]).toEqual(["sku", "saved-id"]);
  });
});

describe("matchProducts: the claimed set and ambiguity", () => {
  it("two Sanity products with the same name get one Stripe product between them; the first in order wins", () => {
    const st = stripe("prod_1", "Tamal box");
    const first = sanity("a", "Tamal box");
    const second = sanity("b", "tamal box");
    const r = matchProducts([first, second], [st], []);
    expect(r.groups[0]?.stripe).toBe(st);
    expect(r.groups[1]?.stripe).toBeUndefined();
    expect(r.groups[1]?.sanity).toBe(second);
    expect(r.unmatchedStripe).toEqual([]);
  });

  it("the second Sanity product is reported as ambiguous, not silently unmatched", () => {
    const st = stripe("prod_1", "Tamal box");
    const r = matchProducts([sanity("a", "Tamal box"), sanity("b", "Tamal box")], [st], []);
    expect(r.ambiguous).toEqual([
      {
        sanityId: "b",
        system: "stripe",
        tier: "name",
        reason: "claimed",
        candidates: ["prod_1"],
      },
    ]);
  });

  it("a claimed record ends the search for that system: the second product does not fall to a lower tier", () => {
    const st = stripe("prod_1", "Tamal box", { sku: "LO-TAMAL" });
    const lower = stripe("prod_2", "Tamal box 12");
    const r = matchProducts(
      [sanity("a", "x", { sku: "LO-TAMAL" }), sanity("b", "Tamal box 12", { sku: "LO-TAMAL" })],
      [st, lower],
      [],
    );
    expect(r.groups[1]?.stripe).toBeUndefined();
    expect(r.unmatchedStripe).toEqual([lower]);
    expect(r.ambiguous.map((a) => [a.sanityId, a.reason, a.tier])).toEqual([
      ["b", "claimed", "sku"],
    ]);
  });

  it("two Stripe products with one SKU: the first in input order is matched, the second is left over and the tie is on the record", () => {
    const one = stripe("prod_1", "Alpha", { sku: "DUP" });
    const two = stripe("prod_2", "Beta", { sku: "DUP" });
    const r = matchProducts([sanity("a", "Gamma", { sku: "DUP" })], [one, two], []);
    expect(r.groups[0]?.stripe).toBe(one);
    expect(r.groups[0]?.stripeEvidence?.sharedWith).toEqual(["prod_2"]);
    expect(r.unmatchedStripe).toEqual([two]);
    expect(r.ambiguous).toEqual([
      {
        sanityId: "a",
        system: "stripe",
        tier: "sku",
        reason: "shared-key",
        candidates: ["prod_1", "prod_2"],
        chosen: "prod_1",
      },
    ]);
  });

  it("input order decides contention between Sanity products, but the loser is on the record", () => {
    // The first product reaches the Stripe product by name; the second names it by saved id. The entry's
    // rule is first in order, so the second is left without a partner and says why.
    const st = stripe("prod_1", "Tamal box");
    const r = matchProducts(
      [sanity("a", "Tamal box"), sanity("b", "Tamal box (12)", { stripeId: "prod_1" })],
      [st],
      [],
    );
    expect(r.groups[0]?.stripeTier).toBe("name");
    expect(r.groups[1]?.stripe).toBeUndefined();
    expect(r.ambiguous).toEqual([
      {
        sanityId: "b",
        system: "stripe",
        tier: "saved-id",
        reason: "claimed",
        candidates: ["prod_1"],
      },
    ]);
  });

  it("an unambiguous run has an empty ambiguous list", () => {
    expect(matchProducts([sanity("a", "A")], [stripe("s", "A")], []).ambiguous).toEqual([]);
  });

  it("one Printful product whose variants repeat one SKU is not a tie with itself", () => {
    const pf = printful("5", "Hoodie", { skus: ["H-1", "H-1"] });
    const r = matchProducts([sanity("a", "Zed", { sku: "H-1" })], [], [pf]);
    expect(r.groups[0]?.printful).toBe(pf);
    expect(r.ambiguous).toEqual([]);
  });
});

describe("matchProducts: edge cases", () => {
  it("an empty SKU string never matches another empty SKU", () => {
    const r = matchProducts(
      [sanity("a", "Alpha", { sku: "" })],
      [stripe("s", "Beta", { sku: "" })],
      [printful("p", "Gamma", { skus: [""] })],
    );
    expect(r.groups[0]?.stripe).toBeUndefined();
    expect(r.groups[0]?.printful).toBeUndefined();
    expect(r.unmatchedStripe).toHaveLength(1);
    expect(r.unmatchedPrintful).toHaveLength(1);
  });

  it("a blank saved id and a blank sanityId never match each other", () => {
    const r = matchProducts(
      [sanity("a", "Alpha", { stripeId: "  ", printfulId: "" })],
      [stripe("s", "Beta", { sanityId: "  " })],
      [printful("p", "Gamma", { externalId: "" })],
    );
    expect(r.groups[0]?.stripe).toBeUndefined();
    expect(r.groups[0]?.printful).toBeUndefined();
  });

  it("a saved Stripe id that does not exist in Stripe falls through to tier 2 and does not throw", () => {
    const s = sanity("tamal-box", "Tamal box", { stripeId: "prod_Deleted" });
    const st = stripe("prod_PopTamal", "Other", { sanityId: "tamal-box" });
    const r = matchProducts([s], [st], []);
    expect(r.groups[0]?.stripe).toBe(st);
    expect(r.groups[0]?.stripeTier).toBe("metadata-id");
  });

  it("a name that normalises to the empty string never matches by name", () => {
    const r = matchProducts(
      [sanity("a", "\u{1F32E}\u{1F32E}")],
      [stripe("s", "\u{1F32E}\u{1F32E}"), stripe("t", "")],
      [printful("p", "!!!")],
    );
    expect(r.groups[0]?.stripe).toBeUndefined();
    expect(r.groups[0]?.printful).toBeUndefined();
    expect(r.unmatchedStripe).toHaveLength(2);
  });

  it('"Blue Tee" and "Tee, blue" stay unmatched and show up as leftovers', () => {
    const r = matchProducts([sanity("a", "Blue Tee")], [stripe("s", "Tee, blue")], []);
    expect(r.groups[0]?.stripe).toBeUndefined();
    expect(r.unmatchedStripe.map((p) => p.id)).toEqual(["s"]);
  });

  it("an id match is exact, not case-folded; a SKU match is trimmed and case-folded", () => {
    const wrongCase = matchProducts(
      [sanity("a", "Q", { stripeId: "PROD_1" })],
      [stripe("prod_1", "Z")],
      [],
    );
    expect(wrongCase.groups[0]?.stripe).toBeUndefined();
    const sku = matchProducts(
      [sanity("a", "Q", { sku: " rl-tote " })],
      [stripe("s", "Z", { sku: "RL-TOTE" })],
      [],
    );
    expect(sku.groups[0]?.stripeTier).toBe("sku");
  });

  it("Sanity not configured: groups is empty and every Stripe and Printful product is unmatched", () => {
    const sts = [stripe("s1", "A"), stripe("s2", "B")];
    const pfs = [printful("p1", "A")];
    for (const none of [undefined, []]) {
      const r = matchProducts(none, sts, pfs);
      expect(r.groups).toEqual([]);
      expect(r.unmatchedStripe).toEqual(sts);
      expect(r.unmatchedPrintful).toEqual(pfs);
      expect(r.ambiguous).toEqual([]);
    }
  });

  it("Stripe or Printful not configured: Sanity products keep their groups alone", () => {
    const s = [sanity("a", "A"), sanity("b", "B")];
    const r = matchProducts(s, undefined, undefined);
    expect(r.groups.map((g) => g.sanity)).toEqual(s);
    expect(r.unmatchedStripe).toEqual([]);
  });

  it("groups come out in Sanity input order, one per Sanity product", () => {
    const s = ["c", "a", "b"].map((id) => sanity(id, id.toUpperCase()));
    expect(matchProducts(s, [], []).groups.map((g) => g.sanity?._id)).toEqual(["c", "a", "b"]);
  });

  it("does not change what it is given", () => {
    const s = [sanity("a", "A", { sku: "X" })];
    const st = [stripe("s", "A", { sku: "X" })];
    const before = JSON.stringify([s, st]);
    matchProducts(s, st, []);
    expect(JSON.stringify([s, st])).toBe(before);
  });

  it("2,000 products per system finish in well under a second (the budget is 100 ms, asserted loosely)", () => {
    const n = 2000;
    const s = Array.from({ length: n }, (_, i) =>
      sanity(`s${i}`, `Product ${i}`, { sku: `K${i}` }),
    );
    const st = Array.from({ length: n }, (_, i) =>
      stripe(`st${i}`, `Other ${i}`, { sku: `K${i}` }),
    );
    const pf = Array.from({ length: n }, (_, i) => printful(`${i}`, `Product ${i}`));
    const t0 = performance.now();
    const r = matchProducts(s, st, pf);
    const ms = performance.now() - t0;
    expect(r.groups).toHaveLength(n);
    expect(r.groups.every((g) => g.stripeTier === "sku" && g.printfulTier === "name")).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
});

describe("matchProducts: determinism", () => {
  const s = [
    sanity("a", "Alpha", { sku: "SK" }),
    sanity("b", "Beta", { stripeId: "prod_B" }),
    sanity("c", "Gamma"),
  ];
  const st = [
    stripe("prod_B", "Beta"),
    stripe("prod_X", "Alpha", { sku: "SK" }),
    stripe("prod_Y", "Gamma"),
    stripe("prod_Z", "Delta"),
  ];
  const pf = [
    printful("1", "Alpha"),
    printful("2", "Gamma", { externalId: "c" }),
    printful("3", "Epsilon"),
  ];

  const summary = (r: ReturnType<typeof matchProducts>) => ({
    groups: r.groups.map((g) => [
      g.sanity?._id,
      g.stripe?.id,
      g.stripeTier,
      g.printful?.id,
      g.printfulTier,
    ]),
    st: r.unmatchedStripe.map((p) => p.id).sort(),
    pf: r.unmatchedPrintful.map((p) => p.id).sort(),
  });

  it("the same input twice gives the same answer", () => {
    expect(summary(matchProducts(s, st, pf))).toEqual(summary(matchProducts(s, st, pf)));
  });

  it("every order of the Stripe and Printful lists gives the same groups when there are no ties", () => {
    const want = summary(matchProducts(s, st, pf));
    const orders = [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ];
    for (const o of orders) {
      const shuffledStripe = o.map((i) => st[i] as StripeProduct);
      const shuffledPrintful = [pf[2], pf[0], pf[1]] as PrintfulProduct[];
      expect(summary(matchProducts(s, shuffledStripe, shuffledPrintful))).toEqual(want);
    }
  });
});

describe("matchProducts: the coach's merch across the three recorded systems", () => {
  async function read() {
    const run = await runConnectors(
      [sanityConnector, stripeConnector, printfulConnector],
      {
        SANITY_PROJECT_ID: "ridge7st",
        STRIPE_API_KEY: ["rk", "test", "ridgeline", "0123456789abcdefghij"].join("_"),
        PRINTFUL_API_TOKEN: ["pf", "ridgeline", "0123456789abcdef"].join("-"),
        PRINTFUL_STORE_ID: "3141592",
      },
      createFetcher({
        transport: (url, req) => {
          const name = url.hostname.endsWith("sanity.io")
            ? "sanity-match-merch"
            : url.hostname === "api.stripe.com"
              ? "stripe-match-merch"
              : "printful-merch";
          return useCassette(name, { mode: "replay" })(url, req);
        },
      }),
    );
    return run;
  }

  it("reads six products in Sanity, six in Stripe and five in Printful", async () => {
    const run = await read();
    expect(run.data.get("sanity")).toHaveLength(6);
    expect(run.data.get("stripe")).toHaveLength(6);
    expect(run.data.get("printful")).toHaveLength(5);
  });

  it("groups them as recorded in the snapshot", async () => {
    const run = await read();
    const r = matchProducts(
      run.data.get("sanity") as SanityProduct[],
      run.data.get("stripe") as StripeProduct[],
      run.data.get("printful") as PrintfulProduct[],
    );
    expect({
      groups: r.groups.map((g) => ({
        sanity: g.sanity?._id,
        stripe: g.stripe?.id ?? null,
        stripeTier: g.stripeTier ?? null,
        printful: g.printful?.id ?? null,
        printfulTier: g.printfulTier ?? null,
      })),
      unmatchedStripe: r.unmatchedStripe.map((p) => p.id),
      unmatchedPrintful: r.unmatchedPrintful.map((p) => p.id),
      ambiguous: r.ambiguous,
    }).toMatchSnapshot();
  });

  it("shuffling the Stripe and Printful input does not change the groups", async () => {
    const run = await read();
    const sa = run.data.get("sanity") as SanityProduct[];
    const st = run.data.get("stripe") as StripeProduct[];
    const pf = run.data.get("printful") as PrintfulProduct[];
    const want = JSON.stringify(matchProducts(sa, st, pf).groups);
    expect(JSON.stringify(matchProducts(sa, [...st].reverse(), [...pf].reverse()).groups)).toBe(
      want,
    );
    const rotate = <T>(a: T[], k: number) => [...a.slice(k), ...a.slice(0, k)];
    expect(JSON.stringify(matchProducts(sa, rotate(st, 2), rotate(pf, 3)).groups)).toBe(want);
  });
});
