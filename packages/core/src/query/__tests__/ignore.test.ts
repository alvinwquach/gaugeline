import { describe, expect, it } from "vitest";
import { isIgnored, parseIgnore } from "../ignore.js";

const ignored = (text: string, path: string, isDir = false, base = "") =>
  isIgnored([parseIgnore(text, base)], path, isDir);

describe(".gitignore reader: unit", () => {
  it("a name with no slash matches at any depth, files and folders", () => {
    expect(ignored("out", "out", true)).toBe(true);
    expect(ignored("out", "a/b/out")).toBe(true);
    expect(ignored("out", "a/outer")).toBe(false);
  });

  it("a trailing slash matches folders only", () => {
    expect(ignored("logs/", "logs", true)).toBe(true);
    expect(ignored("logs/", "logs")).toBe(false);
    expect(ignored("logs/", "src/logs", true)).toBe(true);
  });

  it("a slash at the start or in the middle ties the pattern to its folder", () => {
    expect(ignored("/a.ts", "a.ts")).toBe(true);
    expect(ignored("/a.ts", "src/a.ts")).toBe(false);
    expect(ignored("src/a.ts", "src/a.ts")).toBe(true);
    expect(ignored("src/a.ts", "x/src/a.ts")).toBe(false);
  });

  it("* and ? stay inside one folder, ** crosses folders", () => {
    expect(ignored("*.gen.ts", "x/y.gen.ts")).toBe(true);
    expect(ignored("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(ignored("src/**/b.ts", "src/a/c/b.ts")).toBe(true);
    expect(ignored("src/**/b.ts", "src/b.ts")).toBe(true);
    expect(ignored("a/**", "a/b/c.ts")).toBe(true);
    expect(ignored("file?.ts", "file1.ts")).toBe(true);
    expect(ignored("file?.ts", "file12.ts")).toBe(false);
  });

  it("[...] is a character class, and [!...] is its opposite", () => {
    expect(ignored("a[0-9].ts", "a5.ts")).toBe(true);
    expect(ignored("a[0-9].ts", "ab.ts")).toBe(false);
    expect(ignored("a[!0-9].ts", "ab.ts")).toBe(true);
  });

  it("the last matching rule wins, and ! takes a path back", () => {
    expect(ignored("*.ts\n!keep.ts", "keep.ts")).toBe(false);
    expect(ignored("!keep.ts\n*.ts", "keep.ts")).toBe(true);
  });

  it("comments, blank lines, trailing spaces, CRLF and an escaped # are handled", () => {
    expect(ignored("# nothing\r\n\r\nout  \r\n", "out")).toBe(true);
    expect(ignored("\\#file", "#file")).toBe(true);
    expect(ignored("# out", "out")).toBe(false);
  });

  it("a .gitignore in a folder applies below that folder only", () => {
    expect(ignored("local.ts", "src/local.ts", false, "src")).toBe(true);
    expect(ignored("local.ts", "other/local.ts", false, "src")).toBe(false);
    expect(ignored("/local.ts", "src/deep/local.ts", false, "src")).toBe(false);
  });
});
