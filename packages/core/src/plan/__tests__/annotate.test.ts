import { readFileSync } from "node:fs";
import { assertGrouped } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import type { Finding } from "../../model.js";
import { annotate, byLine } from "../annotate.js";
import { parseCsv } from "../columns.js";
import { readPlan } from "../read.js";
import { checkPlan } from "../self.js";

const PLANS = `${SITES_DIR}../plans/`;
const f = (
  checkId: string,
  severity: Finding["severity"],
  lines: number[],
  key = "k",
): Finding => ({
  checkId,
  severity,
  title: checkId,
  evidence: `evidence of ${checkId}`,
  url: "plan.csv",
  group: { key, lines },
});
const annotated = (csv: string, findings: Finding[] = []) => {
  const plan = readPlan(csv);
  return parseCsv(annotate(plan.workbook.chosen, plan.rows, findings)).map((r) => r.cells);
};

describe("annotate: unit", () => {
  it("byLine: a row in two groups gets two entries, highest severity first", () => {
    const map = byLine([
      f("plan-duplicate-title", "medium", [2, 3]),
      f("plan-duplicate-address", "high", [3, 4]),
    ]);
    expect(map.get(3)?.map((x) => x.checkId)).toEqual([
      "plan-duplicate-address",
      "plan-duplicate-title",
    ]);
    expect(map.get(2)?.map((x) => x.checkId)).toEqual(["plan-duplicate-title"]);
  });

  it("keeps a quoted cell with a comma and a line break, and adds exactly one column", () => {
    const rows = annotated('URL,Note\n/a,"one, two\nthree"\n/b,x\n');
    expect(rows).toEqual([
      ["URL", "Note", "Gaugeline"],
      ["/a", "one, two\nthree", ""],
      ["/b", "x", ""],
    ]);
  });

  it("a clean row has an empty Gaugeline cell; a finding names the other lines", () => {
    const rows = annotated("URL\n/a\n/a\n/b\n", [
      f("plan-duplicate-address", "high", [2, 3], "/a"),
    ]);
    expect(rows.map((r) => r[1])).toEqual([
      "Gaugeline",
      "plan-duplicate-address: same address as line 3",
      "plan-duplicate-address: same address as line 2",
      "",
    ]);
  });

  it("assertGrouped fails on two findings with the same check and key", () => {
    expect(() =>
      assertGrouped([
        f("plan-duplicate-h1", "medium", [2, 3]),
        f("plan-duplicate-h1", "medium", [4, 5]),
      ]),
    ).toThrow('plan-duplicate-h1: two findings for "k"; report one group');
    expect(() => assertGrouped([{ checkId: "x" }])).toThrow("x: a plan finding without a group");
  });
});

describe("annotate: integration (the invented keyword map)", () => {
  const plan = () => readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));
  const out = () => {
    const p = plan();
    const findings = checkPlan(p.rows, "keyword-map.csv");
    assertGrouped(findings);
    return { text: annotate(p.workbook.chosen, p.rows, findings), findings };
  };

  it("167 data rows and 13 columns", () => {
    const rows = parseCsv(out().text);
    expect(rows).toHaveLength(168);
    expect(new Set(rows.map((r) => r.cells.length))).toEqual(new Set([13]));
  });

  it("the 3 rows on /software/ai-automation each name the other two lines", () => {
    const rows = parseCsv(out().text);
    const at = (line: number) => rows.find((r) => r.line === line)?.cells[12];
    expect(at(146)).toBe("plan-duplicate-address: same address as lines 147, 148");
    expect(at(147)).toBe("plan-duplicate-address: same address as lines 146, 148");
    expect(at(148)).toBe("plan-duplicate-address: same address as lines 146, 147");
  });

  it("the credentialling row names the corrected path; the 4 menu-label rows are skipped: no URL", () => {
    const rows = parseCsv(out().text);
    expect(rows.find((r) => r.line === 61)?.cells[12]).toBe(
      'plan-slug-misspelling: "credentialling" in /credentialing/provider-credentialling, the heading says "credentialing"; did you mean /credentialing/provider-credentialing',
    );
    expect(rows.filter((r) => r.cells[12] === "skipped: no URL")).toHaveLength(4);
  });

  it("reading the copy back gives the same 163 rows as the input", () => {
    const again = readPlan(out().text);
    expect(again.rows).toHaveLength(163);
    expect(again.rows.map((r) => r.url)).toEqual(plan().rows.map((r) => r.url));
  });
});

describe("annotate: edge cases", () => {
  it("an existing Gaugeline column (a copy fed back in) is replaced, not added again", () => {
    const rows = annotated("URL,Gaugeline\n/a,old note\n/a,\n", [
      f("plan-duplicate-address", "high", [2, 3], "/a"),
    ]);
    expect(rows).toEqual([
      ["URL", "Gaugeline"],
      ["/a", "plan-duplicate-address: same address as line 3"],
      ["/a", "plan-duplicate-address: same address as line 2"],
    ]);
  });

  it("an original cell starting with = + - or @ is copied as read; the Gaugeline cell never starts with one", () => {
    const rows = annotated("URL,Note\n/a,=SUM(A1)\n/b,@home\n", [
      { ...f("plan-other", "low", [2]), evidence: "=HYPERLINK()" },
    ]);
    expect(rows[1]).toEqual(["/a", "=SUM(A1)", "plan-other: =HYPERLINK()"]);
    expect(rows[2]).toEqual(["/b", "@home", ""]);
  });

  it("a multi-tab workbook: only the chosen tab is written, with the file's own line numbers", () => {
    const plan = readPlan(readFileSync(`${PLANS}workbook-export.txt`, "utf8"));
    const text = annotate(plan.workbook.chosen, plan.rows, checkPlan(plan.rows));
    expect(text).not.toContain("## Sheet name");
    expect(text).not.toContain("Main category");
    expect(parseCsv(text)).toHaveLength(168);
  });
});
