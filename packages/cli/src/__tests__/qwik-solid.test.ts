import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("qwik and solidstart: e2e", () => {
  it("the built command on the qwik-like fixture finds the preview cookie only with --owner-consent", async () => {
    const site = await startFixture("qwik-like");
    try {
      const env = {
        NODE_OPTIONS: `--require=${MAP_HOSTS}`,
        GAUGELINE_TEST_OFFLINE: "1",
        GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
        NO_COLOR: "1",
      };
      const off = await runBin([site.origin, "--allow-private", "--no-open"], env);
      expect(off.status, off.stderr).toBe(0);
      expect(off.stdout).not.toMatch(/Anyone can switch on preview mode/);
      expect(site.hits.has("/api/preview")).toBe(false);
      const on = await runBin(
        [site.origin, "--allow-private", "--no-open", "--owner-consent"],
        env,
      );
      expect(on.status, on.stderr).toBe(0);
      expect(on.stdout).toMatch(/\/api\/preview set preview_session with no secret/);
      // Only GET and HEAD ever left the machine, and no server address was called.
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
      expect(
        [...site.hits.keys()].filter((k) => k.includes("qaction") || k.includes("qfunc")),
      ).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("the guide's Output block is the CLI's output on qwik-like (version 0.1.0)", async () => {
    const site = await startFixture("qwik-like");
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
        expectedOutput("guides/qwik-solidstart", "Example"),
      );
    } finally {
      await site.close();
    }
  });
});
