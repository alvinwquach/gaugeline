import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("..", import.meta.url));
const files = readdirSync(src).filter((f) => f.endsWith(".ts"));
const text = files.map((f) => readFileSync(join(src, f), "utf8")).join("\n");

describe("the package cannot write", () => {
  it("has source files to look at", () => {
    expect(files).toEqual(expect.arrayContaining(["resolve.ts", "check.ts", "function.ts"]));
  });

  it("imports no Sanity client and no HTTP module, so it has nothing to write with", () => {
    expect(text).not.toMatch(
      /from "@sanity\/client"|from "sanity"|from "node:https?"|from "node:net"/,
    );
  });

  it("calls no mutation, no patch, and sends no method other than the fetcher's GET and HEAD", () => {
    expect(text).not.toMatch(
      /\.mutate\(|\.patch\(|\.createOrReplace\(|\.createIfNotExists\(|\.transaction\(|\.publish\(/,
    );
    expect(text).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("never reads the Function's context, where its token is", () => {
    expect(text).not.toMatch(/clientOptions|\.context\b|\.token\b/);
  });
});
