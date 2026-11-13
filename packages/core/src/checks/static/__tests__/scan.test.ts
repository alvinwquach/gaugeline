import { describe, expect, it } from "vitest";
import {
  envReads,
  hasDirective,
  importsOf,
  isCmsTokenName,
  isSourcePath,
  lineOf,
  notReadReason,
  resolveImport,
  scrub,
} from "../scan.js";
import { treeOf } from "./tokens-forms-helpers.js";

describe("scrub", () => {
  it("blanks comments, keeps newlines, and keeps the length", () => {
    const src = "a // x\nb /* y\nz */ c";
    const out = scrub(src, false);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(3);
    expect(out).not.toMatch(/[xyz]/);
    expect(out).toContain("a ");
    expect(out).toContain(" c");
  });

  it("does not take // inside a string for a comment", () => {
    expect(scrub('const u = "https://a.example/x"; // gone', false)).toContain(
      "https://a.example/x",
    );
    expect(scrub('const u = "https://a.example/x"; // gone', false)).not.toContain("gone");
  });

  it("blanks string and template text on request, keeps quotes and ${} code", () => {
    const out = scrub("f('secret', `a ${email} b`)", true);
    expect(out).not.toContain("secret");
    expect(out).toMatch(/f\('\s+', `\s+\$\{email\}\s+`\)/);
    expect(scrub("f('secret')", false)).toContain("secret");
  });

  it("copes with an unterminated string and a file ending in a template", () => {
    expect(scrub("const a = 'oops\nconst b = 1;", true)).toContain("const b = 1;");
    expect(() => scrub("const a = `never closed ${", true)).not.toThrow();
  });
});

describe("small helpers", () => {
  it("lineOf is 1-based", () => {
    expect(lineOf("a\nb\nc", 0)).toBe(1);
    expect(lineOf("a\nb\nc", 4)).toBe(3);
  });

  it("hasDirective reads the first statements only", () => {
    expect(hasDirective('"use client";\nimport a from "b";', "use client")).toBe(true);
    expect(hasDirective("// note\n'use server'\nexport async function f() {}", "use server")).toBe(
      true,
    );
    expect(hasDirective('import a from "b";\n"use client";', "use client")).toBe(false);
    expect(hasDirective('"use server";', "use client")).toBe(false);
  });

  it("importsOf finds imports, re-exports and require, and skips import type", () => {
    const code = scrub(
      'import a from "./a";\nimport type { T } from "./types";\nimport "./side";\nexport { b } from "./b";\nconst c = require("./c");\nimport {\n  d,\n} from "@/lib/d";',
      false,
    );
    expect(importsOf(code).map((i) => i.spec)).toEqual(["./a", "./side", "./b", "./c", "@/lib/d"]);
  });

  it("resolveImport follows relative paths, index files, .js to .ts and the @/ shortcut", () => {
    const files = new Map(
      ["lib/a.ts", "lib/b/index.tsx", "src/lib/c.ts", "app/x.ts", "lib/data.json"].map((p) => [
        p,
        "",
      ]),
    );
    expect(resolveImport(files, "app/x.ts", "../lib/a")).toBe("lib/a.ts");
    expect(resolveImport(files, "app/x.ts", "../lib/b")).toBe("lib/b/index.tsx");
    expect(resolveImport(files, "app/x.ts", "../lib/a.js")).toBe("lib/a.ts");
    expect(resolveImport(files, "app/x.ts", "@/lib/c")).toBe("src/lib/c.ts");
    expect(resolveImport(files, "app/x.ts", "~/lib/a")).toBe("lib/a.ts");
    expect(resolveImport(files, "app/x.ts", "next-sanity")).toBeUndefined();
    expect(resolveImport(files, "app/x.ts", "../lib/data.json")).toBeUndefined();
  });

  it("isCmsTokenName wants a content system's name and TOKEN, SECRET or KEY", () => {
    for (const n of [
      "SANITY_API_READ_TOKEN",
      "SANITY_WRITE_TOKEN",
      "NEXT_PUBLIC_SANITY_API_TOKEN",
      "CONTENTFUL_MANAGEMENT_TOKEN",
      "PAYLOAD_SECRET",
      "STORYBLOK_ACCESS_TOKEN",
    ])
      expect(isCmsTokenName(n), n).toBe(true);
    for (const n of [
      "SANITY_PROJECT_ID",
      "SANITY_DATASET",
      "NEXT_PUBLIC_SANITY_PROJECT_ID",
      "STRIPE_SECRET_KEY",
      "NODE_ENV",
      "SANITY_STUDIO_TOKENIZER",
    ])
      expect(isCmsTokenName(n), n).toBe(false);
  });

  it("envReads finds dotted, bracketed, import.meta and destructured reads", () => {
    const code = scrub(
      'const a = process.env.ONE; const b = process.env["TWO"]; const c = import.meta.env.THREE; const { FOUR, FIVE: five } = process.env;',
      false,
    );
    expect(envReads(code).map((r) => r.name)).toEqual(["ONE", "TWO", "THREE", "FOUR", "FIVE"]);
  });

  it("isSourcePath leaves out tests, stories and type files", () => {
    expect(isSourcePath("app/page.tsx")).toBe(true);
    expect(isSourcePath("lib/x.mjs")).toBe(true);
    for (const p of [
      "app/page.test.ts",
      "lib/__tests__/x.ts",
      "e2e/a.spec.ts",
      "a.stories.tsx",
      "types.d.ts",
      "README.md",
    ])
      expect(isSourcePath(p), p).toBe(false);
  });

  it("notReadReason: no source, or a source file left out, is a reason; a clean read is not", () => {
    expect(notReadReason(treeOf({}))).toMatch(/no source file/);
    expect(notReadReason(treeOf({ "a.ts": "x" }))).toBeUndefined();
    expect(
      notReadReason(treeOf({ "a.ts": "x" }, { skipped: new Map([["b.ts", "too-large"]]) })),
    ).toMatch(/1 source file could not be read/);
    expect(
      notReadReason(
        treeOf(
          { "a.ts": "x" },
          {
            skipped: new Map([
              [".env", "secret-looking"],
              ["logo.png", "binary"],
            ]),
          },
        ),
      ),
    ).toBeUndefined();
  });
});
