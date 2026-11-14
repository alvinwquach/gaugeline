import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../fixtures/source/", import.meta.url));
const page = readFileSync(join(root, "docs/guides/source-checks.md"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const options = readFileSync(join(root, "docs/options.md"), "utf8");

describe("docs/options.md: gaugeline source --help", () => {
  it("shows exactly what the built bin prints, and every flag of the command is in --help and in the table", async () => {
    const r = await runBin(["source", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.source);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The source command"));
    for (const f of flagsFor(FLAGS, "source")) {
      expect(HELP.source, `--${f.name} in --help`).toContain(`--${f.name}`);
      expect(options, `--${f.name} in docs/options.md`).toContain(`\`--${f.name}`);
    }
  });
});

/** Each example on the page: the command it shows (after "$ npx gaugeline"), and its Output block. */
const examples = [
  ...page.matchAll(
    /```text title="Terminal"[^\n]*\n\$ npx gaugeline ([^\n]+)\n```\n\n```text title=Output\n([\s\S]*?)\n```/g,
  ),
].map((m) => ({ args: (m[1] ?? "").split(" "), expected: m[2] ?? "" }));

describe("docs/guides/source-checks.md: the examples are real output", () => {
  it("shows two examples, each with the --only it ran with", () => {
    expect(examples).toHaveLength(2);
    for (const e of examples) expect(e.args).toContain("--only");
  });

  it.each([0, 1])(
    "example %i: the command on the page prints exactly the Output block",
    async (n) => {
      const out: string[] = [];
      const code = await main(
        examples[n]?.args ?? [],
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: () => true },
          env: { NO_COLOR: "1" },
        },
        { cwd: FIXTURES, now: () => new Date("2026-11-13T12:00:00Z") },
      );
      expect(code).toBe(0);
      expect(out.join("").trimEnd()).toBe(examples[n]?.expected);
    },
  );

  it("promises what the command promises", () => {
    expect(page).toContain("It only reads.");
    expect(page).toMatch(/never opened/);
    expect(page).toMatch(/no check passes/);
  });
});
