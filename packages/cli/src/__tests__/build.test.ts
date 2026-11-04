import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

const bin = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

describe("built bin: integration", () => {
  it("pnpm build produces dist/index.js with a shebang", () => {
    expect(existsSync(bin), "run `pnpm build` before the tests").toBe(true);
    expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it(`the bin runs under this node (${process.version}) and exits 0`, () => {
    const r = spawnSync(process.execPath, [bin, "example.com"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`Gaugeline ${pkg.version} checking https://example.com/\n`);
  });

  it("the bin exits 2 with usage on stderr when no address is given", () => {
    const r = spawnSync(process.execPath, [bin], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Usage:");
  });
});
