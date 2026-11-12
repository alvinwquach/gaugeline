import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = (name: string) => fileURLToPath(new URL(`../../dist/${name}`, import.meta.url));
const root = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));

/** Every file a built entry loads, by following its relative imports. */
function closure(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const text = readFileSync(dist(entry), "utf8");
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([^"']+)["']/g))
    closure(m[1] ?? "", seen);
  return [...seen];
}

describe("the built package", () => {
  it("the browser-safe entry and everything it loads import no node: module", () => {
    expect(
      existsSync(dist("index.js")),
      "run pnpm build first: the built entry is under test",
    ).toBe(true);
    for (const file of closure("index.js")) {
      const text = readFileSync(dist(file), "utf8");
      expect(text, file).not.toMatch(/["']node:/);
      expect(text, file).not.toMatch(/\brequire\(/);
    }
  });

  it("the Function entry has the require shim its bundled engine needs", () => {
    expect(readFileSync(dist("function.js"), "utf8")).toMatch(/createRequire/);
  });

  it("carries a licence notice for every package the Function bundle inlines", () => {
    const notice = readFileSync(root("THIRD_PARTY_LICENSES.md"), "utf8");
    for (const name of [
      "boolbase",
      "cheerio",
      "cheerio-select",
      "css-select",
      "css-what",
      "dom-serializer",
      "domelementtype",
      "domhandler",
      "domutils",
      "entities",
      "htmlparser2",
      "jsqr",
      "nth-check",
      "yaml",
      "zod",
    ])
      expect(notice, name).toMatch(new RegExp(`^## ${name} \\d`, "m"));
  });

  it("ships the notice for the Apache-2.0 code the bundled engine includes", () => {
    const pkg = JSON.parse(readFileSync(root("package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("THIRD_PARTY_LICENSES.md");
    expect(readFileSync(root("THIRD_PARTY_LICENSES.md"), "utf8")).toMatch(
      /## jsqr 1\.4\.0[\s\S]*Apache License/,
    );
  });
});
