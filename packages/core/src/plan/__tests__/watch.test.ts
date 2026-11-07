import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import type { Finding } from "../../model.js";
import { compare } from "../progress.js";
import type { PlanRow } from "../read.js";
import { newSince, watchDay, watchLine, watchSummary } from "../watch.js";

const at = (iso: string) => new Date(iso);
const f = (key: string, severity: Finding["severity"] = "medium"): Finding => ({
  checkId: "plan-title-drift",
  severity,
  title: "t",
  evidence: key,
  url: "plan.csv",
  group: { key, lines: [2] },
});
const rows: PlanRow[] = [{ line: 2, url: "/a", path: "/a", raw: {} }];

describe("the 30-day watch: unit", () => {
  it("day counter: the cutover day is day 1, day 30 runs, day 31 is over, in UTC", () => {
    expect(watchDay("2026-11-01", at("2026-11-01T00:00:00Z"))).toEqual({
      kind: "watching",
      day: 1,
    });
    expect(watchDay("2026-11-01", at("2026-11-01T23:59:59Z"))).toEqual({
      kind: "watching",
      day: 1,
    });
    expect(watchDay("2026-11-01", at("2026-11-30T23:00:00Z"))).toEqual({
      kind: "watching",
      day: 30,
    });
    expect(watchDay("2026-11-01", at("2026-12-01T00:00:00Z"))).toEqual({ kind: "over", day: 31 });
    // 11pm in Los Angeles on Nov 1 is already Nov 2 in UTC: the counter uses UTC.
    expect(watchDay("2026-11-01", at("2026-11-02T06:30:00Z"))).toEqual({
      kind: "watching",
      day: 2,
    });
    expect(watchLine(9)).toBe("Day 9 of 30 since cutover");
  });

  it("the watch filter: 5 known and 1 new gives 1; 5 known and 0 new gives none", () => {
    const known = ["/a", "/b", "/c", "/d", "/e"].map((k) => f(k));
    const prev = compare(undefined, known, rows, {
      base: "https://x.example",
      at: "2026-11-01",
    }).state;
    expect(newSince([...known, f("/new", "high")], prev).map((x) => x.evidence)).toEqual(["/new"]);
    expect(newSince(known, prev)).toEqual([]);
    expect(newSince(known, undefined)).toHaveLength(5);
    expect(watchSummary(0, 2, 0)).toBe("No new drift. 2 known findings still open.");
    expect(watchSummary(1, 5, 1)).toBe(
      "1 new since the last run. 5 known findings still open. 1 fixed since the last run.",
    );
  });

  it("a future cutover date, or a date that isn't one, is a ConfigError", () => {
    expect(() => watchDay("2026-12-01", at("2026-11-07T12:00:00Z"))).toThrow(ConfigError);
    expect(() => watchDay("2026-12-01", at("2026-11-07T12:00:00Z"))).toThrow(
      "--watch: the cutover date 2026-12-01 is in the future. The watch starts on the cutover day.",
    );
    for (const bad of ["2026-02-30", "1 Nov 2026", "2026-11-1"])
      expect(() => watchDay(bad, at("2026-11-07T12:00:00Z")), bad).toThrow("is not a date");
  });
});
