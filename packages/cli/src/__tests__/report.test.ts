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

  it("a folder the run can't write to: a warning on stderr, the run still exits 0, nothing is opened", async () => {
    const site = await startFixture("quick-start");
    const opened: string[] = [];
    const err: string[] = [];
    try {
      const io = {
        stdout: { write: () => true, isTTY: true },
        stderr: { write: (s: string) => err.push(s) },
        env: { NO_COLOR: "1" },
      };
      // A folder that doesn't exist fails the write the same way a read-only one does, even as root.
      const code = await main([site.origin, "--allow-private"], io, {
        cwd: join(tmpdir(), "gaugeline-no-such-folder", "deeper"),
        open: (p) => opened.push(p),
      });
      expect(code).toBe(0);
      expect(err.join("")).toContain(`Could not write ./${REPORT_FILE} in this folder (ENOENT)`);
      expect(err.join("")).not.toContain("Report written");
      expect(opened).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("the report for the clean fixture lists what was verified and has no empty section headings", async () => {
    const site = await startFixture("clean");
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-report-"));
    dirs.push(cwd);
    try {
      const io = {
        stdout: { write: () => true },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      };
      await main([site.origin, "--allow-private", "--no-open"], io, { cwd });
    } finally {
      await site.close();
    }
    const html = readFileSync(join(cwd, REPORT_FILE), "utf8");
    expect(html).toContain("<h2>What looked right");
    expect(html).toContain("<h3>Search &amp; sharing</h3>");
    // Every heading is followed by content, never straight by another heading or the end.
    expect(html).not.toMatch(/<\/h2>\s*(?:<h2|<\/body>)/);
    expect(html).not.toMatch(/<\/h3>\s*(?:<h[23]|<\/body>)/);
  });

  it("--json writes no report", async () => {
    const r = await run(["--json"]);
    expect(existsSync(join(r.cwd, REPORT_FILE))).toBe(false);
  });
});
