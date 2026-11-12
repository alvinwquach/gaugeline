/** Unit: opened, still open and closed are Set differences of two runs' fingerprints. */
import { describe, expect, it } from "vitest";
import { backoffMs, JOB_DEADLINE_MS, LEASE_MS, MAX_ATTEMPTS } from "../queue.js";
import { diffFingerprints, diffRuns } from "../diff.js";

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

describe("diffRuns", () => {
  const f = (checkId: string, fingerprint: string) => ({ checkId, fingerprint });

  it("a check that did not run in one of the two runs opens and closes nothing", () => {
    const prev = { findings: [f("a", "a1"), f("b", "b1")], notRun: [] };
    // Tonight check b threw and check c could not be checked; c's finding appears only because it ran before.
    const cur = { findings: [f("a", "a1"), f("c", "c1")], notRun: ["b"] };
    expect(diffRuns(prev, cur)).toEqual({ opened: ["c1"], stillOpen: ["a1"], closed: [] });
    // And the other way: c was not run last time, so its finding is not new tonight.
    expect(diffRuns({ ...prev, notRun: ["c"] }, { findings: cur.findings, notRun: ["b"] })).toEqual(
      { opened: [], stillOpen: ["a1"], closed: [] },
    );
  });

  it("with every check run in both, it is the plain fingerprint difference", () => {
    const d = diffRuns(
      { findings: [f("a", "a1")], notRun: [] },
      { findings: [f("a", "a2")], notRun: [] },
    );
    expect(d).toEqual({ opened: ["a2"], stillOpen: [], closed: ["a1"] });
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

  it("a job's deadline ends well before its lease, so no other worker runs it while this one still does", () => {
    expect(JOB_DEADLINE_MS).toBeLessThanOrEqual(LEASE_MS - 5 * 60_000);
  });
});
