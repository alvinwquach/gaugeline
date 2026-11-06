import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicSurface } from "../../packages/core/src/index.js";
import { checkSurface, diffSurface } from "../lib/surface.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const lock = JSON.parse(
  readFileSync(join(repoRoot, "public-surface.lock.json"), "utf8"),
) as PublicSurface;
const clone = (s: PublicSurface): PublicSurface => JSON.parse(JSON.stringify(s)) as PublicSurface;
const run = (
  before: PublicSurface,
  after: PublicSurface,
  bump: "none" | "patch" | "minor" | "major",
  over: Partial<Parameters<typeof checkSurface>[0]> = {},
) =>
  checkSurface({
    before,
    after,
    bump,
    summaries: [],
    version: "1.2.0",
    deprecated: new Map(),
    ...over,
  });
const without = (s: PublicSurface, id: string): PublicSurface => {
  const c = clone(s);
  c.checkIds = c.checkIds.filter((x) => x !== id);
  delete c.severities[id];
  return c;
};

describe("check-surface: rules", () => {
  it("remove a check id with a patch changeset: exit 1, names the id", () => {
    const r = run(lock, without(lock, "thin-html"), "patch");
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("check:thin-html");
  });

  it("remove a check id with a major changeset, deprecated and removeIn reached: ok", () => {
    const deprecated = new Map([["check:thin-html", { since: "1.0.0", removeIn: "1.2.0" }]]);
    expect(run(lock, without(lock, "thin-html"), "major", { deprecated })).toEqual({
      ok: true,
      problems: [],
      notes: [],
    });
  });

  it("remove a deprecated flag whose removeIn is a later version: not yet", () => {
    const after = clone(lock);
    // Removed from every command that has it (check and launch).
    for (const c of Object.keys(after.flags))
      after.flags[c] = (after.flags[c] ?? []).filter((f) => f !== "quiet");
    const deprecated = new Map([["--quiet", { since: "1.0.0", removeIn: "2.0.0" }]]);
    const r = run(lock, after, "major", { deprecated });
    expect(r.problems).toEqual([
      "--quiet is deprecated but not yet removable: removeIn is 2.0.0, this is 1.2.0.",
    ]);
  });

  it("add a flag with a minor changeset: ok", () => {
    const after = clone(lock);
    after.flags.check = [...(after.flags.check ?? []), "slack"].sort();
    expect(run(lock, after, "minor").ok).toBe(true);
    expect(run(lock, after, "patch").problems).toEqual([
      "--slack was added: that needs a minor changeset, not patch.",
    ]);
  });

  it("rename an environment variable: one removal and one addition", () => {
    const after = clone(lock);
    after.envVars = after.envVars.map((v) => (v === "NO_COLOR" ? "GAUGELINE_NO_COLOR" : v)).sort();
    expect(diffSurface(lock, after)).toEqual({
      removed: ["env:NO_COLOR"],
      added: ["env:GAUGELINE_NO_COLOR"],
      severityChanged: [],
    });
  });
});

describe("check-surface: edge cases", () => {
  it("version 0.x: a removal with a minor changeset passes, and says the pre-1.0 rule was applied", () => {
    const deprecated = new Map([["check:thin-html", { since: "0.0.2", removeIn: "0.3.0" }]]);
    const r = run(lock, without(lock, "thin-html"), "minor", { version: "0.3.0", deprecated });
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual(["pre-1.0 rule applied: a minor bump stands in for major."]);
  });

  it("a check's severity changes with a patch changeset: exit 1, asks for minor and a changelog line", () => {
    const after = clone(lock);
    after.severities["redirect-chain"] = "high";
    const r = run(lock, after, "patch", { summaries: ["Fixes a typo."] });
    expect(r.problems).toEqual([
      "check:redirect-chain changed severity (medium to high): that needs a minor changeset.",
      "check:redirect-chain changed severity (medium to high): add a changelog line that names redirect-chain.",
    ]);
    expect(
      run(lock, after, "minor", { summaries: ["redirect-chain is now Fix this first."] }).ok,
    ).toBe(true);
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
/** The script against a temp root holding a lock file, a package version and some changesets. */
function surfaceScript(
  opts: {
    lock: PublicSurface;
    current: PublicSurface;
    version: string;
    changesets: Record<string, string>;
  },
  args: string[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-surface-"));
  temps.push(dir);
  mkdirSync(join(dir, "packages/cli"), { recursive: true });
  mkdirSync(join(dir, ".changeset"));
  writeFileSync(join(dir, "public-surface.lock.json"), `${JSON.stringify(opts.lock, null, 2)}\n`);
  writeFileSync(join(dir, "packages/cli/package.json"), JSON.stringify({ version: opts.version }));
  writeFileSync(join(dir, "current.json"), JSON.stringify(opts.current));
  for (const [f, body] of Object.entries(opts.changesets))
    writeFileSync(join(dir, ".changeset", f), body);
  const r = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      join(repoRoot, "scripts/check-surface.ts"),
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, SURFACE_ROOT: dir, SURFACE_OVERRIDE: join(dir, "current.json") },
    },
  );
  return { ...r, dir };
}

describe("check-surface script: integration", () => {
  it("add a flag with a minor changeset: exit 0 and the lock file is updated", () => {
    const current = clone(lock);
    current.flags.check = [...(current.flags.check ?? []), "slack"].sort();
    const r = surfaceScript({
      lock,
      current,
      version: "0.1.0",
      changesets: { "slack.md": '---\n"gaugeline": minor\n---\n\nSends results to Slack.\n' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      (JSON.parse(readFileSync(join(r.dir, "public-surface.lock.json"), "utf8")) as PublicSurface)
        .flags.check,
    ).toContain("slack");
  }, 30_000);

  it("remove a check id with a patch changeset: exit 1 naming the id; the lock is not touched", () => {
    const r = surfaceScript({
      lock,
      current: without(lock, "noindex"),
      version: "0.1.0",
      changesets: { "x.md": '---\n"gaugeline": patch\n---\n\nFixes something.\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("check:noindex was removed without being deprecated first");
    expect(
      (JSON.parse(readFileSync(join(r.dir, "public-surface.lock.json"), "utf8")) as PublicSurface)
        .checkIds,
    ).toContain("noindex");
  }, 30_000);

  it("the Release pull request (no changesets left) compares against the version bump instead", () => {
    const current = clone(lock);
    current.flags.check = [...(current.flags.check ?? []), "slack"].sort();
    const r = surfaceScript({ lock, current, version: "0.1.0", changesets: {} });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--slack was added: that needs a minor changeset, not none.");
  }, 30_000);

  it("--check fails when the committed lock file is out of date, and passes when it is current", () => {
    const stale = surfaceScript(
      {
        lock: { ...lock, checkIds: lock.checkIds.slice(1) },
        current: lock,
        version: "0.1.0",
        changesets: { "c.md": '---\n"gaugeline": minor\n---\n\nAdds a check.\n' },
      },
      ["--check"],
    );
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(
      "public-surface.lock.json is out of date. Run pnpm surface and commit it.",
    );
    const current = surfaceScript({ lock, current: lock, version: "0.1.0", changesets: {} }, [
      "--check",
    ]);
    expect(current.status, current.stderr).toBe(0);
  }, 30_000);
});
