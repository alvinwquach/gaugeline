import { describe, expect, it } from "vitest";
import { indexingSwitchLoose } from "../indexing-switch-loose.js";
import { noindexSmokeProduction } from "../noindex-smoke-production.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const layout = (expr: string, name = "SITE_INDEXING"): string =>
  `export const metadata = {\n  robots: { index: ${expr.replace("NAME", name)} },\n};\n`;
const switchOf = (files: Record<string, string>) => runOne(indexingSwitchLoose, treeOf(files));
const evidence = async (expr: string, name?: string) =>
  (await switchOf({ "app/layout.tsx": layout(expr, name) })).findings.map((f) => f.evidence);

describe("indexing-switch-loose (FF-05)", () => {
  it("fails: the switch is on for anything but the word false", async () => {
    const r = await runOne(indexingSwitchLoose, await fixtureTree("indexing-switch-loose", "fail"));
    expect(r.passed).toEqual([]);
    expect(r.findings).toEqual([
      {
        checkId: "indexing-switch-loose",
        severity: "medium",
        title: 'The indexing switch accepts more than "true"',
        evidence:
          'app/layout.tsx:3 SITE_INDEXING turns indexing on for any value except "false", so an unset variable or a typo turns it on',
        url: "source:./indexing-switch-loose/fail",
        source: { file: "app/layout.tsx", line: 3 },
      },
    ]);
  });

  it("passes: only the exact word true turns it on", async () => {
    const r = await runOne(indexingSwitchLoose, await fixtureTree("indexing-switch-loose", "pass"));
    expect(r).toMatchObject({ passed: ["indexing-switch-loose"], findings: [], couldNotCheck: [] });
  });

  it.each([
    ['process.env.NAME === "1"', 'turns indexing on for "1", not only for "true"'],
    ['process.env.NAME == "yes"', 'turns indexing on for "yes", not only for "true"'],
    ["process.env.NAME === 1", 'turns indexing on for "1", not only for "true"'],
    [
      'process.env.NAME !== "0"',
      'turns indexing on for any value except "0", so an unset variable or a typo turns it on',
    ],
    [
      "Boolean(process.env.NAME)",
      'turns indexing on for any non-empty value, and "false" and "0" are non-empty',
    ],
    [
      "!!process.env.NAME",
      'turns indexing on for any non-empty value, and "false" and "0" are non-empty',
    ],
    [
      "!process.env.NAME",
      'turns indexing on for any non-empty value, and "false" and "0" are non-empty',
    ],
    [
      "process.env.NAME ? true : false",
      'turns indexing on for any non-empty value, and "false" and "0" are non-empty',
    ],
    ["process.env.NAME", "is passed on as it is, so any non-empty text turns indexing on"],
    ['process.env["NAME"]', "is passed on as it is, so any non-empty text turns indexing on"],
  ])("%s is a finding", async (expr, how) => {
    expect(await evidence(expr)).toEqual([`app/layout.tsx:2 SITE_INDEXING ${how}`]);
  });

  it.each([
    'process.env.NAME === "true"',
    'process.env.NAME?.toLowerCase() === "true"',
    'process.env.NAME.trim() == "true"',
    'Boolean(process.env.NAME === "true")',
  ])("%s is strict and passes", async (expr) => {
    expect((await switchOf({ "app/layout.tsx": layout(expr) })).passed).toEqual([
      "indexing-switch-loose",
    ]);
  });

  it("finds a switch in robots.ts, near an X-Robots-Tag header, and by its name alone", async () => {
    const r = await switchOf({
      "app/robots.ts":
        "export default () => ({ rules: { userAgent: '*', disallow: process.env.HOST_READY === '1' ? '' : '/' } });",
      "next.config.ts":
        "export default { headers: async () => [{ source: '/:path*', headers: process.env.NOINDEX_MODE !== 'x' ? [] : [{ key: 'X-Robots-Tag', value: 'noindex' }] }] };",
      "lib/seo.ts": "export const indexable = Boolean(process.env.SEO_ON);",
    });
    expect(r.findings.map((f) => f.source?.file)).toEqual(["app/robots.ts", "lib/seo.ts"]);
  });

  it("does not look at a variable that has nothing to do with indexing", async () => {
    const r = await switchOf({
      "lib/db.ts":
        'export const on = Boolean(process.env.DATABASE_URL); export const x = process.env.PORT !== "80";',
    });
    expect(r.passed).toEqual(["indexing-switch-loose"]);
  });

  it("is unsure, not passed, for a switch that reads the other way round or a test it cannot read", async () => {
    const a = await switchOf({
      "app/layout.tsx": layout('process.env.NAME !== "true"', "NOINDEX"),
    });
    expect(a.passed).toEqual([]);
    expect(a.couldNotCheck[0]?.reason).toContain("reads the other way round");
    const b = await switchOf({ "app/layout.tsx": layout("flag(process.env.NAME).value") });
    expect(b.passed).toEqual([]);
    expect(b.couldNotCheck[0]?.reason).toContain("passed to a function");
  });

  it("ignores a comment and a string that only talk about the switch", async () => {
    const r = await switchOf({
      "app/layout.tsx":
        '// robots: { index: Boolean(process.env.SEO) }\nexport const note = "process.env.SEO_ON";\n',
    });
    expect(r.passed).toEqual(["indexing-switch-loose"]);
  });

  it("is unsure when there is no source to read, and when a source file was left out", async () => {
    const none = await switchOf({ "README.md": "# bar" });
    expect(none.passed).toEqual([]);
    const left = await runOne(
      indexingSwitchLoose,
      treeOf(
        { "app/layout.tsx": "export const a = 1;" },
        { skipped: { "app/big.ts": "too-large" } },
      ),
    );
    expect(left.passed).toEqual([]);
  });
});

const workflow = (on: string, body = ""): string =>
  `name: smoke\non:\n${on}\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: curl -sI $URL | grep -i noindex ${body}\n`;
const smokeOf = (files: Record<string, string>) => runOne(noindexSmokeProduction, treeOf(files));

describe("noindex-smoke-production (FF-06)", () => {
  it("fails: a preview test and no production test", async () => {
    const r = await runOne(
      noindexSmokeProduction,
      await fixtureTree("noindex-smoke-production", "fail"),
    );
    expect(r.passed).toEqual([]);
    expect(r.findings).toEqual([
      {
        checkId: "noindex-smoke-production",
        severity: "medium",
        title: "The noindex smoke test runs on previews but not on production",
        evidence:
          ".github/workflows/preview-smoke.yml:10 tests noindex on previews, and no workflow tests it on production",
        url: "source:./noindex-smoke-production/fail",
        source: { file: ".github/workflows/preview-smoke.yml", line: 10 },
      },
    ]);
  });

  it("passes: a second workflow tests production", async () => {
    const r = await runOne(
      noindexSmokeProduction,
      await fixtureTree("noindex-smoke-production", "pass"),
    );
    expect(r).toMatchObject({
      passed: ["noindex-smoke-production"],
      findings: [],
      couldNotCheck: [],
    });
  });

  it("a pull request workflow counts as a preview test, and a main-branch one as production", async () => {
    const pr = await smokeOf({ ".github/workflows/a.yml": workflow("  pull_request:") });
    expect(pr.findings).toHaveLength(1);
    const both = await smokeOf({
      ".github/workflows/a.yml": workflow("  pull_request:"),
      ".github/workflows/b.yml": workflow("  push:\n    branches: [main]"),
    });
    expect(both.passed).toEqual(["noindex-smoke-production"]);
  });

  it("one workflow that says preview and production passes: it is not judged job by job", async () => {
    const r = await smokeOf({
      ".github/workflows/a.yml": workflow("  deployment_status:", "&& echo Preview Production"),
    });
    expect(r.findings).toEqual([]);
  });

  it("a comment does not count", async () => {
    const r = await smokeOf({
      ".github/workflows/a.yml":
        "name: ci\non:\n  push:\n# noindex smoke test: Preview only\njobs: {}\n",
    });
    expect(r.passed).toEqual(["noindex-smoke-production"]);
  });

  it("passes when no workflow tests noindex at all", async () => {
    const r = await smokeOf({ ".github/workflows/ci.yml": "name: ci\non: push\njobs: {}\n" });
    expect(r.passed).toEqual(["noindex-smoke-production"]);
  });

  it("does not apply with no workflow files", async () => {
    const none = await smokeOf({ "package.json": "{}" });
    expect(none.passed).toEqual(["noindex-smoke-production"]);
    expect(none.couldNotCheck).toEqual([]);
  });

  it("is unsure, not passed, with a test that names neither, or an unread workflow", async () => {
    const unclear = await smokeOf({ ".github/workflows/a.yml": workflow("  workflow_dispatch:") });
    expect(unclear.passed).toEqual([]);
    expect(unclear.couldNotCheck[0]?.reason).toContain("does not say whether");
    const left = await runOne(
      noindexSmokeProduction,
      treeOf(
        { ".github/workflows/a.yml": workflow("  pull_request:") },
        { skipped: { ".github/workflows/prod.yml": "too-large" } },
      ),
    );
    expect(left.findings).toEqual([]);
    expect(left.couldNotCheck[0]?.reason).toContain("may test production");
  });
});
