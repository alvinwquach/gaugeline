import { describe, expect, it } from "vitest";
import { attributeSpeed, MIN_MOVE, VARIANT_NAMES, type Measure } from "../attribution.js";

const base = (...m: Measure[]) => m;

describe("attributeSpeed: which change moves the numbers", () => {
  it("names the three changes, one at a time", () => {
    expect(VARIANT_NAMES).toEqual(["reduced-motion", "no-javascript", "no-third-party"]);
  });

  it("reports a move that is bigger than the page's own repeat-to-repeat spread", () => {
    const out = attributeSpeed(base({ lcpMs: 2000, tbtMs: 900 }, { lcpMs: 2040, tbtMs: 940 }), {
      "no-third-party": { lcpMs: 1990, tbtMs: 120 },
    });
    expect(out.moves).toEqual([
      { variant: "no-third-party", metric: "tbt", from: 920, to: 120, change: -800, noise: 40 },
    ]);
  });

  it("is quiet when nothing moves more than the floor, the spread or ten percent", () => {
    const out = attributeSpeed(base({ lcpMs: 2000, tbtMs: 300 }, { lcpMs: 2100, tbtMs: 340 }), {
      "reduced-motion": { lcpMs: 2000, tbtMs: 320 },
      "no-javascript": { lcpMs: 2150, tbtMs: 0 + 330 },
    });
    expect(out.moves).toEqual([]);
  });

  it("a big spread between the repeats hides a move that is no bigger than the spread", () => {
    const out = attributeSpeed(base({ lcpMs: 1000 }, { lcpMs: 2000 }), {
      "reduced-motion": { lcpMs: 600 },
    });
    // The reference is 1500 and the repeats differ by 1000: a change of 900 is within the noise.
    expect(out.moves).toEqual([]);
  });

  it("uses a floor per metric and ten percent of the reference", () => {
    expect(MIN_MOVE).toEqual({ lcpMs: 200, tbtMs: 100 });
    // 10% of 5000 is 500: a move of 400 is not a move, a move of 600 is.
    const small = attributeSpeed(base({ lcpMs: 5000 }), { "no-javascript": { lcpMs: 4600 } });
    expect(small.moves).toEqual([]);
    const big = attributeSpeed(base({ lcpMs: 5000 }), { "no-javascript": { lcpMs: 4400 } });
    expect(big.moves.map((m) => [m.metric, m.change])).toEqual([["lcp", -600]]);
  });

  it("reports a change for the worse as well, with its sign", () => {
    const out = attributeSpeed(base({ lcpMs: 800 }), { "no-javascript": { lcpMs: 1900 } });
    expect(out.moves.map((m) => [m.variant, m.metric, m.change])).toEqual([
      ["no-javascript", "lcp", 1100],
    ]);
  });

  it("lists the moves in a fixed order: by variant, then largest contentful paint before blocking time", () => {
    const out = attributeSpeed(base({ lcpMs: 3000, tbtMs: 1000 }), {
      "no-third-party": { lcpMs: 1000, tbtMs: 100 },
      "reduced-motion": { lcpMs: 1500, tbtMs: 100 },
    });
    expect(out.moves.map((m) => `${m.variant}:${m.metric}`)).toEqual([
      "reduced-motion:lcp",
      "reduced-motion:tbt",
      "no-third-party:lcp",
      "no-third-party:tbt",
    ]);
  });

  it("says which numbers it could not compare, and does not guess them", () => {
    const out = attributeSpeed(base({ lcpMs: 2000, tbtMs: 50 }, { lcpMs: 2000, tbtMs: 50 }), {
      "reduced-motion": { tbtMs: 10 },
      "no-javascript": undefined,
    });
    expect(out.moves).toEqual([]);
    expect(out.unmeasured).toEqual([
      { variant: "reduced-motion", metric: "lcp" },
      { variant: "no-javascript", metric: "lcp" },
      { variant: "no-javascript", metric: "tbt" },
      { variant: "no-third-party", metric: "lcp" },
      { variant: "no-third-party", metric: "tbt" },
    ]);
  });

  it("a metric the baseline never measured cannot be compared at all", () => {
    const out = attributeSpeed(base({}, {}), { "no-javascript": { lcpMs: 100, tbtMs: 0 } });
    expect(out.moves).toEqual([]);
    expect(out.unmeasured.filter((u) => u.variant === "no-javascript")).toHaveLength(2);
  });

  it("works from whole numbers only and gives the same answer for the same input", () => {
    const input = [{ lcpMs: 1234, tbtMs: 777 }];
    const v = { "no-third-party": { lcpMs: 1000, tbtMs: 100 } };
    const a = attributeSpeed(input, v);
    expect(a).toEqual(attributeSpeed(input, v));
    for (const m of a.moves) {
      expect(Number.isInteger(m.from) && Number.isInteger(m.to) && Number.isInteger(m.change)).toBe(
        true,
      );
    }
  });

  it("a change equal to the threshold is not a move, and one more millisecond is", () => {
    // Spread 0, floor 200, 10% of 1000 is 100: the threshold is 200.
    expect(
      attributeSpeed(base({ lcpMs: 1000 }), { "no-javascript": { lcpMs: 800 } }).moves,
    ).toEqual([]);
    expect(
      attributeSpeed(base({ lcpMs: 1000 }), { "no-javascript": { lcpMs: 1200 } }).moves,
    ).toEqual([]);
    expect(
      attributeSpeed(base({ lcpMs: 1000 }), { "no-javascript": { lcpMs: 799 } }).moves,
    ).toHaveLength(1);
    expect(
      attributeSpeed(base({ lcpMs: 1000 }), { "no-javascript": { lcpMs: 1201 } }).moves,
    ).toHaveLength(1);
    // The spread as the threshold: two loads 300 apart, a change of 300 is not a move, 301 is.
    const noisy = base({ lcpMs: 1000 }, { lcpMs: 1300 }); // mean 1150, spread 300, 10% is 115
    expect(attributeSpeed(noisy, { "no-javascript": { lcpMs: 850 } }).moves).toEqual([]);
    expect(attributeSpeed(noisy, { "no-javascript": { lcpMs: 849 } }).moves).toHaveLength(1);
    // Ten percent as the threshold: 10% of 5000 is 500.
    expect(
      attributeSpeed(base({ tbtMs: 5000 }), { "no-third-party": { tbtMs: 4500 } }).moves,
    ).toEqual([]);
    expect(
      attributeSpeed(base({ tbtMs: 5000 }), { "no-third-party": { tbtMs: 4499 } }).moves,
    ).toHaveLength(1);
  });
});
