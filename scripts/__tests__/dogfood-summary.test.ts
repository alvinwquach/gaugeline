import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startFixture, type Fixture } from "../../packages/fixtures/src/index.js";
import { issueAction, summarise } from "../lib/dogfood.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const result = (
  findings: { checkId: string; severity: "high" | "medium" | "low" }[],
  passed: string[] = [],
) => ({
  schema: 2,
  couldNotCheck: [],
  sampled: {},
  url: "https://docs.example/",
  startedAt: "2026-01-01T00:00:00.000Z",
  findings: findings.map((f) => ({
    ...f,
    title: `Title of ${f.checkId}`,
    evidence: "e",
    url: "https://docs.example/",
  })),
  passed,
  failed: [],
});

describe("summarise: unit", () => {
  it('a clean result gives "0 to fix first" and lists the passed check ids', () => {
    const md = summarise(result([], ["canonical-elsewhere", "noindex"]));
    expect(md).toContain("**0 to fix first**");
    expect(md).toContain("Passed: `canonical-elsewhere`, `noindex`");
  });

  it("two high and one low finding: counts are right and high findings are listed first", () => {
    const md = summarise(
      result([
        { checkId: "canonical-missing", severity: "low" },
        { checkId: "noindex", severity: "high" },
        { checkId: "thin-html", severity: "high" },
      ]),
    );
    expect(md).toContain("**2 to fix first**, 0 to fix soon, 1 worth knowing.");
    const lines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      "- Fix this first",
      "- Fix this first",
      "- Worth knowing",
    ]);
  });

  it("each finding line links to /docs/checks?id=<checkId>", () => {
    expect(summarise(result([{ checkId: "noindex", severity: "high" }]))).toContain(
      "[noindex](/docs/checks?id=noindex)",
    );
  });

  it("JSON with a schema other than the current one throws, naming the schema number", () => {
    expect(() => summarise({ ...result([]), schema: 1 })).toThrow("got schema 1");
  });
});

const fixtures: Fixture[] = [];
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
async function dogfood(fixture: string, path = "/", env: Record<string, string> = {}) {
  const site = await startFixture(fixture);
  fixtures.push(site);
  const out = mkdtempSync(join(tmpdir(), "gaugeline-dogfood-"));
  temps.push(out);
  const r = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
        join(repoRoot, "scripts/dogfood.ts"),
        `${site.origin}${path}`,
        "--out",
        out,
        "--allow-private",
      ],
      {
        env: { ...process.env, CI: "", GITHUB_STEP_SUMMARY: join(out, "step-summary.md"), ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
  return { ...r, out, site };
}

describe("dogfood: integration (built bin against fixtures)", () => {
  it('the "clean" fixture with --ci: exit 0, findings.json parses', async () => {
    const r = await dogfood("clean");
    expect(r.status, r.stderr).toBe(0);
    expect(
      (JSON.parse(readFileSync(join(r.out, "findings.json"), "utf8")) as { schema: number }).schema,
    ).toBe(2);
    expect(readFileSync(join(r.out, "step-summary.md"), "utf8")).toContain("**0 to fix first**");
  }, 60_000);

  it("a fix-first finding (the quick-start fixture's wrong canonical) with --ci: exit 1, and the files exist", async () => {
    const r = await dogfood("quick-start");
    expect(r.status).toBe(1);
    expect(existsSync(join(r.out, "findings.json"))).toBe(true);
    expect(readFileSync(join(r.out, "summary.md"), "utf8")).toContain(
      "[canonical-elsewhere](/docs/checks?id=canonical-elsewhere)",
    );
  }, 60_000);

  it('the "slow" fixture: exit 2 with "did not answer", and no findings.json is written', async () => {
    const r = await dogfood("slow");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("The docs site did not answer.");
    expect(existsSync(join(r.out, "findings.json"))).toBe(false);
  }, 60_000);
});

describe("dogfood: promise test", () => {
  it("the self-check makes only GET and HEAD requests and stays inside the published limits", async () => {
    const r = await dogfood("clean");
    expect([...r.site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    expect(r.site.maxConcurrent).toBeLessThanOrEqual(5);
    expect(r.site.total).toBeLessThanOrEqual(30 + 20 + 25 + 15 + 3 + 12 + 10);
  }, 60_000);

  it("the step summary contains no environment variable values", async () => {
    const r = await dogfood("quick-start", "/", {
      GAUGELINE_SECRET_MARKER: "MARKER_DOGFOOD_99",
      NETLIFY_AUTH_TOKEN: "MARKER_NETLIFY_77",
    });
    const summary = readFileSync(join(r.out, "step-summary.md"), "utf8");
    expect(summary).not.toContain("MARKER_DOGFOOD_99");
    expect(summary).not.toContain("MARKER_NETLIFY_77");
  }, 60_000);
});

describe("dogfood: edge cases", () => {
  it("the open issue already exists: it is edited, no second issue; a clean run closes it", () => {
    expect(issueAction({ number: 7 }, 1)).toEqual({ action: "edit", number: 7 });
    expect(issueAction(undefined, 1)).toEqual({ action: "create" });
    expect(issueAction({ number: 7 }, 0)).toEqual({ action: "close", number: 7 });
    expect(issueAction(undefined, 0)).toEqual({ action: "none" });
    expect(issueAction({ number: 7 }, 2)).toEqual({ action: "none" });
  });

  it("the preview address with a trailing path and query is passed through unchanged", async () => {
    const r = await dogfood("clean", "/menu?preview=1");
    expect(r.status, r.stderr).toBe(0);
    expect(
      (JSON.parse(readFileSync(join(r.out, "findings.json"), "utf8")) as { url: string }).url,
    ).toMatch(/\/menu\?preview=1$/);
  }, 60_000);

  it("a deployment_status for another environment is skipped, and forks never get secrets", () => {
    const wf = readFileSync(join(repoRoot, ".github/workflows/dogfood.yml"), "utf8");
    expect(wf).toContain("github.event.deployment.environment == 'docs-preview'");
    expect(wf).toContain("github.event.deployment_status.state == 'success'");
    expect(wf).not.toMatch(/secrets\./);
    expect(wf).toContain("if: always()");
    expect(wf).toContain("retention-days: 14");
    expect(wf).toContain('cron: "17 3 * * *"');
  });
});
