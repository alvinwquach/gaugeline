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
  ["a NEL (U+0085), which some tools read as a line break", "a\u0085b.html"],
  ["a C1 control (U+009F)", "a\u009fb.html"],
  ["a paragraph separator", "a\u2029b.html"],
  ["a soft hyphen", "a\u00adb.html"],
  ["a zero-width space", "a\u200bb.html"],
  ["a zero-width joiner", "a\u200db.html"],
  ["a left-to-right mark", "a\u200eb.html"],
  ["a right-to-left mark", "a\u200fb.html"],
  ["a right-to-left override (U+202E)", "gnp\u202Etxt.html"],
  ["a left-to-right embedding (U+202A)", "a\u202ab.html"],
  ["a bidi isolate (U+2066)", "a\u2066b.html"],
  ["a pop directional isolate (U+2069)", "a\u2069b.html"],
  ["a byte order mark", "a\ufeffb.html"],
  ["a tag character (U+E0041)", `a${String.fromCodePoint(0xe0041)}b.html`],
  ["the last tag character (U+E007F)", `a${String.fromCodePoint(0xe007f)}b.html`],
  ["a word joiner", "a\u2060b.html"],
  ["an invisible operator (U+2064)", "a\u2064b.html"],
  ["a Mongolian vowel separator", "a\u180eb.html"],
  ["an Arabic letter mark (U+061C)", "a\u061cb.html"],
  ["a Bamum-style shorthand format (U+1BCA0)", `a${String.fromCodePoint(0x1bca0)}b.html`],
  ["a shorthand format (U+1BCA3)", `a${String.fromCodePoint(0x1bca3)}b.html`],
  ["an interlinear annotation anchor (U+FFF9)", "a\ufff9b.html"],
  ["an interlinear annotation terminator (U+FFFB)", "a\ufffbb.html"],
  ["an inhibit symmetric swapping (U+206A)", "a\u206ab.html"],
  ["a nominal digit shapes (U+206F)", "a\u206fb.html"],
  ["an unassigned ignorable (U+2065)", "a\u2065b.html"],
  ["a combining grapheme joiner (U+034F)", "a\u034fb.html"],
  ["a variation selector (U+FE00)", "a\ufe00b.html"],
  ["a variation selector (U+FE0F)", "a\ufe0fb.html"],
  ["a variation selector supplement (U+E0100)", `a${String.fromCodePoint(0xe0100)}.html`],
  ["a variation selector supplement (U+E01EF)", `a${String.fromCodePoint(0xe01ef)}.html`],
  ["a Hangul choseong filler (U+115F)", "a\u115fb.html"],
  ["a Hangul filler (U+3164)", "a\u3164b.html"],
  ["a halfwidth Hangul filler (U+FFA0)", "a\uffa0b.html"],
  ["a Khmer inherent vowel (U+17B4)", "a\u17b4b.html"],
  ["a Khmer inherent vowel (U+17B5)", "a\u17b5b.html"],
  ["a musical begin beam (U+1D173)", `a${String.fromCodePoint(0x1d173)}b.html`],
  ["a musical end phrase (U+1D17A)", `a${String.fromCodePoint(0x1d17a)}b.html`],
  ["a language tag (U+E0001)", `a${String.fromCodePoint(0xe0001)}b.html`],
  ["a lone high surrogate", "a\ud800b.html"],
  ["a lone low surrogate", "a\udc00b.html"],
  ["a high surrogate at the end", "ab\ud83d"],
  ["a reversed surrogate pair", "a\udc00\ud800b.html"],
  ["a Cyrillic a inside a Latin name", "p\u0430ypal.html"],
  ["a Greek omicron inside a Latin name", "g\u03bfogle.html"],
  ["a Cyrillic letter in a Latin folder name", "p\u0430yments/index.html"],
  ["a Cyrillic letter in a Latin name with a dot", "a/p\u0430ypal.v2.html"],
  ["nothing", ""],
  ["a very long path", "a".repeat(301)],
];

describe("isSafeDiffPath", () => {
  it.each(UNSAFE)("refuses %s", (_n, path) => expect(isSafeDiffPath(path)).toBe(false));
  it.each([
    "index.html",
    "src/pages/a b.html",
    "a/-b.html",
    "src/ü.html",
    "a.b/c-d_e.tsx",
    "日本語.html",
    "a\u00a0b.html", // a no-break space is visible as a space, not hidden
    "a\u2010b.html", // a hyphen
    "\u{1F600}.html",
    "файл.html", // one script with a Latin extension
    "привет/world.html", // one script per segment
    "Ελλάδα.html",
    "a-1_b.tsx",
    "ñandú.html", // Latin with diacritics
    "日本語/abc.html",
    "naïve café.html",
  ])("accepts %j", (path) => expect(isSafeDiffPath(path)).toBe(true));
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
  it.each(UNSAFE.slice(0, UNSAFE.length - 1))("is not built for %s", (_n, path) => {
    expect(() => buildProposal(input(path))).toThrow();
  });
  it("is refused when read back from a file, even with a diff that was valid for another name", () => {
    const good = buildProposal(input("a.html"));
    for (const [, path] of UNSAFE.slice(0, UNSAFE.length - 1)) {
      const file = JSON.parse(JSON.stringify(proposalFile([good])));
      file.proposals[0].target.path = path;
      expect(() => parseProposalFile(file), path).toThrow();
    }
  });
});
