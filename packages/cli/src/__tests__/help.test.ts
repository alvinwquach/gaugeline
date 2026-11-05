import { describe, expect, it } from "vitest";
import { expectedOutput } from "@gaugeline/fixtures";
import { COMMANDS, HELP } from "../help.js";
import { runBin } from "./helpers/bin.js";

describe("help: integration", () => {
  it("HELP has an entry for every command the CLI registers", () => {
    for (const c of COMMANDS) expect(HELP[c], `no help for command "${c}"`).toBeTruthy();
    expect(Object.keys(HELP).sort()).toEqual([...COMMANDS].sort());
  });

  it("no help string is longer than 80 columns on any line", () => {
    for (const [c, text] of Object.entries(HELP)) {
      for (const line of text.split("\n"))
        expect(line.length, `${c}: ${line}`).toBeLessThanOrEqual(80);
    }
  });
});

describe("help: e2e (the docs page is the expected output)", () => {
  it('gaugeline --help prints exactly expectedOutput("options", "Usage") and exits 0', async () => {
    const r = await runBin(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "Usage"));
  });

  it("gaugeline --help writes nothing to stderr", async () => {
    expect((await runBin(["--help"])).stderr).toBe("");
  });
});
