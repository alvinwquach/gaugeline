import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { WRITER_DIR, mergeProblems, writerSources } from "../lib/writer-scan.js";

// ADR-0010, owner decision 4: the writer opens a pull request and never merges.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("writer never merges: the scan finds each way of asking", () => {
  const caught = [
    "await octokit.rest.pulls.merge({ owner, repo, pull_number: 1 });",
    'await gh.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge");',
    'fetch(`https://api.github.com/repos/${o}/${r}/merges`, { method: "POST" });',
    'const q = "mutation { enablePullRequestAutoMerge(input: $i) { clientMutationId } }";',
    "const q = `mutation { mergePullRequest(input: $i) { pullRequest { id } } }`;",
    'execFile("gh", ["pr", "merge", "--auto"]);',
    'execFile("git", ["merge", "main"]);',
    'const body = { auto_merge: true, merge_method: "squash" };',
    'const verb = "mer" + "ge";',
    'const verb = "\\u006derge";',
    "// merging is left to the reviewer",
  ];
  for (const line of caught)
    it(`refuses: ${line}`, () => {
      expect(mergeProblems("x.ts", line).length).toBeGreaterThan(0);
    });

  it("allows what the writer is for: a branch, a commit and a draft pull request", () => {
    const ok = [
      'await octokit.rest.git.createRef({ owner, repo, ref: "refs/heads/gaugeline/p-1", sha });',
      "await octokit.rest.git.createCommit({ owner, repo, message, tree, parents });",
      "await octokit.rest.pulls.create({ owner, repo, head, base, title, body, draft: true });",
      "const emerald = 1; // a word that only contains the letters is fine",
    ].join("\n");
    expect(mergeProblems("ok.ts", ok)).toEqual([]);
  });
});

describe("writer never merges: the scan reads the package's files", () => {
  const dir = mkdtempSync(join(tmpdir(), "writer-scan-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it("walks nested folders and tests, and skips node_modules and dist", () => {
    mkdirSync(join(dir, "src", "github", "__tests__"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "src", "github", "open.ts"), "export const open = 1;\n");
    writeFileSync(join(dir, "src", "github", "__tests__", "h.ts"), "pulls.merge();\n");
    writeFileSync(join(dir, "node_modules", "x", "i.js"), "pulls.merge();\n");
    const files = writerSources(dir).map((f) => relative(dir, f).split("\\").join("/"));
    expect(files.sort()).toEqual(["src/github/__tests__/h.ts", "src/github/open.ts"]);
  });

  it("a missing package is no files, not an error", () => {
    expect(writerSources(join(dir, "nope"))).toEqual([]);
  });
});

describe("writer never merges: the repository", () => {
  it(`no file in ${WRITER_DIR} can ask for a merge`, () => {
    const files = writerSources(join(repoRoot, WRITER_DIR));
    // A missing or empty package would pass every line below: the writer exists, so the scan reads it.
    expect(files.filter((f) => /[\\/]src[\\/].+\.ts$/.test(f)).length).toBeGreaterThanOrEqual(5);
    const problems = files.flatMap((f) =>
      mergeProblems(relative(repoRoot, f), readFileSync(f, "utf8")),
    );
    expect(problems).toEqual([]);
  });
});
