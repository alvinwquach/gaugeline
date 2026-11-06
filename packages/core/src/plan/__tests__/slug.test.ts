import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { damerau } from "../../text/distance.js";
import { readPlan, type PlanRow } from "../read.js";
import { checkSlugs, misspelling, sameStem } from "../slug.js";

const PLANS = `${SITES_DIR}../plans/`;
const row = (url: string, h1: string, page?: string): PlanRow => ({
  line: 2,
  url,
  path: url,
  h1,
  ...(page ? { page } : {}),
  raw: {},
});
const evidence = (r: PlanRow) => checkSlugs([r]).map((f) => f.evidence);

describe("slug misspelling: unit", () => {
  it("damerau: a swap, a doubled letter and a dropped letter are 1; the bound returns max + 1 early", () => {
    expect(damerau("ambutatory", "ambulatory", 2)).toBe(1);
    expect(damerau("ca", "ac", 2)).toBe(1);
    expect(damerau("credentialling", "credentialing", 2)).toBe(1);
    expect(damerau("coding", "codng", 2)).toBe(1);
    expect(damerau("abcdef", "uvwxyz", 2)).toBe(3);
    expect(damerau("short", "a much longer word", 2)).toBe(3);
    expect(damerau("same", "same", 2)).toBe(0);
  });

  it("excused pairs: plural, tense and British/American spelling", () => {
    expect(sameStem("rates", "rate")).toBe(true);
    expect(sameStem("billing", "billed")).toBe(true);
    expect(misspelling("optimise", new Set(["optimize"]))).toBeUndefined();
    expect(misspelling("cannibalisation", new Set(["cannibalization"]))).toBeUndefined();
    expect(misspelling("credentialling", new Set(["credentialing"]))).toBe("credentialing");
  });

  it("words under 5 letters never fire", () => {
    expect(evidence(row("/core", "Care"))).toEqual([]);
    expect(evidence(row("/rcm", "RPM"))).toEqual([]);
  });
});

describe("slug misspelling: integration (the invented keyword map)", () => {
  const plan = () => readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));

  it("exactly 2 findings: credentialling and ambutatory, each with the corrected path", () => {
    expect(checkSlugs(plan().rows, "keyword-map.csv").map((f) => f.evidence)).toEqual([
      'line 4: "ambutatory" in /billing-services/ambutatory-care, the heading says "ambulatory"; did you mean /billing-services/ambulatory-care',
      'line 61: "credentialling" in /credentialing/provider-credentialling, the heading says "credentialing"; did you mean /credentialing/provider-credentialing',
    ]);
  });

  it("no finding on the 160 rows whose slugs match their headings", () => {
    const rows = plan().rows.filter((r) => r.line !== 4 && r.line !== 61);
    expect(rows).toHaveLength(161);
    expect(checkSlugs(rows)).toEqual([]);
  });
});

describe("slug misspelling: edge cases", () => {
  it("an abbreviation (ar-management for Accounts Receivable Management) does not fire", () => {
    expect(evidence(row("/billing/ar-management", "Accounts Receivable Management"))).toEqual([]);
  });

  it("payments/Payment, insights/Insight and claims/claim are excused as plurals", () => {
    expect(evidence(row("/patient-payments", "Patient Payment"))).toEqual([]);
    expect(evidence(row("/resources/insights", "Insight"))).toEqual([]);
    expect(evidence(row("/claims", "Claim management"))).toEqual([]);
  });

  it("a heading with no word of 5 letters or more, and the home page, are skipped", () => {
    expect(evidence(row("/ar-faq", "AR FAQ"))).toEqual([]);
    expect(evidence(row("/", "Welcome to Harbourline"))).toEqual([]);
  });

  it("a non-ASCII heading compares after Unicode folding", () => {
    expect(evidence(row("/careers/resume-tips", "Résumé tips"))).toEqual([]);
    expect(evidence(row("/careers/resmue-guide", "Résumé guide"))).toEqual([
      'line 2: "resmue" in /careers/resmue-guide, the heading says "resume"; did you mean /careers/resume-guide',
    ]);
  });

  it("a trailing slash still checks the last segment; distance 2 only for 8+ letter words", () => {
    expect(evidence(row("/credentailing/", "Credentialing"))[0]).toContain('"credentailing"');
    expect(evidence(row("/billng", "Billing"))).toHaveLength(1);
    expect(evidence(row("/blling", "Billing"))).toHaveLength(1);
    expect(evidence(row("/bllng", "Billing"))).toEqual([]);
  });
});

describe("slug misspelling: promise", () => {
  it("the same file twice gives identical findings, with no request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const read = () =>
      JSON.stringify(checkSlugs(readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8")).rows));
    expect(read()).toBe(read());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
