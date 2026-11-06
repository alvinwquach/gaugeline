import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_FILE, main } from "../main.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(flags: string[], env: Record<string, string> = {}) {
  const site = await startFixture("quick-start");
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-report-"));
  dirs.push(cwd);
  const opened: string[] = [];
  const err: string[] = [];
  try {
    const io = {
      // A person at a terminal: the only case the report is opened.
      stdout: { write: () => true, isTTY: true },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    };
    const code = await main([site.origin, "--allow-private", ...flags], io, {
      cwd,
      open: (p) => opened.push(p),
    });
    return { code, cwd, opened, err: err.join("") };
  } finally {
    await site.close();
  }
}

describe("html report: e2e (CLI)", () => {
  it("running the CLI writes the file and opens it for a person at a terminal", async () => {
    const r = await run([]);
    const path = join(r.cwd, REPORT_FILE);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("<h2>What looked right");
    expect(r.err).toContain(`Report written to ./${REPORT_FILE}\n`);
    expect(r.opened).toEqual([path]);
  });

  it("--no-open writes the file and does not open a browser", async () => {
    const r = await run(["--no-open"]);
    expect(existsSync(join(r.cwd, REPORT_FILE))).toBe(true);
    expect(r.opened).toEqual([]);
  });

  it("CI=true never opens", async () => {
    expect((await run([], { CI: "true" })).opened).toEqual([]);
  });

  it("--json writes no report", async () => {
    const r = await run(["--json"]);
    expect(existsSync(join(r.cwd, REPORT_FILE))).toBe(false);
  });
});
