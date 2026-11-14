/**
 * The folder reader behind `gaugeline propose` (PERF-04 review): it only reads. Links are not followed, build and
 * dependency folders are skipped, a file over 1 MB is left out, a name that cannot be written in a diff header is
 * left out, and only the files a fixer can use are returned, in a fixed order.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectFiles } from "../propose.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-readfiles-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const paths = (dir: string) => readProjectFiles(dir).map((f) => f.path);

describe("readProjectFiles", () => {
  it("returns the readable files by path with forward slashes, in a fixed order, with their text", () => {
    const dir = project({
      "b.html": "B",
      "a/z.tsx": "Z",
      "a/y.json": "{}",
      "notes.txt": "n",
      "a/img.png": "x",
    });
    expect(readProjectFiles(dir)).toEqual([
      { path: "a/y.json", text: "{}" },
      { path: "a/z.tsx", text: "Z" },
      { path: "b.html", text: "B" },
    ]);
  });

  it.each([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".vercel",
    ".netlify",
    ".cache",
  ])("skips everything under a folder named %s, at any depth", (name) => {
    const dir = project({
      "a.html": "ok",
      [`${name}/x.html`]: "skip",
      [`src/${name}/deep/y.html`]: "skip",
    });
    expect(paths(dir)).toEqual(["a.html"]);
  });

  it("does not skip a folder that only contains a skipped name, or a file with that name", () => {
    const dir = project({
      "distribution/a.html": "ok",
      "node_modules.html": "ok",
      "my-build/b.html": "ok",
    });
    expect(paths(dir)).toEqual(["distribution/a.html", "my-build/b.html", "node_modules.html"]);
  });

  it("leaves out a file over 1 MB and keeps one of exactly 1 MB", () => {
    const dir = project({
      "big.html": "x".repeat(1_000_001),
      "edge.html": "x".repeat(1_000_000),
      "s.html": "x",
    });
    expect(paths(dir)).toEqual(["edge.html", "s.html"]);
  });

  it("does not follow a symbolic link to a file, to a folder or to something outside the project", () => {
    const outside = project({ "secret.html": "outside", "d/in.html": "outside" });
    const dir = project({ "real.html": "real", "sub/ok.html": "ok" });
    try {
      symlinkSync(join(outside, "secret.html"), join(dir, "link.html"));
      symlinkSync(join(outside, "d"), join(dir, "linked-folder"), "dir");
      symlinkSync(join(dir, "real.html"), join(dir, "sub", "again.html"));
      symlinkSync(dir, join(dir, "sub", "loop"), "dir");
    } catch {
      return; // links cannot be made here (Windows without the right): nothing to test
    }
    expect(paths(dir)).toEqual(["real.html", "sub/ok.html"]);
  });

  it("leaves out a name that could not be written in a diff header", () => {
    const dir = project({ "ok.html": "ok", "a b.html": "ok" });
    try {
      writeFileSync(join(dir, "a\nb.html"), "x");
      writeFileSync(join(dir, "a\tb.html"), "x");
      writeFileSync(join(dir, "-rf.html"), "x");
    } catch {
      return; // a file system that cannot hold these names
    }
    expect(paths(dir)).toEqual(["a b.html", "ok.html"]);
  });

  it("reads at most 5000 files, and stops there", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5_003; i++) files[`f/${String(i).padStart(5, "0")}.html`] = "x";
    expect(readProjectFiles(project(files))).toHaveLength(5_000);
  }, 60_000);

  it("reads nothing from a folder that is not there (the caller turns that into a message)", () => {
    expect(() => readProjectFiles(join(tmpdir(), "gaugeline-no-such-folder-xyz"))).toThrow();
  });
});
