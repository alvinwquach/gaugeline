import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("static generators: e2e", () => {
  it("the built command finds the search index only with --owner-consent, and sends only GET and HEAD", async () => {
    const site = await startFixture("hugo-like");
    try {
      const env = {
        NODE_OPTIONS: `--require=${MAP_HOSTS}`,
        GAUGELINE_TEST_OFFLINE: "1",
        GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
        NO_COLOR: "1",
      };
      const off = await runBin([site.origin, "--allow-private", "--no-open"], env);
      expect(off.status, off.stderr).toBe(0);
      expect(off.stdout).toMatch(/placeholder or preview address/);
      expect(off.stdout).not.toMatch(/search lists pages that are meant to be hidden/);
      expect(site.hits.has("/index.json")).toBe(false);
      const on = await runBin(
        [site.origin, "--allow-private", "--no-open", "--owner-consent"],
        env,
      );
      expect(on.status, on.stderr).toBe(0);
      expect(on.stdout).toMatch(/\/index\.json lists 1 page the sitemap leaves out/);
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("the guide's Output block is the CLI's output on a future-dated post (version 0.1.0)", async () => {
    const site = await startFixture("hugo-like");
    try {
      const out: string[] = [];
      const io = {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      };
      const code = await main([`${site.origin}/posts/new-year-loaf/`, "--no-open"], io, {
        version: "0.1.0",
        fetcher: { hosts: site.hosts },
      });
      expect(code).toBe(0);
      expect(withoutPassed(out.join("")).trimEnd()).toBe(
        expectedOutput("guides/static-generators", "Example"),
      );
    } finally {
      await site.close();
    }
  });
});
