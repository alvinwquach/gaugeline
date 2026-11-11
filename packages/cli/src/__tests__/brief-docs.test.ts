import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POINTS } from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { runBin } from "./helpers/bin.js";

/**
 * docs/no-developer.md is the page for `gaugeline brief`; docs/options.md has its --help. The example's
 * own output is compared by `pnpm docs:examples` (it runs the command against the corner-bar fixture),
 * so these tests cover what that runner cannot: the sizes table, the flags and the help text.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/no-developer.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

describe("docs: gaugeline brief", () => {
  it("docs/options.md shows exactly what gaugeline brief --help prints, from the built bin", async () => {
    const r = await runBin(["brief", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.brief);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The brief command"));
  });

  it("the sizes table on the page says what the code says: Small 1, Medium 3, Large 8", () => {
    const rows = [...page.matchAll(/^\| (Small|Medium|Large) +\| (\d+) +\|/gm)].map((m) => [
      m[1],
      Number(m[2]),
    ]);
    expect(rows).toEqual([
      ["Small", POINTS.S],
      ["Medium", POINTS.M],
      ["Large", POINTS.L],
    ]);
  });

  it("the page names every flag the command takes, and --help lists every one of them", () => {
    const own = flagsFor(FLAGS, "brief").filter((f) =>
      ["business", "rate", "hours-per-point", "out", "force"].includes(f.name),
    );
    expect(own.map((f) => f.name).sort()).toEqual([
      "business",
      "force",
      "hours-per-point",
      "out",
      "rate",
    ]);
    for (const f of own) {
      expect(page, `--${f.name} on the page`).toContain(`--${f.name}`);
      expect(HELP.brief, `--${f.name} in --help`).toContain(`--${f.name}`);
    }
  });

  it("the sentence the page quotes is the one in its example output", () => {
    const sentence =
      "At 1.5 hours per point, that's roughly 10\u201316 hours (about $1,056\u2013$1,716 at $110/hour).";
    expect(page.split(sentence).length - 1).toBe(2);
  });

  it("the page has an example from client work: a bar for the output and a clinic for the quote", () => {
    expect(page).toContain("The Corner Bar");
    expect(page).toContain("Lakeside Physio");
  });
});
