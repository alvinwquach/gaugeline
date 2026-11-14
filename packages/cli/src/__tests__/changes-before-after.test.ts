import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { hostDir } from "../runs.js";

/**
 * gaugeline changes --before-after (NAV-08): the findings of two saved runs side by side. The runs are
 * the invented Harbour Bar events page's, saved on 1 and 3 November 2026. Nothing is requested.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(): string {
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-before-after-"));
  dirs.push(cwd);
  const store = hostDir(cwd, "harbourbar.example");
  mkdirSync(store, { recursive: true });
  cpSync(join(SITES_DIR, "changes-bar-events", "runs"), store, { recursive: true });
  return cwd;
}

async function run(argv: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("changes --before-after: the flag", () => {
  it("is a flag of changes only, in --help and in the flag table, and parses as a boolean", () => {
    expect(flagsFor(FLAGS, "changes").map((f) => f.name)).toContain("before-after");
    expect(flagsFor(FLAGS, "check").map((f) => f.name)).not.toContain("before-after");
    expect(HELP.changes).toContain("--before-after");
    const parsed = parseCliArgs(["changes", "harbourbar.example", "--before-after"]);
    expect(parsed).toMatchObject({ kind: "changes", beforeAfter: true });
    expect(parseCliArgs(["changes", "harbourbar.example"])).toMatchObject({ beforeAfter: false });
  });
});

describe("changes --before-after: end to end", () => {
  it("prints what was fixed, what is new and what is still there, from the two saved runs", async () => {
    const r = await run(["changes", "harbourbar.example", "--before-after"], folder());
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Before: r-20261101T100000Z (1 Nov 2026)   After: r-20261103T100000Z (3 Nov 2026)",
    );
    expect(r.out).toContain("Fixed (1)\n  event-missing-fields  /events");
    expect(r.out).toContain("New (2)");
    expect(r.out).toContain("Still there (5)");
    expect(r.out).toContain("link removed: /book");
  });

  it("--since names the before run by id or by date, and --json prints the same report", async () => {
    const cwd = folder();
    const byId = await run(
      ["changes", "harbourbar.example", "--before-after", "--since", "r-20261101T100000Z"],
      cwd,
    );
    const byDate = await run(
      ["changes", "harbourbar.example", "--before-after", "--since", "2026-11-02"],
      cwd,
    );
    expect(byDate.out).toBe(byId.out);
    const json = await run(["changes", "harbourbar.example", "--before-after", "--json"], cwd);
    const parsed = JSON.parse(json.out) as {
      schema: number;
      ok: boolean;
      report: { fixed: { checkId: string }[]; added: unknown[]; unchanged: unknown[] };
    };
    expect(parsed.schema).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.report.fixed.map((f) => f.checkId)).toEqual(["event-missing-fields"]);
    expect(parsed.report.added).toHaveLength(2);
    expect(parsed.report.unchanged).toHaveLength(5);
  });

  it("with one run, an unknown run id or no run that early it says so and exits 0, never guesses", async () => {
    const empty = mkdtempSync(join(tmpdir(), "gaugeline-before-after-"));
    dirs.push(empty);
    const none = await run(["changes", "harbourbar.example", "--before-after"], empty);
    expect(none.out).toContain("Only one run is stored for harbourbar.example");
    const cwd = folder();
    const unknown = await run(
      ["changes", "harbourbar.example", "--before-after", "--since", "r-20200101T000000Z"],
      cwd,
    );
    expect(unknown.out).toContain("No stored run has the id r-20200101T000000Z");
    const early = await run(
      ["changes", "harbourbar.example", "--before-after", "--since", "2026-10-01"],
      cwd,
    );
    expect(early.out).toContain("No run was taken on or before 1 Oct 2026");
  });

  it("makes no request and writes nothing: the runs folder is as it was", async () => {
    const cwd = folder();
    const before = readdirSync(hostDir(cwd, "harbourbar.example")).sort();
    await run(["changes", "harbourbar.example", "--before-after"], cwd);
    expect(readdirSync(hostDir(cwd, "harbourbar.example")).sort()).toEqual(before);
  });
});
