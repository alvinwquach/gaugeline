import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("host previews: end to end", () => {
  it("the guide's Output block is the CLI's output on host-previews (version 0.1.0), and only GET and HEAD were sent", async () => {
    const site = await startFixture("host-previews");
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
        expectedOutput("guides/host-previews", "Example"),
      );
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("the built command reports the named preview, and a preview it may not reach is could-not-check, not a pass", async () => {
    const site = await startFixture("host-previews");
    try {
      const r = await runBin([site.origin, "--allow-private", "--no-open"], {
        NODE_OPTIONS: `--require=${MAP_HOSTS}`,
        GAUGELINE_TEST_OFFLINE: "1",
        GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
        NO_COLOR: "1",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(
        /✗ The live site names a preview address\n {4}1 place names a preview address \(Netlify pull request preview\): sitemap deploy-preview-12--fernlight-demo-0000\.netlify\.app\/menu\n/,
      );
      // Resolving to a private address, the preview is another host than the one typed: never requested.
      expect(r.stdout).toMatch(
        /\? host-preview-indexable could not be checked: deploy-preview-12--fernlight-demo-0000\.netlify\.app\/menu did not answer \(http:\/\/deploy-preview-12--fernlight-demo-0000\.netlify\.app\/menu\)/,
      );
      expect(r.stdout).not.toContain("utm_source");
    } finally {
      await site.close();
    }
  });
});
