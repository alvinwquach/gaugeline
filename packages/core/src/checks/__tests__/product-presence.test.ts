import { describe, expect, it } from "vitest";
import type { PrintfulProduct, PrintfulVariant } from "../../connectors/printful.js";
import type { SanityProduct } from "../../connectors/sanity.js";
import type { StripeProduct } from "../../connectors/stripe.js";
import type { Finding } from "../../model.js";
import type { ProductGroup } from "../../products/match.js";
import { readSurfStore } from "../../products/__tests__/presence-store.js";
import { runChecks, type RunResult } from "../../run.js";
import {
  PRESENCE_CHECKS,
  PRESENCE_CHECK_IDS,
  createPresenceRegistry,
  presenceInput,
  summarisePresence,
  type ProductPresenceInput,
} from "../product-presence.js";

// ---- builders -----------------------------------------------------------------------------------

const sanity = (id: string, extra: Partial<SanityProduct> = {}): SanityProduct => ({
  _id: id,
  name: `Name of ${id}`,
  price: null,
  ...extra,
});

const stripe = (id: string, extra: Partial<StripeProduct> = {}): StripeProduct => ({
  id,
  name: `Stripe ${id}`,
  active: true,
  metadata: {},
  defaultPriceId: null,
  prices: [],
  ...extra,
});

const variant = (id: string, synced: boolean, extra: Partial<PrintfulVariant> = {}) =>
  ({ id, synced, retailPrice: null, currency: "USD", ...extra }) satisfies PrintfulVariant;

const printful = (id: string, variants: PrintfulVariant[] = []): PrintfulProduct => ({
  id,
  name: `Printful ${id}`,
  variants,
});

const group = (s: SanityProduct, st?: StripeProduct, pf?: PrintfulProduct): ProductGroup => ({
  sanity: s,
  ...(st ? { stripe: st, stripeTier: "saved-id" as const } : {}),
  ...(pf ? { printful: pf, printfulTier: "saved-id" as const } : {}),
});

/** Every system answered, nothing left over, unless the test says otherwise. */
const input = (
  groups: ProductGroup[],
  extra: Partial<ProductPresenceInput> = {},
): ProductPresenceInput => ({
  groups,
  unmatchedStripe: [],
  unmatchedPrintful: [],
  read: { sanity: true, stripe: true, printful: true },
  ...extra,
});

const run = (i: ProductPresenceInput) => runChecks(i, createPresenceRegistry());
const only = (r: RunResult, id: string): Finding[] => r.findings.filter((f) => f.checkId === id);

// ---- unit ---------------------------------------------------------------------------------------

describe("product presence checks: registration", () => {
  it("the six checks are registered with the model, in id order, in Sales & prices", () => {
    expect(PRESENCE_CHECK_IDS).toEqual([
      "printful-missing",
      "printful-orphan",
      "printful-unsynced",
      "stripe-archived",
      "stripe-missing",
      "stripe-orphan",
    ]);
    expect(PRESENCE_CHECKS.map((c) => c.id)).toEqual([...PRESENCE_CHECK_IDS]);
    expect(PRESENCE_CHECKS.map((c) => c.severity)).toEqual([
      "low",
      "low",
      "high",
      "high",
      "high",
      "low",
    ]);
    for (const c of PRESENCE_CHECKS) {
      expect(c.area).toBe("Sales & prices");
      for (const field of ["title", "what", "why", "fix", "tech"] as const)
        expect(c[field].trim()).not.toBe("");
    }
    expect(createPresenceRegistry().size).toBe(6);
  });
});

describe("stripe-missing: unit", () => {
  it("fires for a website product with no Stripe partner, with the name and the Sanity id", async () => {
    const r = await run(input([group(sanity("poster", { name: "Swell poster" }))]));
    const [f] = only(r, "stripe-missing");
    expect(only(r, "stripe-missing")).toHaveLength(1);
    expect(f?.severity).toBe("high");
    expect(f?.evidence).toContain('"Swell poster"');
    expect(f?.evidence).toContain("poster");
    expect(f?.url).toBe("sanity:poster");
  });

  it("does not fire when the product has a Stripe partner", async () => {
    const r = await run(input([group(sanity("tee"), stripe("prod_tee"))]));
    expect(only(r, "stripe-missing")).toEqual([]);
    expect(r.passed).toContain("stripe-missing");
  });

  it("does not fire when Stripe was not read: a failed connector is not a missing product", async () => {
    const i = input([group(sanity("poster"))], {
      read: { sanity: true, stripe: false, printful: true },
    });
    expect(only(await run(i), "stripe-missing")).toEqual([]);
  });

  it("does not fire when Sanity was not read", async () => {
    const i = input([], { read: { sanity: false, stripe: true, printful: true } });
    expect(only(await run(i), "stripe-missing")).toEqual([]);
  });
});

describe("stripe-archived: unit", () => {
  it("fires when the matched Stripe product has active false, with both ids", async () => {
    const r = await run(input([group(sanity("hoodie"), stripe("prod_hoodie", { active: false }))]));
    const [f] = only(r, "stripe-archived");
    expect(only(r, "stripe-archived")).toHaveLength(1);
    expect(f?.severity).toBe("high");
    expect(f?.evidence).toContain("archived");
    expect(f?.evidence).toContain("hoodie");
    expect(f?.evidence).toContain("prod_hoodie");
    expect(f?.url).toBe("sanity:hoodie");
  });

  it("does not fire for an active product", async () => {
    const r = await run(input([group(sanity("tee"), stripe("prod_tee"))]));
    expect(only(r, "stripe-archived")).toEqual([]);
    expect(r.passed).toContain("stripe-archived");
  });

  it("an archived Stripe product that nothing matches produces nothing", async () => {
    const r = await run(
      input([group(sanity("tee"), stripe("prod_tee"))], {
        unmatchedStripe: [stripe("prod_old", { active: false })],
        read: { sanity: true, stripe: true, printful: false },
      }),
    );
    expect(r.findings).toEqual([]);
  });

  it("does not fire when Stripe was not read", async () => {
    const i = input([group(sanity("hoodie"), stripe("prod_hoodie", { active: false }))], {
      read: { sanity: true, stripe: false, printful: true },
    });
    expect(only(await run(i), "stripe-archived")).toEqual([]);
  });
});

describe("stripe-orphan: unit", () => {
  it("fires for an active Stripe product nothing matches, low, with its name and id", async () => {
    const r = await run(
      input([], { unmatchedStripe: [stripe("prod_voucher", { name: "Surf voucher" })] }),
    );
    const [f] = only(r, "stripe-orphan");
    expect(only(r, "stripe-orphan")).toHaveLength(1);
    expect(f?.severity).toBe("low");
    expect(f?.evidence).toContain('"Surf voucher"');
    expect(f?.evidence).toContain("prod_voucher");
    expect(f?.evidence).toMatch(/payment link/i);
    expect(f?.url).toBe("stripe:prod_voucher");
  });

  it("does not fire for an archived one", async () => {
    const r = await run(input([], { unmatchedStripe: [stripe("prod_old", { active: false })] }));
    expect(only(r, "stripe-orphan")).toEqual([]);
    expect(r.passed).toContain("stripe-orphan");
  });

  it("does not fire when Stripe was not read, or when Sanity was not (nothing could match)", async () => {
    const leftover = [stripe("prod_voucher")];
    const noStripe = input([], {
      unmatchedStripe: leftover,
      read: { sanity: true, stripe: false, printful: true },
    });
    const noSanity = input([], {
      unmatchedStripe: leftover,
      read: { sanity: false, stripe: true, printful: true },
    });
    expect(only(await run(noStripe), "stripe-orphan")).toEqual([]);
    expect(only(await run(noSanity), "stripe-orphan")).toEqual([]);
  });
});

describe("printful-unsynced: unit", () => {
  it("fires when a matched product has a variant with synced false, listing it, high", async () => {
    const pf = printful("7003", [
      variant("1", true, { sku: "TOTE-N" }),
      variant("2", false, { sku: "TOTE-B" }),
    ]);
    const r = await run(input([group(sanity("tote"), stripe("prod_tote"), pf)]));
    const [f] = only(r, "printful-unsynced");
    expect(only(r, "printful-unsynced")).toHaveLength(1);
    expect(f?.severity).toBe("high");
    expect(f?.evidence).toContain("TOTE-B");
    expect(f?.evidence).not.toContain("TOTE-N");
    expect(f?.evidence).toContain("7003");
    expect(f?.evidence).toContain("1 of 2");
    expect(f?.url).toBe("sanity:tote");
  });

  it("names a variant that has no SKU by its id", async () => {
    const pf = printful("7003", [variant("70031", false)]);
    const r = await run(input([group(sanity("tote"), undefined, pf)]));
    expect(only(r, "printful-unsynced")[0]?.evidence).toContain("variant 70031");
  });

  it("does not fire when every variant is synced, or the product has no variants", async () => {
    const r = await run(
      input([
        group(sanity("a"), undefined, printful("1", [variant("1", true)])),
        group(sanity("b"), undefined, printful("2", [])),
      ]),
    );
    expect(only(r, "printful-unsynced")).toEqual([]);
    expect(r.passed).toContain("printful-unsynced");
  });

  it("does not fire when Printful was not read", async () => {
    const i = input([group(sanity("a"), undefined, printful("1", [variant("1", false)]))], {
      read: { sanity: true, stripe: true, printful: false },
    });
    expect(only(await run(i), "printful-unsynced")).toEqual([]);
  });

  it("an unsynced product that nothing matches is not reported (it is an orphan, if anything)", async () => {
    const i = input([], { unmatchedPrintful: [printful("9", [variant("1", false)])] });
    expect(only(await run(i), "printful-unsynced")).toEqual([]);
  });
});

describe("printful-missing: unit", () => {
  it("fires for a website product with no Printful partner, low, and says that is expected for a digital product", async () => {
    const r = await run(input([group(sanity("wallpaper", { name: "Wallpaper pack" }))]));
    const [f] = only(r, "printful-missing");
    expect(only(r, "printful-missing")).toHaveLength(1);
    expect(f?.severity).toBe("low");
    expect(f?.evidence).toContain('"Wallpaper pack"');
    expect(f?.evidence).toMatch(/digital product/i);
    expect(f?.url).toBe("sanity:wallpaper");
  });

  it("does not fire when the product has a Printful partner", async () => {
    const r = await run(input([group(sanity("tee"), undefined, printful("1"))]));
    expect(only(r, "printful-missing")).toEqual([]);
    expect(r.passed).toContain("printful-missing");
  });

  it("does not fire when Printful was not read", async () => {
    const i = input([group(sanity("tee"))], {
      read: { sanity: true, stripe: true, printful: false },
    });
    expect(only(await run(i), "printful-missing")).toEqual([]);
  });
});

describe("printful-orphan: unit", () => {
  it("fires for a Printful product nothing matches, low, with its name and id", async () => {
    const r = await run(
      input([], {
        unmatchedPrintful: [printful("9001", [])].map((p) => ({ ...p, name: "Sample sheet" })),
      }),
    );
    const [f] = only(r, "printful-orphan");
    expect(only(r, "printful-orphan")).toHaveLength(1);
    expect(f?.severity).toBe("low");
    expect(f?.evidence).toContain('"Sample sheet"');
    expect(f?.evidence).toContain("9001");
    expect(f?.url).toBe("printful:9001");
  });

  it("does not fire when Printful was not read, or when Sanity was not", async () => {
    const leftover = [printful("9001")];
    const noPrintful = input([], {
      unmatchedPrintful: leftover,
      read: { sanity: true, stripe: true, printful: false },
    });
    const noSanity = input([], {
      unmatchedPrintful: leftover,
      read: { sanity: false, stripe: true, printful: true },
    });
    expect(only(await run(noPrintful), "printful-orphan")).toEqual([]);
    expect(only(await run(noSanity), "printful-orphan")).toEqual([]);
  });

  it("does not fire when there are no leftovers", async () => {
    const r = await run(input([group(sanity("tee"), undefined, printful("1"))]));
    expect(r.passed).toContain("printful-orphan");
  });
});

describe("what a finding may say", () => {
  it("carries ids and names only: nothing from metadata, prices or variants beyond their labels", async () => {
    const secret = "customer-jane-doe-order-4411";
    const st = stripe("prod_a", {
      active: false,
      metadata: { note: secret },
      prices: [{ id: "price_a", unitAmount: 1234, currency: "usd", active: true }],
    });
    const pf = printful("77", [variant("1", false, { sku: "SKU-1", retailPrice: 98765 })]);
    const r = await run(input([group(sanity("a"), st, pf)]));
    const text = JSON.stringify(r.findings);
    expect(r.findings.length).toBe(2);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("1234");
    expect(text).not.toContain("98765");
  });

  it("escapes a name that carries control or invisible characters", async () => {
    const name = `Tee\u202E${"x".repeat(5)}\u0007`;
    const r = await run(input([group(sanity("tee", { name }))]));
    const text = only(r, "stripe-missing")[0]?.evidence ?? "";
    expect(text).toContain("\\u{202E}");
    expect(text).toContain("\\u{7}");
    // eslint-disable-next-line no-control-regex -- the point is that none is left
    expect(text).not.toMatch(/[\u0000-\u0008\u202E]/u);
  });

  it("does not name which system is right", () => {
    for (const c of PRESENCE_CHECKS)
      expect(`${c.title} ${c.what} ${c.why} ${c.fix}`).not.toMatch(/is (the )?(right|wrong)/i);
  });
});

// ---- integration --------------------------------------------------------------------------------

describe("product presence checks: Lowtide Surf Club's shop (six planted problems)", () => {
  it("returns one finding per check, with the documented severities, in Sanity order", async () => {
    const store = await readSurfStore();
    const r = await run(presenceInput(store.match, store));
    expect(r.findings.map((f) => [f.checkId, f.severity, f.url]).sort()).toEqual(
      [
        ["printful-missing", "low", "sanity:wallpaper-pack"],
        ["printful-orphan", "low", "printful:7005"],
        ["printful-unsynced", "high", "sanity:lowtide-tote"],
        ["stripe-archived", "high", "sanity:lowtide-hoodie"],
        ["stripe-missing", "high", "sanity:lowtide-poster"],
        ["stripe-orphan", "low", "stripe:prod_LowVoucher"],
      ].sort(),
    );
    // the archived Stripe product nobody links to is not an orphan, and nothing else is reported
    expect(JSON.stringify(r.findings)).not.toContain("prod_LowOld24");
    expect(r.findings).toHaveLength(6);
  });

  it("two runs print the same list", async () => {
    const store = await readSurfStore();
    const a = await run(presenceInput(store.match, store));
    const b = await run(presenceInput((await readSurfStore()).match, await readSurfStore()));
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });

  it("Printful unreachable: no Printful findings, and the Stripe findings are unchanged", async () => {
    const whole = await run(presenceInput((await readSurfStore()).match, await readSurfStore()));
    const store = await readSurfStore(["printful"]);
    expect(
      store.notices.filter((n) => n.kind !== "advice").map((n) => [n.connector, n.kind]),
    ).toEqual([["printful", "unreachable"]]);
    const r = await run(presenceInput(store.match, store));
    expect(r.findings.filter((f) => f.checkId.startsWith("printful-"))).toEqual([]);
    const stripeOnly = (x: RunResult) => x.findings.filter((f) => f.checkId.startsWith("stripe-"));
    expect(stripeOnly(r)).toHaveLength(3);
    expect(stripeOnly(r)).toEqual(stripeOnly(whole));
  });

  it("Stripe unreachable: no Stripe findings, and the Printful findings are unchanged", async () => {
    const whole = await run(presenceInput((await readSurfStore()).match, await readSurfStore()));
    const store = await readSurfStore(["stripe"]);
    const r = await run(presenceInput(store.match, store));
    expect(r.findings.filter((f) => f.checkId.startsWith("stripe-"))).toEqual([]);
    const printfulOnly = (x: RunResult) =>
      x.findings.filter((f) => f.checkId.startsWith("printful-"));
    expect(printfulOnly(r)).toEqual(printfulOnly(whole));
  });

  it("Sanity unreachable: nothing is called missing or orphaned", async () => {
    const store = await readSurfStore(["sanity"]);
    const r = await run(presenceInput(store.match, store));
    expect(r.findings.filter((f) => /missing|orphan/.test(f.checkId))).toEqual([]);
  });
});

// ---- edge cases ---------------------------------------------------------------------------------

describe("product presence checks: edge cases", () => {
  it("Stripe configured and empty (a new account): every product is missing from checkout, and the summary says zero", async () => {
    const groups = [group(sanity("a")), group(sanity("b")), group(sanity("c"))];
    const i = input(groups, { read: { sanity: true, stripe: true, printful: false } });
    const r = await run(i);
    expect(only(r, "stripe-missing").map((f) => f.url)).toEqual([
      "sanity:a",
      "sanity:b",
      "sanity:c",
    ]);
    expect(only(r, "stripe-missing")[0]?.evidence).toContain("Stripe returned zero products");
    expect(summarisePresence(i)).toContain("Stripe returned zero products.");
  });

  it("the summary says what each system returned, and which were not read", () => {
    const i = input([group(sanity("a"), stripe("s1"), printful("p1"))], {
      unmatchedStripe: [stripe("s2")],
      read: { sanity: true, stripe: true, printful: false },
    });
    expect(summarisePresence(i)).toEqual([
      "Sanity returned 1 product.",
      "Stripe returned 2 products.",
      "Printful was not read.",
    ]);
    expect(
      summarisePresence(input([], { read: { sanity: false, stripe: false, printful: false } })),
    ).toEqual(["Sanity was not read.", "Stripe was not read.", "Printful was not read."]);
  });

  it("a product with 14 unsynced variants lists 10 and says 'and 4 more'", async () => {
    const many = Array.from({ length: 14 }, (_, n) =>
      variant(`v${n + 1}`, false, { sku: `SKU-${n + 1}` }),
    );
    const r = await run(input([group(sanity("bulk"), undefined, printful("55", many))]));
    const text = only(r, "printful-unsynced")[0]?.evidence ?? "";
    expect(only(r, "printful-unsynced")).toHaveLength(1);
    expect(text).toContain("14 of 14");
    for (let n = 1; n <= 10; n++) expect(text).toContain(`SKU-${n},`.replace(",", ""));
    expect(text).not.toContain("SKU-11");
    expect(text).toContain("and 4 more");
  });

  it("a product that is both archived in Stripe and unsynced in Printful gets two findings, one per system", async () => {
    const r = await run(
      input([
        group(
          sanity("both"),
          stripe("prod_both", { active: false }),
          printful("88", [variant("1", false)]),
        ),
      ]),
    );
    expect(r.findings.map((f) => f.checkId).sort()).toEqual([
      "printful-unsynced",
      "stripe-archived",
    ]);
  });

  it("Sanity not configured, Stripe and Printful configured: no missing or orphan findings, archived and unsynced still run", async () => {
    const i = input([], {
      unmatchedStripe: [stripe("prod_live"), stripe("prod_gone", { active: false })],
      unmatchedPrintful: [
        printful("1", [variant("1", true)]),
        printful("2", [variant("2", false, { sku: "HAT-L" })]),
      ],
      read: { sanity: false, stripe: true, printful: true },
    });
    const r = await run(i);
    expect(r.findings.filter((f) => /missing|orphan/.test(f.checkId))).toEqual([]);
    expect(r.findings.map((f) => [f.checkId, f.url])).toEqual([
      ["printful-unsynced", "printful:2"],
      ["stripe-archived", "stripe:prod_gone"],
    ]);
    expect(only(r, "printful-unsynced")[0]?.evidence).toContain("HAT-L");
  });

  it("findings follow the Sanity input order, whatever the order of the other lists", async () => {
    const groups = ["c", "a", "b"].map((id) => group(sanity(id)));
    const r = await run(input(groups));
    expect(only(r, "stripe-missing").map((f) => f.url)).toEqual([
      "sanity:c",
      "sanity:a",
      "sanity:b",
    ]);
    const orphans = await run(
      input([], { unmatchedStripe: [stripe("z"), stripe("m"), stripe("a")] }),
    );
    expect(only(orphans, "stripe-orphan").map((f) => f.url)).toEqual([
      "stripe:z",
      "stripe:m",
      "stripe:a",
    ]);
  });

  it("presenceInput reads which systems answered from the connector run", () => {
    const m = { groups: [], unmatchedStripe: [], unmatchedPrintful: [], ambiguous: [] };
    const data = new Map<string, unknown[]>([
      ["sanity", []],
      ["stripe", []],
    ]);
    expect(presenceInput(m, { data }).read).toEqual({
      sanity: true,
      stripe: true,
      printful: false,
    });
  });
});
