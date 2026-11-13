import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";
import { preview } from "./helpers/redirect-preview.js";

const FIX = fileURLToPath(new URL("../../../fixtures/fix-proposals/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const page = readFileSync(join(root, "docs/guides/fix-proposals.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const options = readFileSync(join(root, "docs/options.md"), "utf8");

/** The Output blocks of the guide, in order. */
const outputs = [...page.matchAll(/```text title="Output"\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

describe("docs/options.md: gaugeline propose --help", () => {
  it("shows exactly what the built bin prints, and every flag of the command is in --help and in the table", async () => {
    const r = await runBin(["propose", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.propose);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The propose command"));
    for (const f of flagsFor(FLAGS, "propose")) {
      expect(HELP.propose, `--${f.name} in --help`).toContain(`--${f.name}`);
      expect(options, `--${f.name} in docs/options.md`).toContain(`\`--${f.name}`);
    }
    for (const name of ["fixes", "repo", "plan", "base", "repository", "out", "allow-private"])
      expect(page, `--${name} in the guide`).toContain(`--${name}`);
  });
});

describe("docs/guides/fix-proposals.md: the examples are real output", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-propose-docs-")));
    cpSync(FIX, dir, { recursive: true });
    cpSync(join(FIX, "cedar-bar-run.json"), join(dir, "run.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  async function run(cwd: string, argv: string[]): Promise<string> {
    const out: string[] = [];
    const code = await main(
      argv,
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      },
      { cwd },
    );
    expect(code).toBe(0);
    return out.join("");
  }

  it("the bookshop's two missing redirects (the page's first command, with the preview's address swapped for a local stand-in)", async () => {
    const cwd = join(dir, "lantern-books");
    const site = await preview(join(cwd, "public/_redirects"));
    try {
      expect(page).toContain(
        "$ npx gaugeline propose --fixes --repo . --plan plan.csv --base https://preview.lanternbooks.example",
      );
      const out = await run(cwd, [
        "propose",
        "--fixes",
        "--repo",
        ".",
        "--plan",
        "plan.csv",
        "--base",
        site.origin,
        "--allow-private",
      ]);
      expect(out).toBe(outputs[0]);
    } finally {
      await site.close();
    }
  });

  it("the bar's phone number (the page's second command)", async () => {
    expect(page).toContain("$ npx gaugeline propose run.json --fixes --repo ./cedar-bar");
    const out = await run(dir, ["propose", "run.json", "--fixes", "--repo", "./cedar-bar"]);
    expect(out).toBe(outputs[1]);
  });
});

describe("docs/guides/fix-proposals.md: what it promises", () => {
  it("says it is off by default, sends nothing, and that apply is not built", () => {
    expect(page).toMatch(/off by default/i);
    expect(page).toContain("Nothing was sent anywhere");
    expect(page).toMatch(/`gaugeline apply`[^.]*not built yet \(v1\.1\)/);
    expect(page).toMatch(/uncited/i);
    expect(page).toContain("ADR-0010");
  });
});
