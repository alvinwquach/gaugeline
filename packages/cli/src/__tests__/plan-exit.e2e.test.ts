import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_DIR, SITES_DIR, startFixture } from "@gaugeline/fixtures";
import type { Finding } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { cell, planStepSummary } from "../step-summary.js";
import { runBin } from "./helpers/bin.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKFLOW = join(repoRoot, "examples/workflows/plan-gate.yml");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-gate-"));
  dirs.push(dir);
  cpSync(join(SITES_DIR, "plan-built", "plan.csv"), join(dir, "plan.csv"));
  // The same plan with one address planned twice: drift in the plan itself.
  writeFileSync(
    join(dir, "dup.csv"),
    `${readFileSync(join(dir, "plan.csv"), "utf8").trimEnd()}\nShop again,https://harbour-pottery.example/shop,Shop | Harbour,Shop\n`,
  );
  return dir;
}

const finding = (i: number, over: Partial<Finding> = {}): Finding => ({
  checkId: "plan-title-drift",
  severity: i % 3 === 0 ? "high" : i % 3 === 1 ? "medium" : "low",
  title: "The page title isn't the planned one",
  evidence: `row ${i}: title differs`,
  url: "plan.csv",
  group: { key: `k${i}`, lines: [i + 2] },
  ...over,
});

describe("plan gate: unit (the step summary)", () => {
  it("0 findings", () => {
    expect(planStepSummary({ file: "plan.csv", rows: 10, findings: [], couldNotCheck: 0 })).toBe(
      "### Gaugeline plan check: plan.csv\n\n**10 rows**, 10 matching. No findings.\n",
    );
  });

  it("3 findings: by level, then a table with plan lines", () => {
    const md = planStepSummary({
      file: "plan.csv",
      rows: 10,
      findings: [0, 1, 2].map((i) => finding(i)),
      couldNotCheck: 0,
    });
    expect(md).toBe(
      [
        "### Gaugeline plan check: plan.csv",
        "",
        "**10 rows**, 7 matching. 3 findings: 1 fix this first, 1 fix soon, 1 worth knowing.",
        "",
        "| Line | Level | Finding | Evidence |",
        "| ---: | --- | --- | --- |",
        "| 2 | Fix this first | The page title isn't the planned one | row 0: title differs |",
        "| 3 | Fix soon | The page title isn't the planned one | row 1: title differs |",
        "| 4 | Worth knowing | The page title isn't the planned one | row 2: title differs |",
        "",
      ].join("\n"),
    );
  });

  it("40 findings: the first 10, then a count of the rest", () => {
    const md = planStepSummary({
      file: "plan.csv",
      rows: 60,
      findings: Array.from({ length: 40 }, (_, i) => finding(i)),
      couldNotCheck: 0,
    });
    expect(md.split("\n").filter((l) => l.startsWith("| ") && /^\| \d/.test(l))).toHaveLength(10);
    expect(md).toContain("…and 30 more: run the plan check locally to see them all.");
  });

  it("pipes and backslashes in a title are escaped in the table", () => {
    expect(cell("Shop | Harbour \\ 2026\nnew line")).toBe("Shop \\| Harbour \\\\ 2026 new line");
    const md = planStepSummary({
      file: "plan.csv",
      rows: 1,
      findings: [finding(0, { evidence: 'title "Shop | Harbour", plan says "Shop \\ Harbour"' })],
      couldNotCheck: 0,
    });
    expect(md).toContain('title "Shop \\| Harbour", plan says "Shop \\\\ Harbour"');
  });
});

describe("plan gate: integration (the example workflow)", () => {
  const text = readFileSync(WORKFLOW, "utf8");
  const wf = parse(text) as {
    on: Record<string, { paths?: string[] } | null>;
    jobs: Record<
      string,
      { if?: string; steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }
    >;
  };

  it("parses as YAML: plan-only filtered to the CSV, plan-against-preview on a successful deployment", () => {
    expect(wf.on.pull_request?.paths).toEqual(["docs/sitemap-plan.csv"]);
    expect(wf.on.push?.paths).toEqual(["docs/sitemap-plan.csv"]);
    expect("deployment_status" in wf.on).toBe(true);
    expect(wf.jobs["plan-against-preview"]?.if).toContain(
      "github.event.deployment_status.state == 'success'",
    );
    expect(wf.jobs["plan-only"]?.steps.at(-1)?.run).toContain('gaugeline plan "$PLAN" --plan-only');
    expect(wf.jobs["plan-against-preview"]?.steps.at(-1)?.run).toContain('--base "$TARGET_URL"');
    for (const job of Object.values(wf.jobs)) {
      expect(job.steps.map((s) => s.uses?.split("@")[0])).toEqual([
        "actions/checkout",
        "actions/setup-node",
        undefined,
      ]);
      expect(job.steps[1]?.with?.["node-version"]).toBe(20);
    }
  });

  it("no line holds a token or webhook address; secrets come from the secrets context only", () => {
    for (const line of text.split("\n")) {
      expect(line).not.toMatch(
        /hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-|Basic [A-Za-z0-9+/=]{8,}/,
      );
      if (/GAUGELINE_(?:VERCEL_BYPASS|BASIC_AUTH):/.test(line))
        expect(line).toMatch(/\$\{\{ secrets\.[A-Z_]+ \}\}/);
    }
  });

  it("the docs carry the same workflow, and say to update the filter when the CSV is renamed", () => {
    const doc = readFileSync(join(DOCS_DIR, "plan-check.md"), "utf8");
    const block = /```yaml title=examples\/workflows\/plan-gate\.yml\n([\s\S]*?)```/.exec(doc)?.[1];
    expect(block).toBe(text);
    expect(doc).toMatch(/rename[^.]*CSV[^.]*update[^.]*paths filter/i);
    // A production deployment runs the job too: the docs show how to restrict it.
    expect(doc).toContain("github.event.deployment.environment == 'Preview'");
  });
});

describe("plan gate: e2e (the built CLI, the exit codes a workflow relies on)", () => {
  const run = async (
    args: (origin: string) => string[],
    fixture?: string,
    env: Record<string, string> = {},
  ) => {
    const dir = workdir();
    const site = fixture ? await startFixture(fixture) : undefined;
    try {
      const r = await runBin(args(site?.origin ?? ""), { NO_COLOR: "1", ...env }, { cwd: dir });
      return { ...r, dir };
    } finally {
      await site?.close();
    }
  };

  it.each([
    ["a clean plan", 0, (_: string) => ["plan", "plan.csv", "--plan-only"], undefined],
    ["a plan with a duplicate", 1, (_: string) => ["plan", "dup.csv", "--plan-only"], undefined],
    ["drift on the preview", 1, (o: string) => ["plan", "plan.csv", "--base", o], "plan-built"],
    [
      "a protected preview",
      2,
      (o: string) => ["plan", "plan.csv", "--base", o],
      "preview-basic-auth",
    ],
    ["a missing file", 2, (_: string) => ["plan", "missing.csv", "--plan-only"], undefined],
  ] as const)("%s exits %i", async (_name, code, args, fixture) => {
    expect((await run(args, fixture)).status).toBe(code);
  });

  it("GITHUB_STEP_SUMMARY set: the file gains one summary. Unset: no file is created", async () => {
    const dir = workdir();
    const summary = join(dir, "summary.md");
    const site = await startFixture("plan-built");
    try {
      const r = await runBin(
        ["plan", "plan.csv", "--base", site.origin],
        { NO_COLOR: "1", GITHUB_STEP_SUMMARY: summary },
        { cwd: dir },
      );
      expect(r.status).toBe(1);
      const md = readFileSync(summary, "utf8");
      expect(md.match(/^### Gaugeline plan check: plan\.csv$/gm)).toHaveLength(1);
      expect(md).toContain("**10 rows**");
      const unset = await runBin(
        ["plan", "plan.csv", "--plan-only"],
        { NO_COLOR: "1" },
        { cwd: dir },
      );
      expect(unset.status).toBe(0);
      expect(readFileSync(summary, "utf8")).toBe(md);
      expect(existsSync(join(dir, "GITHUB_STEP_SUMMARY"))).toBe(false);
    } finally {
      await site.close();
    }
  });
});

describe("plan gate: edge cases", () => {
  it("a plan with findings and a protected preview: exit 2, and the plan's findings were not evaluated", async () => {
    const dir = workdir();
    const site = await startFixture("preview-basic-auth");
    try {
      const r = await runBin(
        ["plan", "dup.csv", "--base", site.origin],
        { NO_COLOR: "1" },
        { cwd: dir },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(
        /The plan has \d+ findings? of its own, not evaluated against the site and not reported: this run could not finish\./,
      );
      expect(r.stdout).not.toContain("Two rows in the plan share one address");
    } finally {
      await site.close();
    }
  });

  it("a fork's run has no secrets: a protected preview is exit 2 with the variable to set, never a pass", async () => {
    const dir = workdir();
    const site = await startFixture("preview-basic-auth");
    try {
      // Unset secrets arrive as empty strings in the job's environment.
      const r = await runBin(
        ["plan", "plan.csv", "--base", site.origin],
        { NO_COLOR: "1", GAUGELINE_BASIC_AUTH: "", GAUGELINE_VERCEL_BYPASS: "" },
        { cwd: dir },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Set GAUGELINE_BASIC_AUTH to user:password.");
    } finally {
      await site.close();
    }
  });

  it("--plan-only on a multi-tab export says which tab was read", async () => {
    const r = await runBin(
      ["plan", join(repoRoot, "packages/fixtures/plans/workbook-export.txt"), "--plan-only"],
      { NO_COLOR: "1" },
      { cwd: workdir() },
    );
    expect(r.stderr).toContain("Read tab: Kim's Keywords (6 other tabs skipped)");
  });

  it("promise: the step summary and the job log hold no secret (canary values)", async () => {
    const dir = workdir();
    const summary = join(dir, "summary.md");
    const site = await startFixture("preview-basic-auth");
    const CANARY_BASIC = "harbour:glaze-and-fire";
    const CANARY_BYPASS = "canary-bypass-0f3e9a71";
    try {
      const r = await runBin(
        ["plan", "plan.csv", "--base", site.origin],
        {
          NO_COLOR: "1",
          GITHUB_STEP_SUMMARY: summary,
          GAUGELINE_BASIC_AUTH: CANARY_BASIC,
          GAUGELINE_VERCEL_BYPASS: CANARY_BYPASS,
        },
        { cwd: dir },
      );
      expect(r.status).toBe(1);
      const all = `${r.stdout}${r.stderr}${readFileSync(summary, "utf8")}`;
      for (const secret of [
        CANARY_BASIC,
        "glaze-and-fire",
        CANARY_BYPASS,
        Buffer.from(CANARY_BASIC).toString("base64"),
      ])
        expect(all).not.toContain(secret);
    } finally {
      await site.close();
    }
  });
});
