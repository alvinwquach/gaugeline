import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * pnpm new:adapter scaffolds with text still to be written, marked "TODO(new:adapter". The scaffold passes
 * the contract suite with the markers in place (so it can be built on step by step), but none may be
 * merged: they would reach the docs page, the changelog and the run header. This is the adapters'
 * version of the guard pnpm gen:checks has for a check's text.
 */
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
// Built from pieces so this file does not hold the marker itself.
const MARK = ["TODO", "(new:adapter"].join("");

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full, keep);
    return keep(name) ? [full] : [];
  });
}

describe("the adapters, their docs and their changesets", () => {
  it("hold no text still to be written by pnpm new:adapter", () => {
    const files = [
      ...walk(join(root, "packages/core/src/adapters"), (n) => n.endsWith(".ts")),
      ...walk(join(root, "docs/integrations"), (n) => n.endsWith(".md")),
      ...walk(join(root, ".changeset"), (n) => n.endsWith(".md")),
    ].filter((f) => !f.endsWith("no-todo.test.ts"));
    const unfinished = files
      .filter((f) => readFileSync(f, "utf8").includes(MARK))
      .map((f) => relative(root, f).split("\\").join("/"));
    expect(unfinished, `Write the real text before merging: ${unfinished.join(", ")}`).toEqual([]);
  });
});
