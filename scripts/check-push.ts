/**
 * Run by .husky/pre-push. Git writes one line per ref being pushed to stdin:
 * "<local ref> <local sha> <remote ref> <remote sha>". A branch whose name is not type/id-short-description
 * (or main) stops the push, and so does any commit that would be new on the remote with an attribution line
 * in its message (exit 1, naming the branch or the commit). Deleting a ref and pushing a tag are not checked.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { branchNameProblem } from "./lib/branch-name.js";
import { attributionProblems } from "./lib/commit-attribution.js";

const ZERO = /^0+$/;
const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" });

let failed = false;
for (const line of readFileSync(0, "utf8").split("\n")) {
  const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
  if (!localSha || ZERO.test(localSha)) continue; // a deleted ref has nothing to check
  if (remoteRef?.startsWith("refs/heads/")) {
    const problem = branchNameProblem(remoteRef.slice("refs/heads/".length));
    if (problem) {
      process.stderr.write(`pre-push: ${problem}\n`);
      failed = true;
      continue;
    }
  }
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
