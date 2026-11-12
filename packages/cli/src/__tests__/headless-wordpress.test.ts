import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("headless wordpress: e2e", () => {
  it("the built command on the headless-wp fixture asks /graphql and the preview address only with --owner-consent", async () => {
    const site = await startFixture("headless-wp");
    try {
      const env = {
        NODE_OPTIONS: `--require=${MAP_HOSTS}`,
        GAUGELINE_TEST_OFFLINE: "1",
        GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
        NO_COLOR: "1",
      };
      const off = await runBin([site.origin, "--allow-private", "--no-open"], env);
      expect(off.status, off.stderr).toBe(0);
      expect(off.stdout).not.toMatch(/GraphQL API|preview link shows/);
      expect(off.stdout).toMatch(/has User\.email, User\.roles, apiToken/);
      expect(site.hits.has("/graphql")).toBe(false);
      const on = await runBin(
        [site.origin, "--allow-private", "--no-open", "--owner-consent"],
        env,
      );
      expect(on.status, on.stderr).toBe(0);
      expect(on.stdout).toMatch(/answers an introspection query with its schema/);
      expect(on.stdout).toMatch(/answered 200 with no login and status draft/);
      // Only GET and HEAD ever left the machine.
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("the guide's Output block is the CLI's output on headless-wp (version 0.1.0)", async () => {
    const site = await startFixture("headless-wp");
    try {
      const out: string[] = [];
      const io = {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      };
      const code = await main([site.origin, "--no-open", "--owner-consent"], io, {
        version: "0.1.0",
        fetcher: { hosts: site.hosts },
      });
      expect(code).toBe(0);
      expect(withoutPassed(out.join("")).trimEnd()).toBe(
        expectedOutput("guides/headless-wordpress", "Example"),
      );
    } finally {
      await site.close();
    }
  });
});
