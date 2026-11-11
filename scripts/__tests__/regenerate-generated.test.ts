import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATED_FILES } from "../lib/gen-all.js";
import {
  BOT,
  COMMIT_MESSAGE,
  isRegenerateCommit,
  regenerate,
  type Outcome,
} from "../lib/regenerate.js";

let dir = "";
let origin = "";
let work = "";
let other = "";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "human",
  GIT_AUTHOR_EMAIL: "human@example.test",
  GIT_COMMITTER_NAME: "human",
  GIT_COMMITTER_EMAIL: "human@example.test",
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
const OPTIONS = "docs/options.md";

function commitFile(cwd: string, path: string, text: string, message: string): void {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "gaugeline-regen-")));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  other = join(dir, "other");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  commitFile(work, OPTIONS, "one\n", "first");
  git(work, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, other);
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const originLog = () => git(origin, "log", "--format=%an <%ae>|%s", "main").trim().split("\n");
const writes = (text: string, calls: { n: number }) => (root: string) => {
  calls.n += 1;
  writeFileSync(join(root, OPTIONS), text);
  return 0;
};
const go = (generate: (root: string) => number, extra: { attempts?: number } = {}): Outcome =>
  regenerate({ root: work, generate, ...extra });

describe("regenerate on main: unit", () => {
  it("the commit message says [skip ci] and the author is the github-actions bot", () => {
    expect(COMMIT_MESSAGE).toBe("chore: regenerate generated files [skip ci]");
    expect(BOT).toEqual({
      name: "github-actions[bot]",
      email: "41898282+github-actions[bot]@users.noreply.github.com",
    });
  });

  it("recognises its own commit, and only its own", () => {
    expect(isRegenerateCommit(COMMIT_MESSAGE)).toBe(true);
    expect(isRegenerateCommit(`${COMMIT_MESSAGE}\n\nbody`)).toBe(true);
    expect(isRegenerateCommit("feat: a chore: regenerate generated files [skip ci]")).toBe(false);
    expect(isRegenerateCommit("chore: regenerate generated files")).toBe(false);
    expect(isRegenerateCommit("")).toBe(false);
  });
});

describe("regenerate on main: integration (a local bare repository as origin)", () => {
  it("nothing changed: no commit, nothing pushed", () => {
    const calls = { n: 0 };
    const out = go(writes("one\n", calls));
    expect(out).toEqual({ status: "unchanged" });
    expect(originLog()).toHaveLength(1);
  });

  it("a generated file changed: one commit by the bot with the fixed message reaches origin/main", () => {
    const calls = { n: 0 };
    const out = go(writes("two\n", calls));
    expect(out).toMatchObject({ status: "pushed", attempts: 1, files: [OPTIONS] });
    expect(originLog()).toEqual([
      `${BOT.name} <${BOT.email}>|${COMMIT_MESSAGE}`,
      "human <human@example.test>|first",
    ]);
    expect(git(origin, "show", `main:${OPTIONS}`)).toBe("two\n");
  });

  it("running again on the commit it made changes nothing (it cannot loop on its own commit)", () => {
    const calls = { n: 0 };
    go(writes("two\n", calls));
    const again = go(writes("two\n", calls));
    expect(again).toEqual({ status: "unchanged" });
    expect(originLog()).toHaveLength(2);
  });

  it("main moved during the run: it starts again from the new main and still pushes one commit on top", () => {
    const calls = { n: 0 };
    const generate = (root: string): number => {
      calls.n += 1;
      // The first time, another merge lands on main after the checkout this run started from.
      if (calls.n === 1) {
        git(other, "pull", "-q", "origin", "main");
        commitFile(other, "docs/guide.md", "a merged guide\n", "feat: a merge");
        git(other, "push", "-q", "origin", "main");
      }
      writeFileSync(join(root, OPTIONS), "two\n");
      return 0;
    };
    const out = go(generate);
    expect(out).toMatchObject({ status: "pushed", attempts: 2 });
    expect(calls.n).toBe(2);
    const log = originLog();
    expect(log).toHaveLength(3);
    expect(log[0]).toContain(COMMIT_MESSAGE);
    expect(log[1]).toContain("feat: a merge");
    // The merge's own file survived: nothing was overwritten or force-pushed.
    expect(git(origin, "show", "main:docs/guide.md")).toBe("a merged guide\n");
  });

  it("gives up after the attempts it was allowed when main keeps moving, and says so", () => {
    let n = 0;
    const generate = (root: string): number => {
      n += 1;
      git(other, "pull", "-q", "origin", "main");
      commitFile(other, `docs/g${n}.md`, "x\n", `feat: merge ${n}`);
      git(other, "push", "-q", "origin", "main");
      writeFileSync(join(root, OPTIONS), `v${n}\n`);
      return 0;
    };
    const out = go(generate, { attempts: 2 });
    expect(out).toMatchObject({ status: "failed", kind: "moved" });
    expect(n).toBe(2);
  });

  it("generation fails: nothing is committed or pushed, and the reason says generation failed", () => {
    const out = go((root) => {
      writeFileSync(join(root, OPTIONS), "half written\n");
      return 1;
    });
    expect(out).toMatchObject({ status: "failed", kind: "generation" });
    expect(originLog()).toHaveLength(1);
  });

  it("a change outside the generated list is never committed", () => {
    const out = go((root) => {
      writeFileSync(join(root, OPTIONS), "two\n");
      writeFileSync(join(root, "docs/nav.ts"), "// hand written\n");
      return 0;
    });
    expect(out).toMatchObject({ status: "failed", kind: "unexpected" });
    expect(out.status === "failed" && out.reason).toContain("docs/nav.ts");
    expect(originLog()).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "origin refuses the push (a protected branch): fails once with the owner's question, no retry, no force",
    () => {
      const hook = join(origin, "hooks/pre-receive");
      writeFileSync(
        hook,
        '#!/bin/sh\necho "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n',
      );
      chmodSync(hook, 0o755);
      const calls = { n: 0 };
      const out = go(writes("two\n", calls));
      expect(out).toMatchObject({ status: "failed", kind: "rejected" });
      expect(calls.n).toBe(1);
      const reason = out.status === "failed" ? out.reason : "";
      expect(reason).toContain("bypass actor");
      expect(reason).toContain("GH006");
      expect(originLog()).toHaveLength(1);
      expect(readFileSync(join(work, OPTIONS), "utf8")).toBe("two\n");
    },
  );

  it("every path it may commit is on the generated list", () => {
    for (const f of GENERATED_FILES) expect(f).not.toMatch(/\.\./);
    expect(GENERATED_FILES).toContain(OPTIONS);
  });
});
