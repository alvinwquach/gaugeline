import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

describe("remix: e2e", () => {
  it("the built command on the remix-like fixture finds the preview cookie only with --owner-consent", async () => {
    const site = await startFixture("remix-like");
    try {
      const env = { GAUGELINE_TEST_OFFLINE: "1", NO_COLOR: "1" };
      const off = await runBin([site.origin, "--allow-private", "--no-open"], env);
      expect(off.status, off.stderr).toBe(0);
      expect(off.stdout).not.toMatch(/Anyone can switch on Remix preview mode/);
      expect(off.stdout).toMatch(/__reactRouterContext has wholesaleToken \(field names only\)/);
      expect(site.hits.has("/preview")).toBe(false);
      const on = await runBin(
        [site.origin, "--allow-private", "--no-open", "--owner-consent"],
        env,
      );
      expect(on.status, on.stderr).toBe(0);
      expect(on.stdout).toMatch(/\/preview set preview_session with no secret/);
      // Only GET and HEAD ever left the machine, and no data address was asked for.
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
      expect(
        [...site.hits.keys()].filter((k) => k.endsWith(".data") && k !== "/shop.data"),
      ).toEqual([]);
    } finally {
      await site.close();
    }
  });
});
