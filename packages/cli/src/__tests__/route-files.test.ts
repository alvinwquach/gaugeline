import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globToRegExp, listRouteFiles } from "../route-files.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function repo(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-routes-"));
  dirs.push(dir);
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "// invented\n");
  }
  return dir;
}

describe("globToRegExp", () => {
  it("** crosses folders, * does not, ? is one character", () => {
    const re = globToRegExp("app/api/**/route.ts");
    expect(re.test("app/api/download/[id]/route.ts")).toBe(true);
    expect(re.test("app/api/route.ts")).toBe(true);
    expect(re.test("app/page.tsx")).toBe(false);
    expect(globToRegExp("pages/api/*.ts").test("pages/api/a/b.ts")).toBe(false);
    expect(globToRegExp("pages/api/*.ts").test("pages/api/a.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
  });

  it("characters that mean something in a regular expression mean nothing in a glob", () => {
    expect(globToRegExp("app/(shop)/api/**/route.ts").test("app/(shop)/api/x/route.ts")).toBe(true);
    expect(globToRegExp("app/api/a.b").test("app/api/aXb")).toBe(false);
  });
});

describe("listRouteFiles", () => {
  it("lists the files a glob matches, as paths with forward slashes, sorted", () => {
    const dir = repo([
      "app/api/download/[id]/route.ts",
      "app/api/export/route.ts",
      "app/page.tsx",
      "pages/api/files.ts",
      "README.md",
    ]);
    expect(listRouteFiles(["app/api/**/route.ts"], dir)).toEqual([
      "app/api/download/[id]/route.ts",
      "app/api/export/route.ts",
    ]);
    expect(listRouteFiles(["app/api/**/route.ts", "pages/api/**/*.ts"], dir)).toEqual([
      "app/api/download/[id]/route.ts",
      "app/api/export/route.ts",
      "pages/api/files.ts",
    ]);
  });

  it("never looks inside node_modules, .git or .next", () => {
    const dir = repo([
      "app/api/download/route.ts",
      "node_modules/pkg/app/api/download/route.ts",
      ".next/server/app/api/download/route.ts",
      ".git/app/api/download/route.ts",
    ]);
    expect(listRouteFiles(["**/route.ts"], dir)).toEqual(["app/api/download/route.ts"]);
  });

  it("starts from the folder a glob names, so a path outside the working folder works", () => {
    const dir = repo(["site/app/api/export/route.ts", "other/app/api/export/route.ts"]);
    expect(listRouteFiles(["site/app/api/**/route.ts"], dir)).toEqual([
      "site/app/api/export/route.ts",
    ]);
  });

  it("a glob that matches nothing, or a folder that is not there, is an empty list", () => {
    const dir = repo(["app/page.tsx"]);
    expect(listRouteFiles(["app/api/**/route.ts"], dir)).toEqual([]);
    expect(listRouteFiles(["nowhere/**/route.ts"], dir)).toEqual([]);
  });
});
