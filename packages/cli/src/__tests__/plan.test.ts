import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-plan-"));
  dirs.push(dir);
  cpSync(join(SITES_DIR, "..", "plans", "keyword-map.csv"), join(dir, "keyword-map.csv"));
  return dir;
}

describe("gaugeline plan: e2e (CLI)", () => {
  it("reads the keyword map and prints the plan check page's Output block", async () => {
    const run = capture();
    const code = await main(["plan", "keyword-map.csv"], run.io, { cwd: workdir() });
    expect(code).toBe(0);
    expect(run.out().trimEnd()).toBe(expectedOutput("plan-check", "Example"));
  });

  it("--plan-only is accepted and makes no request", async () => {
    const run = capture();
    expect(await main(["plan", "keyword-map.csv", "--plan-only"], run.io, { cwd: workdir() })).toBe(
      0,
    );
    expect(run.out()).toContain("Read 163 pages");
  });

  it("no URL column: exit 2 with the headers found; a missing file or no file: exit 2", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "bad.csv"), "Page,Title Tag\nHome,Welcome\n");
    let run = capture();
    expect(await main(["plan", "bad.csv"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("The plan has no URL column. Headers found: Page, Title Tag.");
    run = capture();
    expect(await main(["plan", "nope.csv"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("nope.csv could not be read.");
    run = capture();
    expect(await main(["plan"], run.io, { cwd: dir })).toBe(2);
    expect(run.err()).toContain("gaugeline plan needs one plan file");
  });

  it("two URL columns: the first is used and the warning is printed", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "two.csv"), "URL,Address\n/a,/b\n");
    const run = capture();
    expect(await main(["plan", "two.csv"], run.io, { cwd: dir })).toBe(0);
    expect(run.out()).toContain(
      '! Columns "URL" and "Address" both look like the URL column; using "URL".',
    );
  });
});
