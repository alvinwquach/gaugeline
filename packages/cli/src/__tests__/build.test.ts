import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pkg from "../../package.json";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";

import { bin, runBin } from "./helpers/bin.js";

let server: FixtureServer;
beforeAll(async () => {
  server = await startServer({ "/": html("<title>Fixture</title>") });
});
afterAll(() => server.close());

describe("built bin: integration", () => {
  it("pnpm build produces dist/index.js with a shebang", () => {
    expect(existsSync(bin), "run `pnpm build` before the tests").toBe(true);
    expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it(`the bin runs under this node (${process.version}) and exits 0`, async () => {
    const r = await runBin([server.origin]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`Gaugeline ${pkg.version} checking ${server.origin}/\n`);
  });

  it("the bin exits 2 with the usage hint on stderr when no address is given", async () => {
    const r = await runBin([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("gaugeline <address> [options]");
  });
});
