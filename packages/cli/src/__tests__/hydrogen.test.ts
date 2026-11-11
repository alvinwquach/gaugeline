import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const withoutPassed = (text: string) => text.replace(/^\u2713 [a-z0-9-]+\n/gm, "");

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

  it("the guide's Output block is the CLI's output on hydrogen-like (version 0.1.0)", async () => {
    const site = await startFixture("hydrogen-like");
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
        expectedOutput("guides/hydrogen", "Example"),
      );
    } finally {
      await site.close();
    }
  });
});
