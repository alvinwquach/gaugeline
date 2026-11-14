import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXED, ITEMS, world } from "../../../core/src/migration/__tests__/world.js";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-migration-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const NEW = "preview.wrenbakehouse.example";
const OLD = "wrenbakehouse.example";

async function run(argv: string[], w = world(), cwd = folder()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd, fetcher: { transport: w.transport } },
  );
  return { code, out: out.join(""), err: err.join(""), w };
}

describe("gaugeline migration: arguments", () => {
  const parse = (...a: string[]) => parseCliArgs(["migration", ...a], {});
  it("takes the new site and the old one", () => {
    expect(parse(NEW, "--old", OLD)).toMatchObject({
      kind: "migration",
      address: `https://${NEW}/`,
      old: `https://${OLD}/`,
    });
    expect(parse(NEW, "--old-file", "wix.csv")).toMatchObject({
      kind: "migration",
      oldFile: "wix.csv",
    });
    expect(parse(NEW, "--old", OLD, "--old-file", "w.csv")).toMatchObject({
      old: `https://${OLD}/`,
      oldFile: "w.csv",
    });
  });
  it("is exit 2 with a hint without the new site, without the old site's list, or with a bad address", () => {
    expect(parse("--old", OLD)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("needs the address of the new site"),
    });
    expect(parse(NEW)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--old <address> or --old-file"),
    });
    expect(parse(NEW, "other.example", "--old", OLD)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("takes one address"),
    });
    expect(parse(NEW, "--old", "ftp://x.example")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--old:"),
    });
    expect(parse(NEW, "--old-file", " ")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--old-file needs"),
    });
    expect(parse("ftp://x.example", "--old", OLD)).toMatchObject({ kind: "error" });
  });
  it("is a command of its own: its flags and help are in the tables", () => {
    expect(flagsFor(FLAGS, "migration").map((f) => f.name)).toEqual(
      expect.arrayContaining(["old", "old-file", "ci", "allow-private"]),
    );
    expect(HELP.migration).toContain("gaugeline migration <address>");
  });
});

describe("gaugeline migration: a run", () => {
  it("reports the six problems of the twelve-item bakery, GET only, and exits 0 without --ci", async () => {
    const r = await run(["migration", NEW, "--old", OLD]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(`Checking 12 pages from ${OLD} (the WordPress API) on ${NEW}`);
    expect(r.out).toContain("6 to look at, 2 to fix first.");
    expect(r.err).toContain("Read 8 posts and 4 pages from the old site's WordPress API.");
    expect(new Set(r.w.seen.map((s) => s.method))).toEqual(new Set(["GET"]));
  });

  it("--ci exits 1 for a page that is missing, and 0 when the new site keeps all twelve", async () => {
    expect((await run(["migration", NEW, "--old", OLD, "--ci"])).code).toBe(EXIT.findings);
    const clean = await run(["migration", NEW, "--old", OLD, "--ci"], world({ items: FIXED }));
    expect(clean.code).toBe(EXIT.ok);
    expect(clean.out).toContain("Nothing to look at.");
  });

  it("--quiet leaves the notes off stderr", async () => {
    const r = await run(["migration", NEW, "--old", OLD, "--quiet"]);
    expect(r.err).toBe("");
  });

  it("reads --old-file from the working folder and asks the old site for nothing", async () => {
    const csv = `Title,Path\n${ITEMS.map((i) => `"${i.rendered.replace(/&amp;/g, "&")}",${i.path}`).join("\n")}\n`;
    const cwd = folder({ "wix-pages.csv": csv });
    const r = await run(["migration", NEW, "--old-file", "wix-pages.csv", "--ci"], world(), cwd);
    expect(r.out).toContain(`Checking 12 pages from wix-pages.csv on ${NEW}`);
    expect(r.out).toContain("migration-canonical-changed could not be checked");
    expect(r.w.seen.every((s) => new URL(s.url).host === NEW)).toBe(true);
    expect(r.code).toBe(EXIT.findings);
  });

  it("a missing export is exit 2 and nothing was asked of any site", async () => {
    const r = await run(["migration", NEW, "--old-file", "nope.csv"]);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("nope.csv does not exist");
    expect(r.w.seen).toEqual([]);
  });

  it("an old site with nothing to list is exit 2 with the way out", async () => {
    const r = await run(["migration", NEW, "--old", OLD], world({ wordpress: false, items: [] }));
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toContain("Could not read a list of pages from wrenbakehouse.example");
    expect(r.err).toContain("--old-file");
  });

  it("a page the new site would not give is exit 2, never a quiet 0", async () => {
    const w = world({ routes: { [`https://${NEW}/opening-hours/`]: { status: 503 } } });
    const r = await run(["migration", NEW, "--old", OLD], w);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.out).toContain(
      "could not be checked: the new site did not give the page (answered 503)",
    );
  });
});
