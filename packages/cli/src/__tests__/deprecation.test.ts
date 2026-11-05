import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDeprecations } from "@gaugeline/core";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import { FLAGS, type FlagDef } from "../flags.js";
import { main } from "../main.js";

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({ "/": html("<title>t</title>") });
});
afterAll(() => site.close());
afterEach(() => resetDeprecations());

/** The real flag table plus one deprecated flag, as a later version would have. */
const FLAGS_WITH_OLD: FlagDef[] = [
  ...FLAGS,
  {
    name: "old-json",
    type: "boolean",
    description: "Old name for --json",
    since: "0.0.1",
    commands: ["check"],
    deprecated: { since: "0.0.2", removeIn: "0.2.0", use: "--json" },
  },
];
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("deprecation: e2e (CLI run)", () => {
  it("a run that uses a deprecated flag: exit code unchanged, one warning line on stderr, --json stdout still parses", async () => {
    const c = capture();
    const code = await main([`${site.origin}/`, "--json", "--old-json", "--allow-private"], c.io, {
      flags: FLAGS_WITH_OLD,
      version: "0.1.0",
    });
    const plain = capture();
    const baseline = await main([`${site.origin}/`, "--json", "--allow-private"], plain.io, {
      version: "0.1.0",
    });
    expect(code).toBe(baseline);
    expect(
      c
        .err()
        .split("\n")
        .filter((l) => l.startsWith("Deprecated:")),
    ).toEqual(["Deprecated: --old-json will be removed in 0.2.0. Use --json instead."]);
    expect(() => JSON.parse(c.out()) as unknown).not.toThrow();
    expect(c.out()).not.toContain("Deprecated");
  });
});

describe("deprecation: edge cases", () => {
  it("the same deprecated flag given twice on one command line: one warning", async () => {
    const c = capture();
    await main(
      [`${site.origin}/`, "--old-json", "--old-json", "--quiet", "--allow-private"],
      c.io,
      { flags: FLAGS_WITH_OLD },
    );
    expect(c.err().match(/Deprecated:/g)).toHaveLength(1);
  });

  it("a deprecated environment variable that is set but empty: no warning; set to a value: one", async () => {
    const deprecated = new Map([["env:GAUGELINE_OLD_VAR", { since: "0.0.2", removeIn: "0.2.0" }]]);
    const empty = capture();
    await main(
      [`${site.origin}/`, "--quiet", "--allow-private"],
      { ...empty.io, env: { GAUGELINE_OLD_VAR: "" } },
      { deprecated },
    );
    expect(empty.err()).not.toContain("Deprecated");
    resetDeprecations();
    const set = capture();
    await main(
      [`${site.origin}/`, "--quiet", "--allow-private"],
      { ...set.io, env: { GAUGELINE_OLD_VAR: "1" } },
      { deprecated },
    );
    expect(set.err()).toContain("Deprecated: env:GAUGELINE_OLD_VAR will be removed in 0.2.0.");
  });
});
