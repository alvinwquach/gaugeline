import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { runBin } from "./helpers/bin.js";

/**
 * docs/guides/init.md shows `npx gaugeline init ... --dry-run` against the invented fixture site, and
 * `pnpm docs:examples` runs it. These tests keep the pages beside it honest.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/init.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

describe("docs/options.md: gaugeline init --help", () => {
  it("shows exactly what the built bin prints", async () => {
    const r = await runBin(["init", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.init);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The init command"));
  });
});

describe("docs/guides/init.md", () => {
  it("every flag the command takes is on the page", () => {
    const own = flagsFor(FLAGS, "init")
      .map((f) => f.name)
      .filter((n) => !["quiet", "verbose", "help", "version"].includes(n));
    for (const name of own) expect(page, `--${name}`).toContain(`--${name}`);
  });

  it("has a freelancer example with a runnable command and says it never writes a key", () => {
    expect(page).toMatch(/pop-up bar/);
    expect(page).toMatch(/Formspree/);
    expect(page.match(/^\$ npx gaugeline init /gm)?.length).toBeGreaterThanOrEqual(1);
    expect(page).toMatch(/never writes a key/);
  });
});
