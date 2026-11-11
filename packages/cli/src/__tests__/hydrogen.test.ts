import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

describe("hydrogen: e2e", () => {
  it("the built command on hydrogen-like finds the price, canonical and state findings and sends only GET and HEAD", async () => {
    const site = await startFixture("hydrogen-like");
    try {
      const r = await runBin([site.origin, "--allow-private", "--no-open"], {
        GAUGELINE_TEST_OFFLINE: "1",
        NO_COLOR: "1",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/the page shows 38\.00 but the product data 36\.00 USD/);
      expect(r.stdout).toMatch(
        /__reactRouterContext has privateStorefrontToken \(field names only\)/,
      );
      expect(r.stdout).not.toMatch(/invented-public-token|invented-fixture-value/);
      expect(r.stdout).toMatch(/needs a cart, which Gaugeline will not create/);
      expect([...site.methods.keys()].filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
    } finally {
      await site.close();
    }
  });
});
