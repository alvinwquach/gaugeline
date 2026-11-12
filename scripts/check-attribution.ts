/**
 * Run by .husky/pre-push. Git writes one line per ref being pushed to stdin:
 * "<local ref> <local sha> <remote ref> <remote sha>". Every commit that would be new on the remote is
 * checked; a message with an attribution line stops the push (exit 1) and names the commit.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { attributionProblems } from "./lib/commit-attribution.js";

const ZERO = /^0+$/;
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" });

let failed = false;
for (const line of readFileSync(0, "utf8").split("\n")) {
  const [, localSha, , remoteSha] = line.trim().split(/\s+/);
  if (!localSha || ZERO.test(localSha)) continue; // a deleted ref has nothing to check
  const range =
    remoteSha && !ZERO.test(remoteSha)
      ? [`${remoteSha}..${localSha}`]
      : [localSha, "--not", "--remotes"];
  let shas: string[];
  try {
    shas = git("rev-list", ...range)
      .split("\n")
      .filter(Boolean);
  } catch {
    // The remote sha is not known here (a force-push over history this clone never fetched): check the new commits only.
    shas = git("rev-list", localSha, "--not", "--remotes").split("\n").filter(Boolean);
  }
  for (const sha of shas) {
    const problems = attributionProblems(git("log", "-1", "--format=%B", sha));
    for (const p of problems) {
      process.stderr.write(
        `pre-push: commit ${sha.slice(0, 9)}: ${p}. Remove it (git commit --amend or rebase -i).\n`,
      );
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
