// check-community: allow-email (an invented address at a reserved example domain, used only for git commits in a temporary repository)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The decision runs in bash on the Linux runner; the Windows runner has no use for it.
const script = fileURLToPath(new URL("../needs-browser-tests.sh", import.meta.url));
const posix = process.platform !== "win32";
const made: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: "ignore",
  });
}

function write(root: string, file: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), `${file}\n`);
}

// A bare "origin" with a main branch, and a clone on a branch that changes `files`.
function pullRequestChanging(files: string[]): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gl-browser-")));
  made.push(base);
  const origin = join(base, "origin.git");
  const work = join(base, "work");
  git(base, "init", "--bare", "--initial-branch=main", origin);
  git(base, "clone", origin, work);
  write(work, "README.md");
  git(work, "add", "-A");
  git(work, "commit", "-m", "base");
  git(work, "branch", "-M", "main");
  git(work, "push", "origin", "main");
  git(work, "checkout", "-b", "feature");
  for (const f of files) write(work, f);
  git(work, "add", "-A");
  git(work, "commit", "-m", "change");
  return work;
}

function decide(cwd: string, event: string): { run: string; stdout: string } {
  // A merge queue run is compared with the commit the queue built on: here, the tip of main.
  const baseSha = execFileSync("git", ["rev-parse", "origin/main"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const res = spawnSync("bash", [script], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: event,
      BASE_REF: "main",
      BASE_SHA: baseSha,
      GITHUB_OUTPUT: "",
    },
  });
  expect(res.status).toBe(0);
  const m = /^run=(true|false)$/m.exec(res.stdout);
  return { run: m?.[1] ?? "none", stdout: res.stdout };
}

afterEach(() => {
  for (const d of made.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!posix)("needs-browser-tests.sh", () => {
  it("a push to main always runs the browser tests", () => {
    const work = pullRequestChanging(["packages/core/src/robots.ts"]);
    expect(decide(work, "push").run).toBe("true");
  });

  it.each([
    "docs/guides/audit-pack.md",
    "e2e/docs.spec.ts",
    "packages/core/src/checks/noindex.ts",
    "packages/app/src/Shell.tsx",
    "packages/app-server/src/routes.ts",
    "scripts/gen-checks.ts",
    "package.json",
    "pnpm-lock.yaml",
    ".github/workflows/docs.yml",
  ])("a pull request that changes %s runs them", (file) => {
    expect(decide(pullRequestChanging([file]), "pull_request").run).toBe("true");
  });

  it.each([
    "packages/cli/src/audit.ts",
    "packages/core/src/audit/pack.ts",
    "packages/core/src/migration/read.ts",
    "scripts/pr-gate.ts",
    "CLAUDE.md",
  ])("a pull request that changes only %s skips them and says why", (file) => {
    const { run, stdout } = decide(pullRequestChanging([file]), "pull_request");
    expect(run).toBe("false");
    expect(stdout).toContain("skipping the browser tests");
  });

  it.each([
    ["docs/options.md", "true"],
    ["packages/cli/src/audit.ts", "false"],
  ])(
    "a merge queue run that changes %s decides %s the same way a pull request does",
    (file, want) => {
      expect(decide(pullRequestChanging([file]), "merge_group").run).toBe(want);
    },
  );

  it("a merge queue run with no base commit runs them (safe default)", () => {
    const work = pullRequestChanging(["CLAUDE.md"]);
    const res = spawnSync("bash", [script], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, EVENT_NAME: "merge_group", BASE_SHA: "", GITHUB_OUTPUT: "" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("run=true");
  });

  it("one matching file among many that do not is enough", () => {
    const work = pullRequestChanging(["packages/cli/src/audit.ts", "docs/options.md", "CLAUDE.md"]);
    expect(decide(work, "pull_request").run).toBe("true");
  });

  it("a name that only looks like a docs path (mydocs/, docs.md) does not turn them on", () => {
    const work = pullRequestChanging(["mydocs/readme.md", "docs.md"]);
    expect(decide(work, "pull_request").run).toBe("false");
  });
});
