import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { main } from "../main.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gaugeline-format-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

async function run(fixture: string, argv: string[]) {
  const site = await startFixture(fixture);
  try {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [site.origin, "--allow-private", "--no-open", ...argv],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: (s: string) => err.push(s) },
        env: { NO_COLOR: "1" },
      },
      { cwd: dir },
    );
    return { code, out: out.join(""), err: err.join(""), origin: site.origin };
  } finally {
    await site.close();
  }
}

describe("--format", () => {
  it("sarif: stdout is the SARIF log and nothing else, with one rule per finding's check", async () => {
    const r = await run("deploy-preview-dentist", ["--format", "sarif"]);
    const log = JSON.parse(r.out);
    expect(log.version).toBe("2.1.0");
    const run0 = log.runs[0];
    expect(run0.results.length).toBeGreaterThan(0);
    const ruleIds = run0.tool.driver.rules.map((x: { id: string }) => x.id);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    for (const res of run0.results) expect(ruleIds).toContain(res.ruleId);
    // A text report would have written a file: a machine format writes none.
    expect(existsSync(join(dir, "gaugeline-report.html"))).toBe(false);
    expect(r.code).toBe(0);
  });

  it("junit: stdout is the XML and nothing else", async () => {
    const r = await run("deploy-preview-dentist", ["--format", "junit"]);
    expect(r.out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ')).toBe(true);
    expect(r.out.trimEnd().endsWith("</testsuites>")).toBe(true);
    expect(r.out).toContain("<failure ");
  });

  it("json: the same result as --json", async () => {
    const a = JSON.parse((await run("deploy-preview-dentist", ["--format", "json"])).out);
    const b = JSON.parse((await run("deploy-preview-dentist", ["--json"])).out);
    // Each run has its own port and clock: compare what the run found.
    expect(a.findings.map((f: { checkId: string }) => f.checkId)).toEqual(
      b.findings.map((f: { checkId: string }) => f.checkId),
    );
    expect(a.schema).toBe(b.schema);
  });

  it("the exit codes do not change: --ci still exits 1 on a Fix this first finding, in every format", async () => {
    for (const format of ["sarif", "junit", "json"]) {
      const r = await run("deploy-preview-dentist", ["--format", format, "--ci"]);
      expect(r.code, format).toBe(1);
    }
    const clean = await run("clean", ["--format", "sarif", "--ci"]);
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.out).runs[0].results).toEqual([]);
  });

  it("an unknown format and a format that disagrees with --json are exit 2, naming the choices", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    };
    expect(await main(["https://tapas.example/", "--format", "html"], io, { cwd: dir })).toBe(2);
    expect(err.join("")).toContain("--format accepts json, sarif or junit");
    err.length = 0;
    expect(
      await main(["https://tapas.example/", "--format", "sarif", "--json"], io, { cwd: dir }),
    ).toBe(2);
    expect(err.join("")).toContain("--json");
    expect(out.join("")).toBe("");
  });

  it("parses to the machine-output path: json true, and the format kept for sarif and junit", () => {
    const parsed = (...argv: string[]) => parseCliArgs(argv, {});
    expect(parsed("example.com", "--format", "sarif")).toMatchObject({
      json: true,
      format: "sarif",
    });
    expect(parsed("example.com", "--format", "junit")).toMatchObject({
      json: true,
      format: "junit",
    });
    expect(parsed("example.com", "--format", "json")).toMatchObject({ json: true });
    expect(parsed("example.com")).toMatchObject({ json: false });
  });
});
