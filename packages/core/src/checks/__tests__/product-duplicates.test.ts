import { describe, expect, it } from "vitest";
import type { Finding } from "../../model.js";
import {
  bakehouseStore,
  harborStore,
  printfulProduct,
  sanityProduct,
  stripeAt,
  stripePrice,
  stripeProduct,
} from "../../products/__tests__/duplicate-store.js";
import { runChecks, type RunResult } from "../../run.js";
import {
  DUPLICATE_CHECKS,
  DUPLICATE_CHECK_IDS,
  DUPLICATE_LIST_MAX,
  createDuplicatesRegistry,
  duplicatesInput,
  findDuplicates,
  type ProductDuplicatesInput,
} from "../product-duplicates.js";
import { normaliseName } from "../../products/match.js";

const run = (i: ProductDuplicatesInput) => runChecks(i, createDuplicatesRegistry());
const only = (r: RunResult, id: string): Finding[] => r.findings.filter((f) => f.checkId === id);

// ---- unit: findDuplicates ------------------------------------------------------------------------

describe("findDuplicates: unit", () => {
  const key = (r: { k?: string }) => r.k;

  it("returns [] when no key is shared", () => {
    expect(findDuplicates([{ k: "a" }, { k: "b" }, { k: "c" }], key)).toEqual([]);
    expect(findDuplicates([], key)).toEqual([]);
  });

  it("three copies of one key come back as one group of three, in input order", () => {
    const records = [
      { k: "a", n: 1 },
      { k: "b", n: 2 },
      { k: "a", n: 3 },
      { k: "a", n: 4 },
    ];
    const groups = findDuplicates(records, key);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((r) => (r as { n: number }).n)).toEqual([1, 3, 4]);
  });

  it("orders groups by the first record of each, not by size or key", () => {
    const records = [{ k: "z" }, { k: "m" }, { k: "m" }, { k: "z" }, { k: "z" }, { k: "a" }];
    expect(findDuplicates(records, key).map((g) => g[0]?.k)).toEqual(["z", "m"]);
  });

  it("an empty or undefined key is never a group", () => {
    const records = [{ k: "" }, { k: "" }, {}, {}, { k: undefined }];
    expect(findDuplicates(records, key)).toEqual([]);
  });

  it("keeps the same record objects it was given", () => {
    const a = { k: "x" };
    const b = { k: "x" };
    const [group] = findDuplicates([a, b], key);
    expect(group?.[0]).toBe(a);
    expect(group?.[1]).toBe(b);
  });

  it("groups names through normaliseName: Classic Tee and classic-tee are one", () => {
    const names = [{ name: "Classic Tee" }, { name: "Mug" }, { name: "classic-tee" }];
    const groups = findDuplicates(names, (r) => normaliseName(r.name));
    expect(groups).toEqual([[{ name: "Classic Tee" }, { name: "classic-tee" }]]);
  });
});

describe("product duplicate checks: registration", () => {
  it("three checks, medium, in Sales & prices, each with its text", () => {
    expect(DUPLICATE_CHECK_IDS).toEqual([
      "duplicate-printful",
      "duplicate-sanity",
      "duplicate-stripe",
    ]);
    expect(DUPLICATE_CHECKS.map((c) => c.id)).toEqual([...DUPLICATE_CHECK_IDS]);
    for (const c of DUPLICATE_CHECKS) {
      expect(c.severity).toBe("medium");
      expect(c.area).toBe("Sales & prices");
      for (const f of ["title", "what", "why", "fix", "tech"] as const)
        expect(c[f].trim()).not.toBe("");
    }
    expect(createDuplicatesRegistry().size).toBe(3);
  });
});

// ---- duplicate-stripe ---------------------------------------------------------------------------

describe("duplicate-stripe: unit", () => {
  it("fires once for two active products that share a normalised name, listing both ids", async () => {
    const r = await run({
      stripe: [stripeAt("prod_a", "Classic Tee", 2800), stripeAt("prod_b", "classic-tee", 2800)],
    });
    const [f] = only(r, "duplicate-stripe");
    expect(only(r, "duplicate-stripe")).toHaveLength(1);
    expect(f?.severity).toBe("medium");
    expect(f?.evidence).toContain("prod_a");
    expect(f?.evidence).toContain("prod_b");
    expect(f?.evidence).toContain('"Classic Tee"');
    expect(f?.evidence).toContain('"classic-tee"');
    expect(f?.url).toBe("stripe:prod_a");
  });

  it("does not fire for distinct names, and records the pass", async () => {
    const r = await run({
      stripe: [stripeAt("prod_a", "Tee", 2800), stripeAt("prod_b", "Tees", 2800)],
    });
    expect(r.findings).toEqual([]);
    expect(r.passed).toContain("duplicate-stripe");
  });

  it("says keep one, archive the rest and point the website at the one kept, and does not choose", async () => {
    const r = await run({
      stripe: [stripeAt("prod_a", "Mug", 1200), stripeAt("prod_b", "Mug", 1200)],
    });
    const text = only(r, "duplicate-stripe")[0]?.evidence ?? "";
    expect(text).toMatch(/Keep one, archive the rest and point the website at the one you keep\./);
    expect(text).not.toMatch(/keep prod_/i);
    expect(text).not.toMatch(/\boldest\b|\bnewest\b|\bcheapest\b/i);
  });

  it("two copies with different default prices: both prices are in the detail", async () => {
    const r = await run({
      stripe: [stripeAt("prod_a", "Gift card", 2500), stripeAt("prod_b", "Gift card", 5000)],
    });
    const text = only(r, "duplicate-stripe")[0]?.evidence ?? "";
    expect(text).toContain("25.00 USD");
    expect(text).toContain("50.00 USD");
    expect(text).toMatch(/different prices/);
  });

  it("copies with the same price do not say they differ", async () => {
    const r = await run({
      stripe: [stripeAt("prod_a", "Gift card", 2500), stripeAt("prod_b", "Gift card", 2500)],
    });
    expect(only(r, "duplicate-stripe")[0]?.evidence).not.toMatch(/different prices/);
  });

  it("names a missing default price, an unread default price and an amount-less price", async () => {
    const r = await run({
      stripe: [
        stripeProduct("prod_a", "Pass"),
        stripeProduct("prod_b", "Pass", { defaultPriceId: "price_gone" }),
        stripeProduct("prod_c", "Pass", {
          defaultPriceId: "price_c",
          prices: [stripePrice("price_c", null)],
        }),
      ],
    });
    const text = only(r, "duplicate-stripe")[0]?.evidence ?? "";
    expect(text).toContain("no default price");
    expect(text).toContain("default price not read");
    expect(text).toContain("no fixed amount");
  });

  it("one active and one archived product with one name: no finding", async () => {
    const r = await run({
      stripe: [
        stripeAt("prod_a", "Hoodie", 5800),
        stripeAt("prod_b", "Hoodie", 5800, { active: false }),
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.passed).toContain("duplicate-stripe");
  });

  it("two archived products with one name: no finding", async () => {
    const r = await run({
      stripe: [
        stripeAt("prod_a", "Hoodie", 5800, { active: false }),
        stripeAt("prod_b", "Hoodie", 5800, { active: false }),
      ],
    });
    expect(r.findings).toEqual([]);
  });

  it("mentions archived siblings in the detail when the group exists, and does not count them", async () => {
    const r = await run({
      stripe: [
        stripeAt("prod_a", "Hoodie", 5800),
        stripeAt("prod_old", "hoodie", 5800, { active: false }),
        stripeAt("prod_b", "Hoodie", 5800),
      ],
    });
    const [f] = only(r, "duplicate-stripe");
    expect(f?.evidence).toMatch(/2 active products/);
    expect(f?.evidence).toMatch(/1 archived product with the same name is not counted: prod_old/);
  });

  it("40 products named Gift card on purpose: one finding, 40 counted, 10 listed", async () => {
    const stripe = Array.from({ length: 40 }, (_, n) =>
      stripeAt(`prod_g${n}`, "Gift card", 1000 + n),
    );
    const r = await run({ stripe });
    const [f] = only(r, "duplicate-stripe");
    expect(only(r, "duplicate-stripe")).toHaveLength(1);
    expect(f?.evidence).toMatch(/^40 active products/);
    expect(DUPLICATE_LIST_MAX).toBe(10);
    for (let n = 0; n < 10; n++) expect(f?.evidence).toContain(`prod_g${n} `);
    expect(f?.evidence).not.toContain("prod_g10 ");
    expect(f?.evidence).toContain("and 30 more");
  });

  it("names made only of emoji normalise to nothing and are never grouped", async () => {
    const r = await run({
      stripe: [
        stripeAt("prod_a", "\u{1F355}", 100),
        stripeAt("prod_b", "\u{1F355}", 100),
        stripeAt("prod_c", "  ", 100),
      ],
    });
    expect(r.findings).toEqual([]);
  });

  it("one finding per group, in the order each group first appears", async () => {
    const r = await run({
      stripe: [
        stripeAt("prod_1", "Zine", 500),
        stripeAt("prod_2", "Mug", 900),
        stripeAt("prod_3", "mug", 900),
        stripeAt("prod_4", "Zine", 500),
        stripeAt("prod_5", "Pin", 300),
      ],
    });
    expect(only(r, "duplicate-stripe").map((f) => f.url)).toEqual([
      "stripe:prod_1",
      "stripe:prod_2",
    ]);
  });

  it("escapes invisible characters and cuts a long name", async () => {
    const r = await run({
      stripe: [
        stripeAt("prod_a", "Tee\u200B<script>alert(1)</script>", 100),
        stripeAt("prod_b", "Tee<script>alert(1)</script>", 100),
        stripeAt("prod_c", `Tee${"x".repeat(400)}`, 100),
      ],
    });
    const text = only(r, "duplicate-stripe")[0]?.evidence ?? "";
    expect(text).toContain("\\u{200B}");
    expect(text).not.toContain("\u200B");
    expect(text.length).toBeLessThan(1500);
  });
});

// ---- duplicate-sanity ---------------------------------------------------------------------------

describe("duplicate-sanity: unit", () => {
  it("fires for two products with one normalised name, naming both _ids", async () => {
    const r = await run({
      sanity: [sanityProduct("tee-1", "Classic Tee"), sanityProduct("tee-2", "classic tee!")],
    });
    const [f] = only(r, "duplicate-sanity");
    expect(only(r, "duplicate-sanity")).toHaveLength(1);
    expect(f?.severity).toBe("medium");
    expect(f?.evidence).toContain("tee-1");
    expect(f?.evidence).toContain("tee-2");
    expect(f?.evidence).toMatch(
      /Keep one, archive the rest and point the website at the one you keep\./,
    );
    expect(f?.url).toBe("sanity:tee-1");
  });

  it("fires for a shared SKU under different names, ignoring case and spacing around it", async () => {
    const r = await run({
      sanity: [
        sanityProduct("a", "Tote", { sku: "MB-TOTE" }),
        sanityProduct("b", "Canvas bag", { sku: " mb-tote " }),
      ],
    });
    const [f] = only(r, "duplicate-sanity");
    expect(only(r, "duplicate-sanity")).toHaveLength(1);
    expect(f?.evidence).toMatch(/SKU/);
    expect(f?.evidence).toContain("MB-TOTE");
  });

  it("an empty or blank SKU is never a group", async () => {
    const r = await run({
      sanity: [
        sanityProduct("a", "Tote", { sku: "" }),
        sanityProduct("b", "Bag", { sku: "  " }),
        sanityProduct("c", "Sack"),
        sanityProduct("d", "Pouch"),
      ],
    });
    expect(r.findings).toEqual([]);
  });

  it("a pair that shares name and SKU is one finding, under the name", async () => {
    const r = await run({
      sanity: [
        sanityProduct("a", "Tote", { sku: "S1" }),
        sanityProduct("b", "tote", { sku: "S1" }),
      ],
    });
    const found = only(r, "duplicate-sanity");
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toMatch(/share the name/);
    expect(found[0]?.evidence).not.toMatch(/SKU/);
  });

  it("a record in a name group and a SKU group is reported once, in the name group", async () => {
    const r = await run({
      sanity: [
        sanityProduct("a", "Tote"),
        sanityProduct("b", "tote", { sku: "S9" }),
        sanityProduct("c", "Canvas bag", { sku: "S9" }),
      ],
    });
    const found = only(r, "duplicate-sanity");
    expect(found).toHaveLength(2);
    const [byName, bySku] = found;
    expect(byName?.evidence).toContain("a ");
    expect(byName?.evidence).toContain("b ");
    expect(byName?.evidence).not.toMatch(/\bc "Canvas/);
    // The SKU finding lists only the new copy and says where the other one was reported.
    expect(bySku?.evidence).toContain('c "Canvas bag"');
    expect(bySku?.evidence).not.toContain('b "tote"');
    expect(bySku?.evidence).toMatch(/also on b \(reported under its name\)/);
    // Every record is listed as a copy in exactly one finding.
    const listed = found.map((f) => (f.evidence.match(/\b[abc] "/g) ?? []).length);
    expect(listed.reduce((x, y) => x + y, 0)).toBe(3);
  });

  it("finds nothing when Sanity was not read or returned no products", async () => {
    expect(only(await run({ stripe: [] }), "duplicate-sanity")).toEqual([]);
    expect((await run({ sanity: [] })).findings).toEqual([]);
  });
});

// ---- duplicate-printful -------------------------------------------------------------------------

describe("duplicate-printful: unit", () => {
  it("fires for a shared normalised name", async () => {
    const r = await run({
      printful: [printfulProduct("1", "Marigold Apron"), printfulProduct("2", "marigold-apron")],
    });
    const [f] = only(r, "duplicate-printful");
    expect(only(r, "duplicate-printful")).toHaveLength(1);
    expect(f?.severity).toBe("medium");
    expect(f?.evidence).toContain("Printful");
    expect(f?.url).toBe("printful:1");
  });

  it("fires for a shared external id under different names", async () => {
    const r = await run({
      printful: [
        printfulProduct("1", "Apron", { externalId: "mb-apron" }),
        printfulProduct("2", "Apron, navy", { externalId: "mb-apron" }),
        printfulProduct("3", "Tote", { externalId: "mb-tote" }),
      ],
    });
    const [f] = only(r, "duplicate-printful");
    expect(only(r, "duplicate-printful")).toHaveLength(1);
    expect(f?.evidence).toMatch(/external id/);
    expect(f?.evidence).toContain("mb-apron");
  });

  it("a missing or blank external id is never a group", async () => {
    const r = await run({
      printful: [
        printfulProduct("1", "A", { externalId: "" }),
        printfulProduct("2", "B", { externalId: " " }),
        printfulProduct("3", "C"),
        printfulProduct("4", "D"),
      ],
    });
    expect(r.findings).toEqual([]);
  });

  it("a record that shares a name with one and an external id with another is listed once", async () => {
    const r = await run({
      printful: [
        printfulProduct("1", "Apron"),
        printfulProduct("2", "apron", { externalId: "x" }),
        printfulProduct("3", "Pinny", { externalId: "x" }),
      ],
    });
    const found = only(r, "duplicate-printful");
    expect(found).toHaveLength(2);
    expect(found[1]?.evidence).toMatch(/also on 2 \(reported under its name\)/);
    expect(found[1]?.evidence).not.toContain('2 "apron"');
  });
});

// ---- input --------------------------------------------------------------------------------------

describe("duplicatesInput", () => {
  it("takes each system's records from the connector run, and leaves out a system that gave none", () => {
    const stripe = [stripeAt("prod_a", "Mug", 100)];
    const i = duplicatesInput({ data: new Map<string, unknown[]>([["stripe", stripe]]) });
    expect(i.stripe).toBe(stripe);
    expect("sanity" in i).toBe(false);
    expect("printful" in i).toBe(false);
  });

  it("runs before and without the matcher: no match result is needed", async () => {
    const i = duplicatesInput({
      data: new Map<string, unknown[]>([["sanity", [sanityProduct("a", "X")]]]),
    });
    expect((await run(i)).findings).toEqual([]);
  });
});

// ---- integration --------------------------------------------------------------------------------

describe("product duplicates: integration", () => {
  it("one name stored three ways across the CMS, checkout and the supplier is not a duplicate; the true duplicate inside Stripe is", async () => {
    const r = await run(harborStore());
    expect(r.findings.map((f) => f.checkId)).toEqual(["duplicate-stripe"]);
    expect(only(r, "duplicate-sanity")).toEqual([]);
    expect(only(r, "duplicate-printful")).toEqual([]);
    expect(r.passed).toEqual(expect.arrayContaining(["duplicate-sanity", "duplicate-printful"]));
    const text = r.findings[0]?.evidence ?? "";
    expect(text).toContain("prod_HarborGift25");
    expect(text).toContain("prod_HarborGift50");
    expect(text).toContain("25.00 USD");
    expect(text).toContain("50.00 USD");
    // The tee is not in the finding at all.
    expect(text).not.toContain("prod_HarborTee");
  });

  it("the pop-up bakery's shop gets one finding per system, and the same ones on a second run", async () => {
    const first = await run(bakehouseStore());
    const second = await run(bakehouseStore());
    expect(first.findings).toEqual(second.findings);
    expect(first.findings.map((f) => [f.checkId, f.url])).toEqual([
      ["duplicate-printful", "printful:8201"],
      ["duplicate-sanity", "sanity:mb-tote"],
      ["duplicate-sanity", "sanity:mb-tote-2"],
      ["duplicate-stripe", "stripe:prod_MbGift25"],
    ]);
  });

  it("does not change its input", async () => {
    const store = bakehouseStore();
    const before = JSON.stringify(store);
    await run(store);
    expect(JSON.stringify(store)).toBe(before);
  });
});
