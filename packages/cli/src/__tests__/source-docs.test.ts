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

describe("docs/guides/source-checks.md: the example is real output", () => {
  it("the bar's pre-launch copy", async () => {
    expect(page).toContain("$ npx gaugeline source ./harbour-bar-preview");
    const out: string[] = [];
    const code = await main(
      ["source", "./harbour-bar-preview"],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      },
      { cwd: FIXTURES, now: () => new Date("2026-11-13T12:00:00Z") },
    );
    expect(code).toBe(0);
    expect(out.join("").trimEnd()).toBe(
      expectedOutput(
        "guides/source-checks",
        "An example: a bar's site that is not meant to be found yet",
      ),
    );
  });

  it("the bar's indexing switch and its CI", async () => {
    expect(page).toContain("$ npx gaugeline source ./harbour-bar-switch");
    const out: string[] = [];
    const code = await main(
      ["source", "./harbour-bar-switch"],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      },
      { cwd: FIXTURES, now: () => new Date("2026-11-13T12:00:00Z") },
    );
    expect(code).toBe(0);
    expect(out.join("").trimEnd()).toBe(
      expectedOutput("guides/source-checks", "Another example: a switch that accepts too much"),
    );
  });

  it("promises what the command promises", () => {
    expect(page).toContain("It only reads.");
    expect(page).toMatch(/never opened/);
    expect(page).toMatch(/no check passes/);
  });
});
