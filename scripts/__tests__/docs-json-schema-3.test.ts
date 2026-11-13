import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalise, runExample } from "../lib/docs-examples.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const bin = join(repoRoot, "packages/cli/dist/index.js");
const page = readFileSync(join(repoRoot, "docs/config.md"), "utf8").replace(/\r\n/g, "\n");

/** The command of the schema 3 example and the JSON block under it, as the page prints them. */
function schema3Example(): { command: string; expected: Record<string, unknown> } {
  const m =
    /```sh title=Terminal untested="[^"]*"\n\$ (npx gaugeline [^\n]*--json-schema 3[^\n]*)\n```[\s\S]*?```json title=Output\n([\s\S]*?)\n```/.exec(
      page,
    );
  if (!m?.[1] || !m[2]) throw new Error("docs/config.md has no schema 3 example.");
  return { command: m[1], expected: JSON.parse(m[2]) as Record<string, unknown> };
}

describe("docs/config.md: the schema 3 example", () => {
  it("prints what the page says, with passed and sampled left out", async () => {
    const { command, expected } = schema3Example();
    const r = await runExample(
      {
        file: "docs/config.md",
        line: 1,
        outputLine: null,
        command,
        fixture: "fernhill-config",
        expected: null,
        exit: 0,
      },
      bin,
    );
    expect(r.code, r.stderr).toBe(0);
    const actual = JSON.parse(normalise(r.stdout, r.origin, r.address)) as Record<string, unknown>;
    // The ids of every passed check and the sample sizes grow with the product, and say nothing here.
    expect(Array.isArray(actual.passed)).toBe(true);
    delete actual.passed;
    delete actual.sampled;
    expect(actual).toEqual(expected);
  }, 60_000);
});
