import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { fingerprint } from "../../fingerprint.js";
import type { Finding } from "../../model.js";
import { checkBuilt } from "../built.js";
import { compare, progressLine, readPlanState, rowsMatching, type PlanState } from "../progress.js";
import { readPlan, type PlanRow } from "../read.js";

const AT = "2026-10-03T09:00:00.000Z";
const LATER = "2026-10-10T09:00:00.000Z";
const f = (
  checkId: string,
  key: string,
  lines: number[],
  extra: Partial<Finding> = {},
): Finding => ({
  checkId,
  severity: "high",
  title: `title of ${checkId}`,
  evidence: `${key} returned 404 on the preview`,
  url: "plan.csv",
  group: { key, lines },
  ...extra,
});
const row = (line: number, path: string, extra: Partial<PlanRow> = {}): PlanRow => ({
  line,
  url: `https://kilnlane.example${path}`,
  path,
  raw: {},
  ...extra,
});
const ROWS = [2, 3, 4, 5].map((n) => row(n, `/p${n}`));

describe("plan progress: unit", () => {
  it("fingerprint: the same finding on preview-a.example and preview-b.example is one fingerprint", () => {
    const a: Finding = {
      checkId: "canonical-missing",
      severity: "medium",
      title: "t",
      evidence: "https://preview-a.example/shop has no canonical",
      url: "https://preview-a.example/shop/",
    };
    const b = {
      ...a,
      evidence: "https://preview-b.example/shop has no canonical",
      url: "https://preview-b.example/shop",
    };
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
    // A plan finding: the group key, not the preview host or the evidence.
    expect(fingerprint(f("plan-404", "/shop", [6]))).toBe(
      fingerprint(f("plan-404", "/shop", [9], { evidence: "/shop returned 410 on the preview" })),
    );
  });

  it("fingerprint: a count or a timing in the evidence changes nothing; another check on the same path differs", () => {
    const slow: Finding = {
      checkId: "slow-page",
      severity: "low",
      title: "t",
      evidence: "The page took 2,340 ms and 41 requests",
      url: "https://x.example/a",
    };
    expect(fingerprint(slow)).toBe(
      fingerprint({ ...slow, evidence: "The page took 980 ms and 12 requests" }),
    );
    expect(fingerprint(slow)).not.toBe(fingerprint({ ...slow, checkId: "page-weight" }));
    expect(fingerprint(f("plan-404", "/shop", [6]))).not.toBe(
      fingerprint(f("plan-h1-drift", "/shop", [6])),
    );
  });

  it("compare: first run, nothing changed, 2 fixed, 1 added, the plan changed", () => {
    const first = compare(undefined, [f("plan-404", "/p2", [2]), f("plan-404", "/p3", [3])], ROWS, {
      base: "https://preview.example",
      at: AT,
    });
    expect([first.fixed, first.added.length, first.still, first.planChanged]).toEqual([
      [],
      2,
      0,
      false,
    ]);
    expect(progressLine(first)).toBe("2 of 4 rows match the plan. First run: 2 open.");

    const same = compare(
      first.state,
      [f("plan-404", "/p2", [2]), f("plan-404", "/p3", [3])],
      ROWS,
      {
        base: "https://preview-2.example",
        at: LATER,
      },
    );
    expect([same.fixed, same.added, same.still]).toEqual([[], [], 2]);
    expect(progressLine(same)).toBe(
      "2 of 4 rows match the plan (was 2). 0 fixed since 3 Oct, 0 new, 2 still open.",
    );

    const better = compare(first.state, [f("plan-h1-drift", "/p4", [4])], ROWS, {
      base: "https://preview.example",
      at: LATER,
    });
    expect([better.fixed.length, better.added.length, better.still]).toEqual([2, 1, 0]);
    expect(progressLine(better)).toBe(
      "3 of 4 rows match the plan (was 2). 2 fixed since 3 Oct, 1 new, 0 still open.",
    );

    const edited = compare(first.state, [], [...ROWS.slice(0, 3), row(5, "/p5", { h1: "New" })], {
      base: "https://preview.example",
      at: LATER,
    });
    expect(edited.planChanged).toBe(true);
    expect(progressLine(edited)).toContain("(was 2; the plan changed)");
  });

  it("rowsMatching counts a row with three findings once", () => {
    const three = [
      f("plan-title-drift", "/p2", [2]),
      f("plan-h1-drift", "/p2", [2]),
      f("plan-canonical-elsewhere", "/p2", [2]),
    ];
    expect(rowsMatching(ROWS, three)).toBe(3);
  });
});

describe("plan progress: integration (a preview filling in: 6, then 9, of 10 pages built)", () => {
  const plan = () => readPlan(readFileSync(`${SITES_DIR}plan-progress/plan.csv`, "utf8")).rows;
  const run = async (week: string, prev: PlanState | undefined, at: string) => {
    const site = await startFixture(week);
    try {
      const rows = plan();
      const built = await checkBuilt(rows, {
        base: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        file: "plan.csv",
      });
      return compare(prev, built.findings, rows, { base: site.origin, at });
    } finally {
      await site.close();
    }
  };

  it("run 1: 6 of 10; run 2 on another preview host: 9 of 10 (was 6), 3 fixed, 0 new", async () => {
    const one = await run("plan-progress-week1", undefined, AT);
    expect(progressLine(one)).toBe("6 of 10 rows match the plan. First run: 4 open.");
    const two = await run("plan-progress-week2", one.state, LATER);
    expect(progressLine(two)).toBe(
      "9 of 10 rows match the plan (was 6). 3 fixed since 3 Oct, 0 new, 1 still open.",
    );
    expect(two.fixed.map((k) => one.state.open[k]?.line).sort()).toEqual([5, 7, 9]);
  });

  it("a title broken between runs is exactly 1 new", async () => {
    const two = await run("plan-progress-week2", undefined, AT);
    const three = await run("plan-progress-week3", two.state, LATER);
    expect([three.fixed.length, three.added.length, three.still]).toEqual([0, 1, 1]);
    expect(three.state.open[three.added[0] ?? ""]).toEqual({
      checkId: "plan-title-drift",
      line: 6,
      title: "A title tag isn't what the plan says",
    });
  });
});

describe("plan progress: edge cases", () => {
  const prev = compare(undefined, [f("plan-404", "/p3", [3])], ROWS, { base: "b", at: AT }).state;

  it("a row added: the total moves from 4 to 5 and the line says the plan changed", () => {
    const p = compare(prev, [f("plan-404", "/p3", [3])], [...ROWS, row(6, "/p6")], {
      base: "b",
      at: LATER,
    });
    expect(progressLine(p)).toBe(
      "4 of 5 rows match the plan (was 3 of 4; the plan changed). 0 fixed since 3 Oct, 0 new, 1 still open.",
    );
  });

  it("rows reordered: line numbers move, fingerprints don't, nothing is new", () => {
    const reordered = [...ROWS].reverse().map((r, i) => ({ ...r, line: i + 2 }));
    const p = compare(prev, [f("plan-404", "/p3", [4])], reordered, { base: "b", at: LATER });
    expect([p.fixed, p.added, p.still, p.planChanged]).toEqual([[], [], 1, false]);
  });

  it("a plan URL corrected (credentialling to credentialing): the old finding is fixed, the new one is new", () => {
    const old = compare(undefined, [f("plan-404", "/provider-credentialling", [2])], ROWS, {
      base: "b",
      at: AT,
    });
    const p = compare(old.state, [f("plan-404", "/provider-credentialing", [2])], ROWS, {
      base: "b",
      at: LATER,
    });
    expect([p.fixed.length, p.added.length, p.still]).toEqual([1, 1, 0]);
  });

  it("readPlanState: a later schema is refused, corrupt JSON and the wrong shape are corrupt", () => {
    expect(readPlanState(JSON.stringify({ ...prev, schema: 2 }))).toEqual({
      kind: "newer",
      schema: 2,
    });
    expect(readPlanState("{ not json")).toEqual({ kind: "corrupt" });
    expect(readPlanState("[]")).toEqual({ kind: "corrupt" });
    expect(readPlanState(JSON.stringify({ schema: 1 }))).toEqual({ kind: "corrupt" });
    expect(readPlanState(JSON.stringify(prev))).toEqual({ kind: "ok", state: prev });
  });

  it("the state holds fingerprints, check ids, lines and titles only: no evidence", () => {
    const p = compare(
      undefined,
      [f("plan-404", "/p3", [3], { evidence: "page body text here" })],
      ROWS,
      {
        base: "https://preview.example",
        at: AT,
      },
    );
    expect(JSON.stringify(p.state)).not.toContain("page body text here");
    expect(Object.values(p.state.open)).toEqual([
      { checkId: "plan-404", line: 3, title: "title of plan-404" },
    ]);
  });
});
