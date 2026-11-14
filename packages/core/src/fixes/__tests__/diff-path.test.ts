/**
 * The file name in a diff (PERF-04 review): a path is a header line, so a name with a newline in it would write
 * extra header lines. A path with a control character, a leading "-", a ".." segment, a backslash or a
 * leading "/" is refused where the diff header is built and where a proposal is read, never quoted.
 */
import { describe, expect, it } from "vitest";
import { isSafeDiffPath, unifiedDiff } from "../diff.js";
import { buildProposal, parseProposalFile, proposalFile } from "../proposal.js";

const UNSAFE: Array<[string, string]> = [
  ["a newline that injects header lines", "a\n+++ b/evil.html\nx.html"],
  ["a newline", "a\nb.html"],
  ["a carriage return", "a\rb.html"],
  ["a tab", "a\tb.html"],
  ["a NUL", "a\0b.html"],
  ["another control character", "a\u0007b.html"],
  ["a DEL", "a\u007fb.html"],
  ["a line separator", "a b.html"],
  ["a leading -", "-rf.html"],
  ["a leading - after a folder is fine, but a leading - is not", "--help"],
  ["a .. segment", "a/../b.html"],
  ["a leading ..", "../b.html"],
  ["a . segment", "a/./b.html"],
  ["a backslash", "a\\b.html"],
  ["a leading slash", "/etc/b.html"],
  ["an empty segment", "a//b.html"],
  ["a trailing slash", "a/"],
  ["nothing", ""],
  ["a very long path", "a".repeat(301)],
];

describe("isSafeDiffPath", () => {
  it.each(UNSAFE)("refuses %s", (_n, path) => expect(isSafeDiffPath(path)).toBe(false));
  it.each(["index.html", "src/pages/a b.html", "a/-b.html", "src/ü.html", "a.b/c-d_e.tsx"])(
    "accepts %j",
    (path) => expect(isSafeDiffPath(path)).toBe(true),
  );
});

describe("the diff header", () => {
  it.each(UNSAFE)("is not built for %s", (_n, path) => {
    expect(() => unifiedDiff(path, "a\n", "b\n")).toThrow(/path/i);
  });
  it("is one --- line and one +++ line for a safe path, and nothing else before the hunk", () => {
    const diff = unifiedDiff("src/a.html", "a\n", "b\n");
    expect(diff.split("\n").slice(0, 3)).toEqual([
      "--- a/src/a.html",
      "+++ b/src/a.html",
      "@@ -1,1 +1,1 @@",
    ]);
  });
  it("is not built when the texts are the same, whatever the path (nothing to quote)", () => {
    expect(unifiedDiff("a.html", "a\n", "a\n")).toBe("");
  });
});

describe("a proposal for a file with such a name", () => {
  const input = (path: string) => ({
    fixer: "performance" as const,
    summary: "s",
    finding: { checkId: "perf-lcp-image", url: "https://x.example/", evidence: "e" },
    target: { repository: null, path },
    before: "a\n",
    after: "b\n",
    recheck: { checkId: "perf-lcp-image", how: "h" },
  });
  it.each(UNSAFE.slice(0, 18))("is not built for %s", (_n, path) => {
    expect(() => buildProposal(input(path))).toThrow();
  });
  it("is refused when read back from a file, even with a diff that was valid for another name", () => {
    const good = buildProposal(input("a.html"));
    for (const [, path] of UNSAFE.slice(0, 18)) {
      const file = JSON.parse(JSON.stringify(proposalFile([good])));
      file.proposals[0].target.path = path;
      expect(() => parseProposalFile(file), path).toThrow();
    }
  });
});
