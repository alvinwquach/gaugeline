/**
 * The budget config (AG-22): three ceilings and a price per model, strict, whole numbers only. A refusal
 * names where the problem is and never repeats what was written there.
 */
import { describe, expect, it } from "vitest";
import { parseBudgetConfig } from "../budget-config.js";

const GOOD = {
  ceilings: { perRunMicros: 3_000, perDayMicros: 10_000, perWorkspaceMicros: 100_000 },
  prices: { "small-model": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 } },
};
const problems = (raw: unknown): string[] => {
  const r = parseBudgetConfig(raw);
  if (r.ok) throw new Error("the config was expected to be refused");
  return r.problems;
};

describe("a valid budget config", () => {
  it("is accepted and its prices become a map", () => {
    const r = parseBudgetConfig(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.ceilings).toEqual(GOOD.ceilings);
    expect(r.config.prices.get("small-model")).toEqual({
      inputMicrosPerMTok: 250_000,
      outputMicrosPerMTok: 1_250_000,
    });
  });

  it("allows a ceiling of 0 (it stops every call) and an empty price list (every model is unpriced)", () => {
    const r = parseBudgetConfig({
      ceilings: { perRunMicros: 0, perDayMicros: 0, perWorkspaceMicros: 0 },
      prices: {},
    });
    expect(r.ok).toBe(true);
  });

  it("accepts the largest ceiling, 10^12 micro-units", () => {
    expect(
      parseBudgetConfig({
        ...GOOD,
        ceilings: { ...GOOD.ceilings, perDayMicros: 1_000_000_000_000 },
      }).ok,
    ).toBe(true);
  });
});

describe("a config that is refused", () => {
  it.each(["perRunMicros", "perDayMicros", "perWorkspaceMicros"])(
    "needs the %s ceiling: no ceiling is never 'unlimited'",
    (k) => {
      const ceilings: Record<string, number> = { ...GOOD.ceilings };
      delete ceilings[k];
      expect(problems({ ...GOOD, ceilings }).join("\n")).toContain(`ceilings.${k}`);
    },
  );

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["over 10^12", 1_000_000_000_001],
    ["not a number", "5"],
    ["not finite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("refuses a ceiling that is %s", (_n, v) => {
    const p = problems({ ...GOOD, ceilings: { ...GOOD.ceilings, perRunMicros: v } });
    expect(p.join("\n")).toContain("ceilings.perRunMicros");
  });

  it.each([
    ["a missing output price", { inputMicrosPerMTok: 1 }],
    ["a missing input price", { outputMicrosPerMTok: 1 }],
    ["a fractional price", { inputMicrosPerMTok: 0.5, outputMicrosPerMTok: 1 }],
    ["a negative price", { inputMicrosPerMTok: -1, outputMicrosPerMTok: 1 }],
    ["a price over 10^10", { inputMicrosPerMTok: 10_000_000_001, outputMicrosPerMTok: 1 }],
    ["an extra field", { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, currency: "x" }],
  ])("refuses %s", (_n, price) => {
    // A price is keyed by a model id, which is never shown unless it is a known one: it can be a key.
    expect(problems({ ...GOOD, prices: { "small-model": price } }).join("\n")).toContain(
      "prices.an entry",
    );
    expect(problems({ ...GOOD, prices: { "example-small": price } }).join("\n")).toContain(
      "prices.example-small",
    );
  });

  it("refuses a model id that is not shaped like one", () => {
    const p = problems({
      ...GOOD,
      prices: { "not a model!": { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 } },
    });
    expect(p.join("\n")).toContain("prices");
  });

  it("is strict: a setting this file does not know is an error that never repeats a pasted key", () => {
    const pasted = ["sk", "live", "q".repeat(24)].join("_");
    const p = problems({ ...GOOD, [pasted]: 1, apiKey: pasted, host: "x" });
    const text = p.join("\n");
    expect(text).not.toContain(pasted);
    expect(text).toContain("apiKey");
    expect(text).toContain("host");
  });

  it("never prints a setting name the person wrote, even one two edits from a real one", () => {
    const p = problems({ ...GOOD, ceilingsQ9: 1, pricesQ9: 1, perRunMicros: 1 });
    const text = p.join("\n");
    expect(text).not.toContain("Q9");
    expect(text).toContain('did you mean "ceilings"?');
    const inPrice = problems({
      ...GOOD,
      prices: { pricesQ9: { inputMicrosPerMTok: 1 } },
    }).join("\n");
    expect(inPrice).not.toContain("Q9");
    expect(inPrice).toContain("prices.an entry");
  });

  it("refuses a value that is not an object, with where it is", () => {
    for (const raw of [null, undefined, 5, "x", []])
      expect(problems(raw).length).toBeGreaterThan(0);
  });

  it("never repeats the value it refused", () => {
    const v = "do-not-repeat-this-value-4242";
    const p = problems({ ...GOOD, ceilings: { ...GOOD.ceilings, perDayMicros: v } });
    expect(p.join("\n")).not.toContain(v);
  });
});
