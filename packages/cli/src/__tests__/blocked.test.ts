import { fileURLToPath } from "node:url";
import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const ENV = { NODE_OPTIONS: `--require=${MAP_HOSTS}`, GAUGELINE_TEST_OFFLINE: "1", NO_COLOR: "1" };

describe("a refused page: e2e (the built bin)", () => {
  it('exits 0, prints the blocked finding and the "?" rows, and still exits 0 with --ci', async () => {
    const site = await startFixture("refusing");
    try {
      const r = await runBin([site.origin, "--allow-private", "--no-open"], ENV);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("· The site wouldn't let Gaugeline read the page\n");
      expect(r.stdout).toMatch(
        /^\? canonical-missing could not be checked: the page refused automated readers \(403\)$/m,
      );
      expect(r.stdout).not.toMatch(/^✓ canonical-missing$/m);
      expect(
        (await runBin([site.origin, "--allow-private", "--no-open", "--ci"], ENV)).status,
      ).toBe(0);
      // One request for the page per run: never a retry.
      expect(site.hits.get("/")).toBe(2);
    } finally {
      await site.close();
    }
  });

  it("--json carries couldNotCheck with the reason and the address", async () => {
    const site = await startFixture("refusing");
    try {
      const r = await runBin([site.origin, "--allow-private", "--json"], ENV);
      const json = JSON.parse(r.stdout) as {
        schema: number;
        findings: { checkId: string }[];
        couldNotCheck: { id: string; reason: string; url: string }[];
      };
      expect(json.schema).toBe(2);
      expect(json.findings.map((f) => f.checkId)).toEqual(["blocked"]);
      expect(json.couldNotCheck.find((c) => c.id === "canonical-missing")).toEqual({
        id: "canonical-missing",
        reason: "the page refused automated readers (403)",
        url: `${site.origin}/`,
      });
    } finally {
      await site.close();
    }
  });
});
