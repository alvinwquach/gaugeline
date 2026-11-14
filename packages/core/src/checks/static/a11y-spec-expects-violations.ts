import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { lineOf, scanSource } from "./source-scan.js";

// [docs] Playwright > Accessibility testing - https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/accessibility-testing-js.md (main when read, 2026-11-11). Lines 47, 62 and 92 assert `expect(accessibilityScanResults.violations).toEqual([])`: the documented test passes when there are no violations.

const ID = "a11y-spec-expects-violations";
/** A test file: a .test or .spec file, or any code file in a tests, test, e2e or __tests__ folder. */
const TEST_FILE =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:e2e|tests?|__tests__)\/.*\.[cm]?[jt]sx?$/i;
/** What marks a test as an accessibility scan: an axe package or builder. */
const AXE =
  /@axe-core\/|["']axe-core["']|jest-axe|vitest-axe|cypress-axe|\bAxeBuilder\b|\bcheckA11y\b/;
/** Text with brackets inside the expectation, two levels deep: `results.violations.filter((v) => v.impact).length`. */
const PART = "(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))";
const ARG = `(${PART}*?\\bviolations\\b${PART}*?)`;
const EXISTS = new RegExp(
  `expect\\(\\s*${ARG}\\s*\\)\\s*\\.\\s*(?:toBeGreaterThan\\s*\\(\\s*0\\s*\\)|toBeGreaterThanOrEqual\\s*\\(\\s*1\\s*\\)|toBeTruthy\\s*\\(\\s*\\)|not\\s*\\.\\s*(?:toEqual|toStrictEqual|toBe|toHaveLength)\\s*\\(\\s*(?:\\[\\s*\\]|0)\\s*\\))`,
  "g",
);
/** `expect(results.violations.length > 0).toBe(true)` */
const COMPARED = /expect\(\s*[\w$.]*\bviolations\b[\w$.]*\s*>\s*0\s*\)\s*\.\s*toBe\(\s*true\s*\)/g;

export const a11ySpecExpectsViolations = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "The accessibility tests assert that the scan finds no violations.",
  estimateChanges:
    "One assertion per test; larger if the page has real violations that the test was written around and now need fixing.",
  area: "Visitors",
  severity: "medium",
  title: "An accessibility test passes when the page has violations",
  what: "A test that scans a page with axe asserts that violations exist (greater than 0, not equal to an empty list) instead of asserting that there are none.",
  why: "The test is green while the page is inaccessible, and turns red on the day the page is fixed. Everyone who sees a green accessibility test believes the page was checked and found clean. For a bar's booking page or a clinic's contact form, that is a person who cannot book.",
  fix: "Assert that there are none: expect(results.violations).toEqual([]), as Playwright's accessibility guide does. If a test deliberately scans a broken page to prove the scanner works, keep it, name the page and the test so that is clear, and add the same scan of the real page with the assertion above.",
  tech: "static, reads the test files of the folder (a .test or .spec file, or a code file in a tests, test, e2e or __tests__ folder) as text, never runs them, and makes no request; a test is an accessibility test when it mentions an axe package (@axe-core/playwright, axe-core, jest-axe, vitest-axe, cypress-axe), AxeBuilder or checkA11y; in one, an expect of something named violations compared with toBeGreaterThan(0), toBeGreaterThanOrEqual(1), toBeTruthy(), not.toEqual([]) or not.toBe(0), or expect(violations > 0).toBe(true), is a finding that names the file and line; a test file that was not read, with nothing found, is not sure; only the file and line are printed",
  run(input, ctx) {
    const url = `source:${input.tree.label}`;
    const out: Finding[] = [];
    for (const [path, text] of input.tree.files) {
      if (!TEST_FILE.test(path)) continue;
      const { code, bare } = scanSource(text);
      if (!AXE.test(code)) continue;
      const seen = new Set<number>();
      for (const re of [EXISTS, COMPARED])
        for (const m of bare.matchAll(re)) {
          const line = lineOf(bare, m.index);
          if (seen.has(line)) continue;
          seen.add(line);
          out.push({
            checkId: ID,
            severity: "medium",
            title: this.title,
            evidence: `${path}:${line}: the test expects accessibility violations to exist, so it passes while the page has them.`,
            url,
            source: { file: path, line },
          });
        }
    }
    out.sort((a, b) =>
      (a.source?.file ?? "") === (b.source?.file ?? "")
        ? (a.source?.line ?? 0) - (b.source?.line ?? 0)
        : (a.source?.file ?? "") < (b.source?.file ?? "")
          ? -1
          : 1,
    );
    if (out.length === 0) {
      const left = [...input.tree.skipped]
        .filter(([p, r]) => TEST_FILE.test(p) && r !== "secret-looking")
        .map(([p]) => p)
        .sort()[0];
      if (left !== undefined)
        ctx.couldNotCheck?.(
          url,
          `${left} was not read (${input.tree.skipped.get(left)}), and it may hold an accessibility test.`,
        );
    }
    return out;
  },
});
