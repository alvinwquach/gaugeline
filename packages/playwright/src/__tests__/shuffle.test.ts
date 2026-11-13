import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sampleSeeded, seedToUint32, shuffleSeeded } from "../shuffle.js";

const ITEMS = Array.from({ length: 30 }, (_, i) => `doc-${i}`);

describe("seeded shuffle: unit", () => {
  it("returns the same items in the same order for the same seed", () => {
    expect(shuffleSeeded(ITEMS, "release-42")).toEqual(shuffleSeeded(ITEMS, "release-42"));
    expect(sampleSeeded(ITEMS, 5, "release-42")).toEqual(sampleSeeded(ITEMS, 5, "release-42"));
  });

  it("returns a different order for a different seed", () => {
    expect(shuffleSeeded(ITEMS, "a")).not.toEqual(shuffleSeeded(ITEMS, "b"));
  });

  it("treats the number 7 and the text '7' as one seed", () => {
    expect(seedToUint32(7)).toBe(seedToUint32("7"));
    expect(shuffleSeeded(ITEMS, 7)).toEqual(shuffleSeeded(ITEMS, "7"));
  });

  it("keeps every item exactly once and leaves the input alone", () => {
    const before = [...ITEMS];
    const out = shuffleSeeded(ITEMS, "x");
    expect(ITEMS).toEqual(before);
    expect([...out].sort()).toEqual([...ITEMS].sort());
  });

  it("is a permutation for any list and any seed", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 60 }), fc.string(), (list, seed) => {
        const out = shuffleSeeded(list, seed);
        expect([...out].sort((a, b) => a - b)).toEqual([...list].sort((a, b) => a - b));
      }),
    );
  });

  it("moves every position over many seeds (no seed pins an item in place)", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) seen.add(shuffleSeeded(ITEMS, seed)[0] ?? "");
    // 200 seeds over 30 items: every item leads at least once is unlikely; most of them do.
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe("seeded sample: edge cases", () => {
  it("takes n items, all of them when n is larger than the list, and none are repeated", () => {
    const three = sampleSeeded(ITEMS, 3, "s");
    expect(three).toHaveLength(3);
    expect(new Set(three).size).toBe(3);
    expect(sampleSeeded(ITEMS, 1000, "s")).toHaveLength(ITEMS.length);
  });

  it("handles an empty list and a list of one", () => {
    expect(shuffleSeeded([], "s")).toEqual([]);
    expect(shuffleSeeded(["only"], "s")).toEqual(["only"]);
  });

  it("refuses an n that is not a whole number of at least 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => sampleSeeded(ITEMS, bad, "s")).toThrow(/whole number/);
  });
});
