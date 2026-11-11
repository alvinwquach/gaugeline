/**
 * The job on main (.github/workflows/regenerate.yml): regenerate every generated file from the sources on
 * main and commit the difference as the github-actions bot. Plain push, never forced.
 */
import { execFileSync } from "node:child_process";
import { GENERATED_FILES } from "./gen-all.js";

export const COMMIT_MESSAGE = "chore: regenerate generated files [skip ci]";
export const BOT = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;

/** True for the commit this job makes, so a run started by it (a token that can trigger one) does nothing. */
export function isRegenerateCommit(message: string): boolean {
  return message.split("\n")[0] === COMMIT_MESSAGE;
}

export type Outcome =
  | { status: "unchanged" }
  | { status: "pushed"; attempts: number; files: string[] }
  | {
      status: "failed";
      /** generation: a generator failed; unexpected: it wrote a file not on the list; rejected: the push was
       * refused by the branch rules; moved: main kept moving; git: anything else. */
      kind: "generation" | "unexpected" | "rejected" | "moved" | "git";
      reason: string;
    };

export interface RegenerateOptions {
  root: string;
  remote?: string;
  branch?: string;
  /** How many times to start again from a newer main when the push finds it has moved. */
  attempts?: number;
  /** Runs the generators in `root`; returns their exit code. */
  generate: (root: string) => number;
}

export const OWNER_QUESTION =
  "Owner: add the github-actions app as a bypass actor on the main ruleset, or tell Claude to use a personal access token instead.";

const MOVED = /non-fast-forward|fetch first|stale info|cannot lock ref/i;

function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: BOT.name,
        GIT_AUTHOR_EMAIL: BOT.email,
        GIT_COMMITTER_NAME: BOT.name,
        GIT_COMMITTER_EMAIL: BOT.email,
      },
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    return { ok: false, out: `${err.stderr ?? ""}${err.stdout ?? ""}`.trim() || err.message };
  }
}

export function regenerate(opts: RegenerateOptions): Outcome {
  const { root, generate } = opts;
  const remote = opts.remote ?? "origin";
  const branch = opts.branch ?? "main";
  const attempts = opts.attempts ?? 3;
  const fail = (kind: "generation" | "unexpected" | "rejected" | "moved" | "git", reason: string) =>
    ({ status: "failed", kind, reason }) as const;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Always from the newest main: the output depends only on the sources, so starting again is safe.
    const fetched = git(root, ["fetch", "--quiet", remote, branch]);
    if (!fetched.ok) return fail("git", `git fetch failed: ${fetched.out}`);
    const reset = git(root, ["reset", "--hard", "--quiet", `${remote}/${branch}`]);
    if (!reset.ok) return fail("git", `git reset failed: ${reset.out}`);

    if (generate(root) !== 0)
      return fail(
        "generation",
        "A generator failed, so nothing was committed (see the log above).",
      );

    const status = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (!status.ok) return fail("git", `git status failed: ${status.out}`);
    const changed = status.out
      .split("\0")
      .filter(Boolean)
      .map((l) => l.slice(3));
    if (changed.length === 0) return { status: "unchanged" };
    const stray = changed.filter((f) => !GENERATED_FILES.includes(f));
    if (stray.length > 0)
      return fail(
        "unexpected",
        `Generation changed files that are not on the generated list, so nothing was committed: ${stray.join(", ")}.`,
      );

    for (const args of [
      ["add", "--", ...changed],
      ["commit", "--quiet", "-m", COMMIT_MESSAGE],
    ]) {
      const r = git(root, args);
      if (!r.ok) return fail("git", `git ${args[0] ?? ""} failed: ${r.out}`);
    }
    const pushed = git(root, ["push", remote, `HEAD:refs/heads/${branch}`]);
    if (pushed.ok) return { status: "pushed", attempts: attempt, files: changed.sort() };
    if (MOVED.test(pushed.out)) continue;
    return fail(
      "rejected",
      `The push to ${branch} was refused, so the generated files are stale on ${branch} until this is fixed. ${OWNER_QUESTION}\n${pushed.out}`,
    );
  }
  return fail("moved", `${branch} moved on every one of ${attempts} attempts. Run this job again.`);
}
