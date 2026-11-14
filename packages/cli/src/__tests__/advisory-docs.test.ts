import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expectedOutput } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { runBin } from "./helpers/bin.js";

/**
 * docs/guides/advisory.md shows `npx gaugeline advisory ...` against the invented fixture sites, and
 * `pnpm docs:examples` runs them. These tests keep the pages beside them honest: the --help text in
 * docs/options.md is what the built bin prints, and every flag the command takes is on the guide.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/advisory.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

describe("docs/options.md: gaugeline advisory --help", () => {
  it("shows exactly what the built bin prints", async () => {
    const r = await runBin(["advisory", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.advisory);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The advisory command"));
  });
});

describe("docs/guides/advisory.md", () => {
  it("every flag the command takes is on the page", () => {
    const own = flagsFor(FLAGS, "advisory")
      .map((f) => f.name)
      .filter((n) => !["quiet", "verbose", "help", "version", "allow-private"].includes(n));
    for (const name of own) expect(page, `--${name}`).toContain(`--${name}`);
  });

  it("has a freelancer example, shows runnable commands, and never calls a site safe", () => {
    expect(page).toMatch(/pop-up bar/);
    expect(page.match(/^\$ npx gaugeline advisory /gm)?.length).toBeGreaterThanOrEqual(4);
    expect(page).toMatch(/never says a site is safe/i);
    expect(page).not.toMatch(/your site is safe|is safe from|are safe/i);
  });
});
