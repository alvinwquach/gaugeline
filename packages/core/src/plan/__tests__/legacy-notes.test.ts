import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { runChecks } from "../../run.js";
import { createPlanRegistry } from "../checks.js";
import {
  applyLegacy,
  classify,
  extractLegacy,
  legacyHints,
  legacyReviewCsv,
  pathsIn,
  splitSentences,
} from "../legacy-notes.js";
import { readPlan } from "../read.js";

const PLANS = `${SITES_DIR}../plans/`;
const plan = () => readPlan(readFileSync(`${PLANS}legacy-notes.csv`, "utf8"));

describe("legacy notes: unit", () => {
  it('the sentence splitter keeps "KD 8." and "#1-4" inside the sentence the note puts them in', () => {
    // No break before a digit: "KD 8." stays with what follows, and the instruction is still read.
    expect(splitSentences("Primary KD 8. 301 legacy /a here.")).toEqual([
      "Primary KD 8. 301 legacy /a here.",
    ]);
    expect(splitSentences("Primary KD 8. Absorbs legacy /a via 301.")).toEqual([
      "Primary KD 8.",
      "Absorbs legacy /a via 301.",
    ]);
    expect(splitSentences("Covers #1-4 of the guide. Next.")).toEqual([
      "Covers #1-4 of the guide.",
      "Next.",
    ]);
  });

  it("trailing punctuation is stripped from a path; a full URL becomes its path", () => {
    expect(pathsIn("301 legacy /medical-rcm-solutions/medical-coding here.")).toEqual([
      "/medical-rcm-solutions/medical-coding",
    ]);
    expect(pathsIn("(see /a/b), and https://www.shop.example/old-page.")).toEqual([
      "/a/b",
      "/old-page",
    ]);
    expect(pathsIn("covers #1-4 and /2024 and 50/50")).toEqual([]);
  });

  it("the classifier, one row per kind", () => {
    const cases: [string, string | undefined][] = [
      ["301 legacy /medical-rcm-solutions/medical-coding here.", "redirect-here"],
      ["Absorbs legacy /medical-rcm-solutions via 301.", "redirect-here"],
      [
        "Confirm whether the legacy /specialties/correctional-rcm should redirect here.",
        "unconfirmed",
      ],
      [
        "The legacy /specialties/ophthalmology-billing has no destination in the new sitemap.",
        "no-destination",
      ],
      ["301 legacy medical-billing page here.", "no-path"],
    ];
    for (const [sentence, kind] of cases)
      expect(classify(sentence, pathsIn(sentence)), sentence).toBe(kind);
  });
});

describe("legacy notes: integration (the invented legacy-notes plan, SEO Notes)", () => {
  it("the Coding row gets its legacy URL; Billing gets none and appears once as unresolved", async () => {
    const p = plan();
    const mentions = extractLegacy(p.rows, ["SEO Notes"]);
    applyLegacy(p.rows, mentions);
    const byPage = (page: string) => p.rows.find((r) => r.page === page);
    expect(byPage("Coding")).toMatchObject({
      legacyUrl: "/old-services/medical-coding",
      legacySource: "SEO Notes",
    });
    expect(byPage("Billing")?.legacyUrl).toBeUndefined();
    expect(byPage("Revenue cycle")?.legacyUrl).toBe("/old-services");
    expect(byPage("Contact")?.legacyUrl).toBe("/old-contact");
    const result = await runChecks(
      { plan: p, legacy: mentions, file: "legacy-notes.csv" },
      createPlanRegistry(),
    );
    // Coding and Pathology both claim /old-services/medical-coding: the planted conflict.
    expect(result.findings.map((f) => f.checkId)).toEqual([
      "plan-redirect-conflict",
      "plan-legacy-unresolved",
    ]);
    const evidence =
      result.findings.find((f) => f.checkId === "plan-legacy-unresolved")?.evidence ?? "";
    expect(evidence.match(/line 3 /g)).toHaveLength(1);
    expect(evidence).toContain(
      'line 3 (names the old page in words, not its address): "301 legacy medical-billing page here."',
    );
    expect(evidence).toContain("line 5 /specialties/correctional-rcm (asks whether to redirect)");
  });

  it("every extracted path is in the review table, with its line", () => {
    const mentions = extractLegacy(plan().rows, ["SEO Notes"]);
    expect(mentions.map((m) => [m.line, m.kind, m.path])).toEqual([
      [2, "redirect-here", "/old-services/medical-coding"],
      [3, "no-path", undefined],
      [4, "redirect-here", "/old-services"],
      [5, "unconfirmed", "/specialties/correctional-rcm"],
      [6, "no-destination", "/specialties/ophthalmology-billing"],
      [10, "redirect-here", "/old/labs"],
      [10, "no-destination", "/old/lab-results"],
      [11, "unconfirmed", "/old-services/medical-coding"],
      [12, "redirect-here", "/old-contact"],
      [13, "redirect-here", "/old-services/medical-coding"],
    ]);
    const csv = legacyReviewCsv(mentions).trimEnd().split("\n");
    expect(csv).toHaveLength(mentions.length + 1);
    expect(csv[0]).toBe("line,kind,path,column,sentence");
  });

  it("without --legacy-from nothing is extracted, and the hint names the column with its row count", () => {
    const p = plan();
    expect(p.rows.some((r) => r.legacyUrl)).toBe(false);
    expect(legacyHints(p.rows, ["Page", "URL", "H1"])).toEqual([{ column: "SEO Notes", rows: 10 }]);
  });
});

describe("legacy notes: edge cases", () => {
  const one = (note: string, extraPaths: string[] = []) =>
    extractLegacy(
      [
        { line: 2, url: "/page", path: "/page", raw: { Notes: note } },
        ...extraPaths.map((p, i) => ({ line: 3 + i, url: p, path: p, raw: { Notes: "" } })),
      ],
      ["Notes"],
    );

  it('"Link to /rcm-end-to-end blog" has a path but no "legacy": not extracted', () => {
    expect(one("Link to /rcm-end-to-end blog")).toEqual([]);
  });

  it('"FIX SLUG TYPO: /credentialling should be /credentialing" is about the new slug: not extracted', () => {
    expect(one("FIX SLUG TYPO: /credentialling should be /credentialing")).toEqual([]);
  });

  it("a legacy sentence naming a planned path drops it (rule 1)", () => {
    expect(
      one("Legacy readers: 301 legacy /software/reporting-analytics here.", [
        "/software/reporting-analytics",
      ]),
    ).toEqual([
      {
        line: 2,
        rowPath: "/page",
        column: "Notes",
        sentence: "Legacy readers: 301 legacy /software/reporting-analytics here.",
        kind: "no-path",
      },
    ]);
  });

  it("one cell with two legacy sentences of different kinds gives two mentions", () => {
    expect(
      one("301 legacy /old/a here. The legacy /old/b has no destination.").map((m) => m.kind),
    ).toEqual(["redirect-here", "no-destination"]);
  });

  it("the same legacy path on two rows is kept on both (G18 reports the conflict)", () => {
    const mentions = extractLegacy(plan().rows, ["SEO Notes"]).filter(
      (m) => m.kind === "redirect-here" && m.path === "/old-services/medical-coding",
    );
    expect(mentions.map((m) => m.line)).toEqual([2, 13]);
  });

  it("a full URL in a legacy sentence is reduced to its path", () => {
    expect(
      one("301 from legacy https://www.medusind.example/old-page.").map((m) => m.path),
    ).toEqual(["/old-page"]);
  });
});

describe("legacy notes: promise", () => {
  it("extraction makes no request, and the same file gives the same table twice", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const a = legacyReviewCsv(extractLegacy(plan().rows, ["SEO Notes"]));
    const b = legacyReviewCsv(extractLegacy(plan().rows, ["SEO Notes"]));
    expect(a).toBe(b);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
