import { describe, expect, it } from "vitest";
import {
  NODE_RETIREMENTS,
  NODE_RETIREMENTS_MAX_AGE_DAYS,
  NODE_RETIREMENTS_WRITTEN,
  nodeMajor,
  retirementsStale,
  runtimeStatus,
} from "../runtimes.js";

describe("the Vercel Node.js retirement list: data", () => {
  it("has a dated, sourced entry for every version, in order, once each", () => {
    expect(NODE_RETIREMENTS.length).toBeGreaterThan(0);
    const majors = NODE_RETIREMENTS.map((r) => r.major);
    expect(majors).toEqual([...new Set(majors)].sort((a, b) => a - b));
    for (const r of NODE_RETIREMENTS) {
      expect(Number.isInteger(r.major), `${r.major}`).toBe(true);
      expect(r.retires, `${r.major}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${r.retires}T00:00:00Z`)), `${r.major}`).toBe(false);
      expect(r.source, `${r.major}`).toMatch(/^https:\/\/vercel\.com\//);
      expect(typeof r.verified).toBe("boolean");
    }
    expect(NODE_RETIREMENTS_WRITTEN).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is stale only after its allowed age", () => {
    const written = "2026-11-11";
    expect(retirementsStale(new Date("2027-05-09T00:00:00Z"), written)).toBe(false);
    expect(NODE_RETIREMENTS_MAX_AGE_DAYS).toBe(180);
    expect(retirementsStale(new Date("2027-05-12T00:00:00Z"), written)).toBe(true);
  });
});

describe("runtimeStatus: unit", () => {
  const NOW = new Date("2026-11-09T12:00:00Z");

  it("reads the major from the forms Vercel stores", () => {
    expect(nodeMajor("22.x")).toBe(22);
    expect(nodeMajor("18")).toBe(18);
    expect(nodeMajor(" 20.x ")).toBe(20);
    expect(nodeMajor("lts")).toBeUndefined();
  });

  it("says how long ago a listed version retired", () => {
    const s = runtimeStatus("18.x", NOW);
    expect(s?.major).toBe(18);
    expect(s?.days).toBeLessThan(0);
  });

  it("has nothing to say for a version nothing has been announced for", () => {
    expect(runtimeStatus("22.x", NOW)).toBeUndefined();
    expect(runtimeStatus("nonsense", NOW)).toBeUndefined();
  });
});
