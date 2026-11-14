import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("next.js: e2e", () => {
  it('the built command on the next-like fixture says "40 framework addresses ignored" in its summary', async () => {
    const site = await startFixture("next-like");
    try {
      const r = await runBin([site.origin, "--allow-private", "--no-open"], {
        NODE_OPTIONS: `--require=${MAP_HOSTS}`,
        GAUGELINE_TEST_OFFLINE: "1",
        GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
        NO_COLOR: "1",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/\b40 framework addresses ignored\.\n/);
      expect([...site.hits.keys()].filter((k) => k.startsWith("/_next/data"))).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("the guide's Output block is the CLI's output on next-like (version 0.1.0)", async () => {
    const site = await startFixture("next-like");
    try {
      const out: string[] = [];
      const io = {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      };
      const code = await main([site.origin, "--no-open"], io, {
        version: "0.1.0",
        fetcher: { hosts: site.hosts },
      });
      expect(code).toBe(0);
      expect(withoutPassed(out.join("")).trimEnd()).toBe(
        expectedOutput("guides/nextjs", "Example"),
      );
    } finally {
      await site.close();
    }
  });
});
