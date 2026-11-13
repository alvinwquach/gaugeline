import { describe, expect, it } from "vitest";
import { applyDiff, unifiedDiff } from "../diff.js";

describe("unifiedDiff: unit", () => {
  it("one inserted line, with three lines of context", () => {
    const before = "a\nb\nc\nd\ne\nf\n";
    const after = "a\nb\nc\nNEW\nd\ne\nf\n";
    expect(unifiedDiff("x/y.txt", before, after)).toBe(
      "--- a/x/y.txt\n+++ b/x/y.txt\n@@ -1,6 +1,7 @@\n a\n b\n c\n+NEW\n d\n e\n f\n",
    );
  });
  it("one changed line in a long file keeps only the context around it", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}\n`);
    const after = lines.map((l, i) => (i === 9 ? "changed\n" : l)).join("");
    expect(unifiedDiff("f", lines.join(""), after)).toBe(
      "--- a/f\n+++ b/f\n@@ -7,7 +7,7 @@\n l7\n l8\n l9\n-l10\n+changed\n l11\n l12\n l13\n",
    );
  });
  it("identical text gives an empty diff", () => {
    expect(unifiedDiff("f", "a\n", "a\n")).toBe("");
  });
  it("a file with no final newline says so, and CRLF lines keep their carriage return", () => {
    expect(unifiedDiff("f", "a\nb", "a\nb\nc")).toBe(
      "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n",
    );
    expect(unifiedDiff("f", "a\r\nb\r\n", "a\r\nb\r\nc\r\n")).toContain("+c\r\n");
  });
  it("is the same every time", () => {
    const a = unifiedDiff("f", "1\n2\n", "1\n2\n3\n");
    expect(unifiedDiff("f", "1\n2\n", "1\n2\n3\n")).toBe(a);
  });
});

describe("applyDiff: unit", () => {
  const cases: [string, string, string][] = [
    ["an insertion", "a\nb\nc\n", "a\nb\nX\nc\n"],
    ["a replacement", "a\nb\nc\n", "a\nB\nc\n"],
    ["an addition at the end of a file with no final newline", "a\nb", "a\nb\nc"],
    ["an insertion into an empty file", "", "x\n"],
    ["CRLF lines", "a\r\nb\r\n", "a\r\nNEW\r\nb\r\n"],
  ];
  for (const [name, before, after] of cases)
    it(`round trip: ${name}`, () => {
      expect(applyDiff(before, unifiedDiff("f", before, after))).toBe(after);
    });
  it("refuses a diff whose context is not in the file", () => {
    const diff = unifiedDiff("f", "a\nb\nc\n", "a\nb\nX\nc\n");
    expect(applyDiff("a\nb\nZ\n", diff)).toBeUndefined();
  });
  it("applied twice, the second time finds nothing to apply", () => {
    const before = "a\nb\nc\nd\ne\n";
    const diff = unifiedDiff("f", before, "a\nb\nX\nc\nd\ne\n");
    const once = applyDiff(before, diff);
    expect(once).toBeDefined();
    expect(applyDiff(once ?? "", diff)).toBeUndefined();
  });
  it("refuses text that is not a diff", () => {
    expect(applyDiff("a\n", "not a diff")).toBeUndefined();
    expect(applyDiff("a\n", "")).toBeUndefined();
  });
});
