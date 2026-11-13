import { describe, expect, it } from "vitest";
import { compareRuns, formatBeforeAfter } from "../compare.js";
import { HISTORY_SCHEMA, type PageRecord, type RunRecord } from "../types.js";

const page = (over: Partial<PageRecord> = {}): PageRecord => ({
  title: "Menu",
  mainHash: "aaaa",
  links: [],
  types: [],
  scripts: [],
  ...over,
});
const f = (checkId: string, path: string, title = `Title of ${checkId}`) => ({
  checkId,
  path,
  title,
});
const run = (
  id: string,
  takenAt: string,
  pages: Record<string, PageRecord>,
  findings: ReturnType<typeof f>[],
): RunRecord => ({ schema: HISTORY_SCHEMA, id, takenAt, pages, findings });

const R1 = run(
  "r-20261101T100000Z",
  "2026-11-01T10:00:00.000Z",
  { "/": page(), "/menu": page(), "/old": page() },
  [f("nav-utm-lost", "/"), f("viewport", "/"), f("broken-links", "/menu"), f("thin-html", "/old")],
);
const R2 = run(
  "r-20261103T100000Z",
  "2026-11-03T10:00:00.000Z",
  { "/": page(), "/menu": page({ mainHash: "bbbb", links: ["/book"] }) },
  [f("viewport", "/"), f("noindex", "/menu"), f("page-heavy", "/new")],
);

describe("compareRuns: what was fixed, new and unchanged", () => {
  it("compares the latest run with the one before it, on the pages both read", () => {
    const r = compareRuns("bar.example", [R2, R1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.before.id).toBe(R1.id);
    expect(r.report.after.id).toBe(R2.id);
    expect(r.report.compared).toEqual(["/", "/menu"]);
    expect(r.report.fixed.map((x) => `${x.checkId} ${x.path}`)).toEqual([
      "nav-utm-lost /",
      "broken-links /menu",
    ]);
    expect(r.report.added.map((x) => `${x.checkId} ${x.path}`)).toEqual(["noindex /menu"]);
    expect(r.report.unchanged.map((x) => `${x.checkId} ${x.path}`)).toEqual(["viewport /"]);
  });

  it("findings on a page only one run read are counted, never called fixed or new", () => {
    const r = compareRuns("bar.example", [R1, R2]);
    if (!r.ok) throw new Error(r.note);
    expect(r.report.notCompared).toEqual({ before: 1, after: 1 });
    expect(r.report.fixed.map((x) => x.path)).not.toContain("/old");
    expect(r.report.added.map((x) => x.path)).not.toContain("/new");
  });

  it("lists what changed on each page both runs read, and only the pages that changed", () => {
    const r = compareRuns("bar.example", [R1, R2]);
    if (!r.ok) throw new Error(r.note);
    expect(r.report.pages).toEqual([
      {
        path: "/menu",
        changes: [
          { field: "content", detail: "the main content's text changed" },
          { field: "links", detail: "link added: /book" },
        ],
      },
    ]);
  });

  it("a finding is the check on the path: the same check on two paths is two findings", () => {
    const a = run(
      "r-20261101T100000Z",
      "2026-11-01T10:00:00.000Z",
      { "/a": page(), "/b": page() },
      [f("viewport", "/a"), f("viewport", "/b")],
    );
    const b = run(
      "r-20261102T100000Z",
      "2026-11-02T10:00:00.000Z",
      { "/a": page(), "/b": page() },
      [f("viewport", "/b")],
    );
    const r = compareRuns("x.example", [a, b]);
    if (!r.ok) throw new Error(r.note);
    expect(r.report.fixed.map((x) => x.path)).toEqual(["/a"]);
    expect(r.report.unchanged.map((x) => x.path)).toEqual(["/b"]);
  });

  it("the same input gives the same report, in the same order", () => {
    expect(compareRuns("bar.example", [R2, R1])).toEqual(compareRuns("bar.example", [R1, R2]));
  });
});

describe("compareRuns: which runs", () => {
  const R0 = run("r-20261030T100000Z", "2026-10-30T10:00:00.000Z", { "/": page() }, []);
  it("a run id names the before run", () => {
    const r = compareRuns("x", [R0, R1, R2], { kind: "run", id: R0.id });
    if (!r.ok) throw new Error(r.note);
    expect(r.report.before.id).toBe(R0.id);
    expect(r.report.after.id).toBe(R2.id);
  });

  it("a date names the latest run taken at or before it", () => {
    const r = compareRuns("x", [R0, R1, R2], { kind: "date", at: "2026-11-02T00:00:00.000Z" });
    if (!r.ok) throw new Error(r.note);
    expect(r.report.before.id).toBe(R1.id);
  });

  it("says what is missing instead of guessing: one run, an unknown run id, no run that early, the latest named", () => {
    expect(compareRuns("x", [R1])).toEqual({
      ok: false,
      note: "Only one run is stored for x: run Gaugeline with --since last again after a change to have something to compare.",
    });
    expect(compareRuns("x", [])).toMatchObject({ ok: false });
    expect(compareRuns("x", [R1, R2], { kind: "run", id: "r-20200101T000000Z" })).toEqual({
      ok: false,
      note: "No stored run has the id r-20200101T000000Z. The runs stored for x start at r-20261101T100000Z.",
    });
    expect(compareRuns("x", [R1, R2], { kind: "date", at: "2026-10-01T00:00:00.000Z" })).toEqual({
      ok: false,
      note: "No run was taken on or before 1 Oct 2026. The runs stored for x start on 1 Nov 2026.",
    });
    expect(compareRuns("x", [R1, R2], { kind: "run", id: R2.id })).toEqual({
      ok: false,
      note: `${R2.id} is the latest run: name an earlier run or date to compare it with.`,
    });
  });
});

describe("formatBeforeAfter", () => {
  it("prints the two runs, then fixed, new and still there, each finding by its path", () => {
    const text = formatBeforeAfter(compareRuns("bar.example", [R1, R2]));
    expect(text).toBe(
      [
        "Before: r-20261101T100000Z (1 Nov 2026)   After: r-20261103T100000Z (3 Nov 2026)",
        "2 pages read by both runs. Findings there: 3 before, 2 after.",
        "",
        "Fixed (2)",
        "  nav-utm-lost  /      Title of nav-utm-lost",
        "  broken-links  /menu  Title of broken-links",
        "",
        "New (1)",
        "  noindex  /menu  Title of noindex",
        "",
        "Still there (1)",
        "  viewport  /  Title of viewport",
        "",
        "What changed on the pages:",
        "  /menu: the main content's text changed; link added: /book",
        "",
        "Not compared: 1 finding before and 1 after are on pages only one of the two runs read.",
        "",
      ].join("\n"),
    );
  });

  it("says plainly when nothing was fixed, new or left, and prints a note as it is", () => {
    const a = run("r-20261101T100000Z", "2026-11-01T10:00:00.000Z", { "/": page() }, []);
    const b = run("r-20261102T100000Z", "2026-11-02T10:00:00.000Z", { "/": page() }, []);
    const text = formatBeforeAfter(compareRuns("x", [a, b]));
    expect(text).toContain("Fixed (0)\n  none\n");
    expect(text).toContain("New (0)\n  none\n");
    expect(text).toContain("Still there (0)\n  none\n");
    expect(formatBeforeAfter({ ok: false, note: "Only one run." })).toBe("Only one run.\n");
  });

  it("makes no judgement about who or what changed it", () => {
    const text = formatBeforeAfter(compareRuns("bar.example", [R1, R2]));
    expect(text).not.toMatch(/warranty|fault|caused|because/i);
  });
});
