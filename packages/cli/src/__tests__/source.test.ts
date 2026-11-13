import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { main } from "../main.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/source/", import.meta.url));
const NOW = () => new Date("2026-11-13T12:00:00Z");

async function run(argv: string[], cwd = FIXTURES) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd, now: NOW },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline source: the command line", () => {
  it("takes exactly one folder", () => {
    expect(parseCliArgs(["source", "./a"])).toMatchObject({
      kind: "source",
      folder: "./a",
      json: false,
    });
    expect(parseCliArgs(["source", "./a", "--json", "--ci"])).toMatchObject({
      json: true,
      ci: true,
    });
    expect(parseCliArgs(["source"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["source", "./a", "./b"])).toMatchObject({ kind: "error" });
  });
});

describe("gaugeline source: reading a folder", () => {
  it("prints the findings of a failing folder, with the file and line, and exits 0", async () => {
    const r = await run(["source", "./page-robots-overrides-layout/fail"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "Read 3 files in ./page-robots-overrides-layout/fail. No request was made and no code was run.",
    );
    expect(r.out).toContain("app/menu/page.tsx:3 sets robots and says index: true");
  });

  it("ticks every check on a passing folder", async () => {
    const r = await run(["source", "./page-robots-overrides-layout/pass/"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("in ./page-robots-overrides-layout/pass.");
    expect(r.out).toContain("✓ page-robots-overrides-layout");
    expect(r.out).not.toContain("✗");
  });

  it("--ci exits 1 on a fix-first finding and 0 when there is none", async () => {
    expect((await run(["source", "./sitemap-while-indexing-off/fail", "--ci"])).code).toBe(1);
    expect((await run(["source", "./sitemap-while-indexing-off/pass", "--ci"])).code).toBe(0);
  });

  it("--json prints the result, with the source file and line, and nothing else", async () => {
    const r = await run(["source", "./robots-disallow-hides-noindex/fail", "--json"]);
    const result = JSON.parse(r.out) as {
      url: string;
      findings: { checkId: string; source: unknown }[];
    };
    expect(result.url).toBe("source:./robots-disallow-hides-noindex/fail");
    expect(result.findings).toMatchObject([
      { checkId: "robots-disallow-hides-noindex", source: { file: "public/robots.txt", line: 2 } },
    ]);
  });

  it("is exit 2 with a sentence when the folder does not exist or is a file", async () => {
    const a = await run(["source", "./nope"]);
    expect(a.code).toBe(2);
    expect(a.err).toContain("The folder ./nope does not exist.");
    const b = await run(["source", "./README.md"]);
    expect(b.code).toBe(2);
    expect(b.err).toContain("is a file, not a folder");
    expect((await run(["source"])).code).toBe(2);
  });
});

describe("gaugeline source: what it never does", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-source-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const put = (rel: string, text: string) => {
    const full = join(dir, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  it("never opens an .env file, lists it by name, and prints nothing from it", async () => {
    const secret = "token-that-must-not-be-printed";
    put("app/layout.tsx", "export const metadata = { robots: { index: false } };");
    put(".env.local", `NEXT_PUBLIC_KEY=${secret}\n`);
    const r = await run(["source", dir]);
    expect(r.out).toContain("Not opened, because they look like they hold secrets: .env.local.");
    expect(r.out + r.err).not.toContain(secret);
    const j = await run(["source", dir, "--json"]);
    expect(j.out).not.toContain(secret);
  });

  it("says no check passes when the folder was only partly read", async () => {
    // 2001 tiny files is over the file limit.
    for (let i = 0; i < 2001; i++) put(`src/f${String(i).padStart(4, "0")}.ts`, "x");
    put("app/layout.tsx", "export const metadata = {};");
    const r = await run(["source", dir]);
    expect(r.out).toContain("The folder holds more than Gaugeline reads, so no check passes");
    expect(r.out).not.toContain("✓");
  }, 30_000);
});
