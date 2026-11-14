import { describe, expect, it } from "vitest";
import { a11ySpecExpectsViolations } from "../a11y-spec-expects-violations.js";
import { tsconfigTargetEs5 } from "../tsconfig-target-es5.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const NEXT = JSON.stringify({ dependencies: { next: "^16.0.0" } });
const tsconfig = (files: Record<string, string>, over = {}) =>
  runOne(tsconfigTargetEs5, treeOf({ "package.json": NEXT, ...files }, over));

describe("tsconfig-target-es5: fixtures", () => {
  it("fails a tsconfig with comments and trailing commas that sets target es5", async () => {
    const out = await runOne(tsconfigTargetEs5, await fixtureTree("tsconfig-target-es5", "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "tsconfig.json:4: compilerOptions.target is es5.",
    ]);
    expect(out.findings[0]).toMatchObject({ checkId: "tsconfig-target-es5", severity: "low" });
  });

  it("passes ES2017, in any case", async () => {
    const out = await runOne(tsconfigTargetEs5, await fixtureTree("tsconfig-target-es5", "pass"));
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["tsconfig-target-es5"]);
  });

  it("is not sure about a tsconfig that extends a package it cannot read", async () => {
    const out = await runOne(tsconfigTargetEs5, await fixtureTree("tsconfig-target-es5", "unsure"));
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toHaveLength(1);
    expect(out.couldNotCheck[0]?.reason).toContain("not a file in the folder");
  });
});

describe("tsconfig-target-es5: the patterns", () => {
  it("reads the target through a relative extends chain, and names the file that sets it", async () => {
    const out = await tsconfig({
      "tsconfig.json": `{ "extends": "./config/base" }`,
      "config/base.json": `{ "extends": "./target.json" }`,
      "config/target.json": `{\n "compilerOptions": { "target": "ES5" } }`,
    });
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "tsconfig.json extends config/target.json, which sets target to es5 at line 2.",
    ]);
    expect(out.findings[0]?.source).toEqual({ file: "config/target.json", line: 2 });
  });

  it("lets the config's own target beat the one it extends, and the last extends entry win", async () => {
    const own = await tsconfig({
      "tsconfig.json": `{ "extends": "./base.json", "compilerOptions": { "target": "es2022" } }`,
      "base.json": `{ "compilerOptions": { "target": "es5" } }`,
    });
    expect(own.passed).toEqual(["tsconfig-target-es5"]);
    const array = await tsconfig({
      "tsconfig.json": `{ "extends": ["./old.json", "./new.json"] }`,
      "old.json": `{ "compilerOptions": { "target": "es5" } }`,
      "new.json": `{ "compilerOptions": { "target": "es2020" } }`,
    });
    expect(array.passed).toEqual(["tsconfig-target-es5"]);
  });

  it("passes a tsconfig with no target and nothing it extends", async () => {
    const out = await tsconfig({ "tsconfig.json": `{ "compilerOptions": { "strict": true } }` });
    expect(out.passed).toEqual(["tsconfig-target-es5"]);
  });

  it("does not apply to a project that is not a Next.js 13 or later app", async () => {
    const files = { "tsconfig.json": `{ "compilerOptions": { "target": "es5" } }` };
    for (const pkg of [
      JSON.stringify({ dependencies: { react: "19.0.0" } }),
      JSON.stringify({ dependencies: { next: "^12.3.0" } }),
    ]) {
      const out = await runOne(tsconfigTargetEs5, treeOf({ ...files, "package.json": pkg }));
      expect(out.findings).toEqual([]);
      expect(out.passed).toEqual(["tsconfig-target-es5"]);
    }
  });

  it("uses the nearest package.json: an app in a monorepo is judged, a library beside it is not", async () => {
    const out = await runOne(
      tsconfigTargetEs5,
      treeOf({
        "package.json": JSON.stringify({ private: true }),
        "apps/site/package.json": NEXT,
        "apps/site/tsconfig.json": `{ "compilerOptions": { "target": "es5" } }`,
        "packages/old/package.json": JSON.stringify({ name: "old" }),
        "packages/old/tsconfig.json": `{ "compilerOptions": { "target": "es5" } }`,
      }),
    );
    expect(out.findings.map((f) => f.source?.file)).toEqual(["apps/site/tsconfig.json"]);
  });

  it("is not sure about a tsconfig it cannot parse, one that was not read, and a missing extends file", async () => {
    for (const [files, over] of [
      [{ "tsconfig.json": `{ "compilerOptions": ` }, {}],
      [{}, { skipped: { "tsconfig.json": "too-large" as const } }],
      [{ "tsconfig.json": `{ "extends": "./missing.json" }` }, {}],
    ] as const) {
      const out = await tsconfig(files, over);
      expect(out.findings).toEqual([]);
      expect(out.passed).toEqual([]);
      expect(out.couldNotCheck).toHaveLength(1);
    }
  });

  it("prints no value but the target's file and line", async () => {
    const out = await tsconfig({
      "tsconfig.json": `{ "compilerOptions": { "target": "es5", "paths": { "do-not-print-this": ["x"] } } }`,
    });
    expect(JSON.stringify(out)).not.toContain("do-not-print-this");
  });
});

const spec = (body: string, imports = `import AxeBuilder from "@axe-core/playwright";`) =>
  `${imports}\ntest("a page", async ({ page }) => {\n  const results = await new AxeBuilder({ page }).analyze();\n  ${body}\n});`;
const a11y = (files: Record<string, string>, over = {}) =>
  runOne(a11ySpecExpectsViolations, treeOf(files, over));

describe("a11y-spec-expects-violations: fixtures", () => {
  it("fails a spec that expects violations to exist", async () => {
    const out = await runOne(
      a11ySpecExpectsViolations,
      await fixtureTree("a11y-spec-expects-violations", "fail"),
    );
    expect(out.passed).toEqual([]);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "e2e/booking.spec.ts:7: the test expects accessibility violations to exist, so it passes while the page has them.",
    ]);
    expect(out.findings[0]).toMatchObject({ severity: "medium" });
  });

  it("passes a spec that expects none", async () => {
    const out = await runOne(
      a11ySpecExpectsViolations,
      await fixtureTree("a11y-spec-expects-violations", "pass"),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["a11y-spec-expects-violations"]);
  });
});

describe("a11y-spec-expects-violations: the patterns", () => {
  it.each([
    "expect(results.violations.length).toBeGreaterThan(0);",
    "expect(results.violations).not.toEqual([]);",
    "expect(results.violations).not.toHaveLength(0);",
    "expect(results.violations.length).toBeGreaterThanOrEqual(1);",
    "expect(results.violations.length).not.toBe(0);",
    "expect(results.violations.filter((v) => v.impact === 'serious').length).toBeGreaterThan(0);",
    "expect(results.violations.length > 0).toBe(true);",
  ])("fails %s", async (line) => {
    const out = await a11y({ "tests/a11y.spec.ts": spec(line) });
    expect(out.findings).toHaveLength(1);
  });

  it.each([
    "expect(results.violations).toEqual([]);",
    "expect(results.violations).toHaveLength(0);",
    "expect(results.violations.length).toBe(0);",
    "expect(results.passes.length).toBeGreaterThan(0);",
    "// expect(results.violations.length).toBeGreaterThan(0);",
  ])("passes %s", async (line) => {
    const out = await a11y({ "tests/a11y.spec.ts": spec(line) });
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["a11y-spec-expects-violations"]);
  });

  it("reads other axe wrappers, and ignores a test that is not an accessibility scan", async () => {
    const jest = await a11y({
      "src/Form.test.tsx": spec(
        "expect(r.violations.length).toBeGreaterThan(0);",
        `import { axe } from "jest-axe";`,
      ),
    });
    expect(jest.findings).toHaveLength(1);
    const other = await a11y({
      "src/list.test.ts": `test("x", () => { expect(violations.length).toBeGreaterThan(0); });`,
    });
    expect(other.findings).toEqual([]);
  });

  it("does not read a file that is not a test", async () => {
    const out = await a11y({
      "lib/scan.ts": spec("expect(results.violations.length).toBeGreaterThan(0);"),
    });
    expect(out.passed).toEqual(["a11y-spec-expects-violations"]);
  });

  it("is not sure when a test file was not read and nothing was found", async () => {
    const out = await a11y({}, { skipped: { "e2e/big.spec.ts": "too-large" } });
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain("e2e/big.spec.ts was not read");
  });

  it("reports only the file and line", async () => {
    const out = await a11y({
      "e2e/a.spec.ts": spec(
        "expect(results.violations.length).toBeGreaterThan(0); // do-not-print-this",
      ),
    });
    expect(JSON.stringify(out)).not.toContain("do-not-print-this");
  });
});
