import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { main } from "../main.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-watch-"));
  dirs.push(dir);
  cpSync(join(SITES_DIR, "cutover-site", "plan.csv"), join(dir, "plan.csv"));
  return dir;
}
const STATE = (dir: string) => join(dir, ".gaugeline", "plan-state.json");

/** One watch day: `gaugeline plan plan.csv --base <fixture> --watch 2026-11-01` on that date. */
async function day(
  name: string,
  dir: string,
  date: string,
  extra: string[] = [],
  env: Record<string, string> = {},
) {
  const site = await startFixture(name);
  try {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [
        "plan",
        "plan.csv",
        "--base",
        site.origin,
        "--allow-private",
        "--watch",
        "2026-11-01",
        ...extra,
      ],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: (s: string) => err.push(s) },
        env: { NO_COLOR: "1", ...env },
      },
      { cwd: dir, now: () => new Date(`${date}T06:17:00Z`) },
    );
    return {
      code,
      out: withoutPassed(out.join("")).trimEnd(),
      err: err.join(""),
      requests: site.total,
      methods: [...site.methods.keys()],
      maxInFlight: site.maxConcurrent,
    };
  } finally {
    await site.close();
  }
}

describe("the 30-day watch: integration (an invented production site, 10 rows, 3 legacy addresses)", () => {
  it("run 1 is the baseline; run 2 unchanged exits 0 with the known count, as the docs show", async () => {
    const dir = workdir();
    const one = await day("cutover-site", dir, "2026-11-01");
    expect(one.code).toBe(1); // the baseline exits by the normal rule: 2 findings
    expect(one.out.split("\n").slice(0, 2)).toEqual([
      "Day 1 of 30 since cutover",
      "No saved state for this watch: this run is the baseline. On a scheduled run that usually means the CI cache was cleared, which is fine.",
    ]);
    expect(existsSync(STATE(dir))).toBe(true);
    const two = await day("cutover-site", dir, "2026-11-09");
    expect(two.code).toBe(0);
    expect(two.out).toBe(expectedOutput("plan-check", "After cutover, the 30-day watch"));
    expect(two.out.endsWith("No new drift. 2 known findings still open.")).toBe(true);
  });

  it("a redirect flipped from 301 to 302: exactly one new finding, plan-redirect-not-301, exit 1", async () => {
    const dir = workdir();
    await day("cutover-site", dir, "2026-11-01");
    const flipped = await day("cutover-flipped", dir, "2026-11-10");
    expect(flipped.code).toBe(1);
    const shown = flipped.out.split("\n").filter((l) => /^[✗!·] /.test(l));
    expect(shown).toEqual(["✗ An old address redirects with a temporary status"]);
    expect(flipped.out).toContain("/old-shop redirects with 302, not 301");
    expect(flipped.out.endsWith("1 new since the last run. 2 known findings still open.")).toBe(
      true,
    );
  });

  it("a known finding fixed: listed as fixed, exit 0", async () => {
    const dir = workdir();
    await day("cutover-site", dir, "2026-11-01");
    const fixed = await day("cutover-fixed", dir, "2026-11-03");
    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain("✓ Fixed: An old address doesn't redirect (line 7 last time)");
    expect(
      fixed.out.endsWith("No new drift. 1 known finding still open. 1 fixed since the last run."),
    ).toBe(true);
  });

  it("day 31: the watch is over, exit 0, and the fixture saw zero requests", async () => {
    const dir = workdir();
    const over = await day("cutover-site", dir, "2026-12-01");
    expect(over.code).toBe(0);
    expect(over.out).toBe(
      "The 30-day watch is over: the cutover was 2026-11-01, 30 days ago. No request was made.",
    );
    expect(over.requests).toBe(0);
  });
});

describe("the 30-day watch: e2e (the example workflow)", () => {
  const text = readFileSync(join(repoRoot, "examples/workflows/cutover-watch.yml"), "utf8");

  it("parses as YAML, runs on a schedule and by hand, and its run step has --watch and --base", () => {
    const wf = parse(text) as {
      on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
      jobs: { watch: { steps: { run?: string; uses?: string; with?: Record<string, string> }[] } };
    };
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on.schedule[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect("workflow_dispatch" in wf.on).toBe(true);
    const run = wf.jobs.watch.steps.find((s) => s.run)?.run ?? "";
    expect(run).toContain("--watch");
    expect(run).toContain("--base");
    const uses = wf.jobs.watch.steps.map((s) => s.uses ?? "");
    expect(uses.some((u) => u.startsWith("actions/cache/restore@"))).toBe(true);
    expect(uses.some((u) => u.startsWith("actions/cache/save@"))).toBe(true);
    // Each save has its own key; restore falls back to the newest by prefix.
    const restore = wf.jobs.watch.steps.find((s) => s.uses?.startsWith("actions/cache/restore@"));
    expect(restore?.with?.key).toContain("${{ github.run_id }}");
    expect(restore?.with?.["restore-keys"]).toBe("gaugeline-watch-");
  });

  it("no line holds a webhook address or a token: secrets come from the secrets context", () => {
    for (const [i, line] of text.split("\n").entries()) {
      expect(line, `line ${i + 1}`).not.toMatch(
        /hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|xox[abposr]-|gh[pousr]_[A-Za-z0-9]/,
      );
      const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
      if (m) {
        expect(m[1] ?? "").toMatch(/@[0-9a-f]{40}$/);
        expect(m[2] ?? "").toMatch(/#\s*v\d+(\.\d+)*/);
      }
    }
    expect(text).toContain("GAUGELINE_SLACK_WEBHOOK: ${{ secrets.GAUGELINE_SLACK_WEBHOOK }}");
  });
});

describe("the 30-day watch: edge cases", () => {
  it("an empty cache (evicted) on a later day is a calm new baseline, said in plain words", async () => {
    const dir = workdir();
    const late = await day("cutover-site", dir, "2026-11-20");
    expect(late.out.split("\n").slice(0, 2)).toEqual([
      "Day 20 of 30 since cutover",
      "No saved state for this watch: this run is the baseline. On a scheduled run that usually means the CI cache was cleared, which is fine.",
    ]);
    expect(late.out).toContain(
      "Baseline saved: 2 findings open. From the next run, only new ones are reported.",
    );
  });

  it("production answers 503 everywhere: could not check, exit 2, the state is not overwritten", async () => {
    const dir = workdir();
    await day("cutover-site", dir, "2026-11-01");
    const before = readFileSync(STATE(dir), "utf8");
    const down = await day("cutover-down", dir, "2026-11-04");
    expect(down.code).toBe(2);
    expect(down.out).toContain("? plan-404 could not be checked: answered 503");
    expect(down.out).not.toContain("A title tag isn't what the plan says");
    expect(readFileSync(STATE(dir), "utf8")).toBe(before);
  });

  it("the plan changed after cutover: the day line says so", async () => {
    const dir = workdir();
    await day("cutover-site", dir, "2026-11-01");
    writeFileSync(
      join(dir, "plan.csv"),
      `${readFileSync(join(dir, "plan.csv"), "utf8")}Gift cards,https://northgate.example/gift-cards,Gift cards | Northgate,Gift cards,\n`,
    );
    const next = await day("cutover-site", dir, "2026-11-02");
    expect(next.out.split("\n")[0]).toBe(
      "Day 2 of 30 since cutover (the plan has changed since the baseline)",
    );
  });

  it("a future cutover date is exit 2 with a clear message; --watch needs --base", async () => {
    const dir = workdir();
    const early = await day("cutover-site", dir, "2026-10-20");
    expect(early.code).toBe(2);
    expect(early.err).toContain("--watch: the cutover date 2026-11-01 is in the future.");
    expect(early.requests).toBe(0);
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await main(
        ["plan", "plan.csv", "--watch", "2026-11-01"],
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: (s: string) => err.push(s) },
          env: {},
        },
        { cwd: dir },
      ),
    ).toBe(2);
    expect(err.join("")).toContain("--watch re-checks production against the plan: add --base");
  });
});

describe("the 30-day watch: promise test", () => {
  it("GET and HEAD only, no more than 5 requests in flight, one per planned path and legacy address", async () => {
    const dir = workdir();
    const one = await day("cutover-site", dir, "2026-11-01");
    expect(one.methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    expect(one.maxInFlight).toBeLessThanOrEqual(5);
    // 10 planned paths and 3 legacy addresses, whose 301s land on 2 of them (fetched once each).
    expect(one.requests).toBeLessThanOrEqual(10 + 3 + 2);
  });
});
