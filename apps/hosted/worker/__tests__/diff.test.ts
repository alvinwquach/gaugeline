/** Unit: opened, still open and closed are Set differences of two runs' fingerprints. */
import { describe, expect, it } from "vitest";
import { backoffMs, MAX_ATTEMPTS } from "../queue.js";
import { diffFingerprints } from "../diff.js";

describe("diffFingerprints", () => {
  it("opened, still open and closed, each sorted", () => {
    expect(diffFingerprints(["b", "a", "c"], ["d", "c", "b"])).toEqual({
      opened: ["d"],
      stillOpen: ["b", "c"],
      closed: ["a"],
    });
  });

  it("a repeated fingerprint counts once (one finding on two sampled pages is still one finding)", () => {
    expect(diffFingerprints(["a", "a"], ["a", "a", "b"])).toEqual({
      opened: ["b"],
      stillOpen: ["a"],
      closed: [],
    });
  });

  it("no previous run: everything is opened", () => {
    expect(diffFingerprints([], ["a"])).toEqual({ opened: ["a"], stillOpen: [], closed: [] });
  });

  it("the same set: nothing opened or closed", () => {
    const d = diffFingerprints(["a", "b"], ["b", "a"]);
    expect(d.opened.length + d.closed.length).toBe(0);
  });
});

describe("backoffMs", () => {
  it("doubles per attempt, with jitter between half and the whole step", () => {
    expect(backoffMs(1, () => 0)).toBe(30_000);
    expect(backoffMs(1, () => 0.999_999)).toBeLessThanOrEqual(60_000);
    expect(backoffMs(2, () => 0)).toBe(60_000);
    expect(backoffMs(3, () => 0)).toBe(120_000);
  });

  it("is capped, and spreads retries that failed at the same moment", () => {
    expect(backoffMs(30, () => 1)).toBeLessThanOrEqual(30 * 60_000);
    const spread = new Set([0.1, 0.4, 0.7].map((r) => backoffMs(2, () => r)));
    expect(spread.size).toBe(3);
  });

  it("three attempts in all", () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
