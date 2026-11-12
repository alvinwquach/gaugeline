import { describe, expect, it } from "vitest";
import type { Finding } from "../../model.js";
import { applySuppressions, isBlocking, offIds } from "../apply.js";

function finding(checkId: string, url: string, severity: Finding["severity"] = "high"): Finding {
  return { checkId, severity, title: "t", evidence: "e", url };
}

const clock = (iso: string) => new Date(`${iso}T09:30:00Z`);
const f1 = finding("canonical-elsewhere", "https://bar.example/menu");
const f2 = finding("canonical-elsewhere", "https://bar.example/events");
const f3 = finding("title-missing", "https://bar.example/menu", "medium");

describe("suppressions with an injected clock", () => {
  const entry = (until: string) => ({ id: "canonical-elsewhere", until, reason: "client away" });

  it("active: until is the last day it applies, so a date in the future suppresses", () => {
    const r = applySuppressions([f1, f3], [entry("2026-12-01")], clock("2026-11-12"));
    expect(r.kept).toEqual([f3]);
    expect(r.suppressed).toHaveLength(1);
    expect(r.expired).toEqual([]);
  });

  it("expires tomorrow: still active today", () => {
    const r = applySuppressions([f1], [entry("2026-11-12")], clock("2026-11-12"));
    expect(r.kept).toEqual([]);
    expect(r.expired).toEqual([]);
    const next = applySuppressions([f1], [entry("2026-11-12")], clock("2026-11-13"));
    expect(next.kept).toEqual([f1]);
    expect(next.expired).toHaveLength(1);
  });

  it("expired today: stops applying, is reported, and the finding is back", () => {
    const r = applySuppressions([f1], [entry("2026-11-11")], clock("2026-11-12"));
    expect(r.kept).toEqual([f1]);
    expect(r.suppressed).toEqual([]);
    expect(r.expired).toEqual([entry("2026-11-11")]);
  });

  it("an expired suppression is reported even when the finding is gone", () => {
    const r = applySuppressions([], [entry("2026-01-01")], clock("2026-11-12"));
    expect(r.expired).toHaveLength(1);
  });

  it("a url limits it to that page (an address or a path)", () => {
    const byPath = applySuppressions(
      [f1, f2],
      [{ ...entry("2026-12-01"), url: "/menu" }],
      clock("2026-11-12"),
    );
    expect(byPath.kept).toEqual([f2]);
    const byAddress = applySuppressions(
      [f1, f2],
      [{ ...entry("2026-12-01"), url: "https://bar.example/events/" }],
      clock("2026-11-12"),
    );
    expect(byAddress.kept).toEqual([f1]);
  });
});

describe("a suppression that matches nothing", () => {
  it("is listed as unmatched, whether the id is mistyped or the url is not an address", () => {
    const r = applySuppressions(
      [f1],
      [
        { id: "canonical-elsewhre", until: "2026-12-01", reason: "typo" },
        {
          id: "canonical-elsewhere",
          url: "bar.example/menu",
          until: "2026-12-01",
          reason: "no scheme",
        },
        { id: "canonical-elsewhere", url: "/menu", until: "2026-12-01", reason: "fine" },
      ],
      clock("2026-11-12"),
    );
    expect(r.unmatched.map((u) => u.reason)).toEqual(["typo", "no scheme"]);
  });
  it("an expired entry is not also unmatched", () => {
    const r = applySuppressions(
      [],
      [{ id: "x", until: "2026-01-01", reason: "old" }],
      clock("2026-11-12"),
    );
    expect(r.unmatched).toEqual([]);
    expect(r.expired).toHaveLength(1);
  });
});

describe("what blocks", () => {
  it("high blocks by default; warn never blocks; block makes any severity block", () => {
    expect(isBlocking(f1, {})).toBe(true);
    expect(isBlocking(f3, {})).toBe(false);
    expect(isBlocking(f1, { "canonical-elsewhere": "warn" })).toBe(false);
    expect(isBlocking(f3, { "title-missing": "block" })).toBe(true);
  });
  it("offIds lists the checks turned off", () => {
    expect(offIds({ a: "off", b: "warn", c: "off" })).toEqual(["a", "c"]);
  });
});
