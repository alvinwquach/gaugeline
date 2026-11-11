import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("sanity images: e2e", () => {
  it("the guide's Output block is the CLI's output on sanity-images (version 0.1.0), and no picture is requested", async () => {
    const site = await startFixture("sanity-images");
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
        expectedOutput("guides/sanity-images", "Example"),
      );
      // The pictures live on cdn.sanity.io: nothing on the fixture's own host is a picture request.
      expect([...site.hits.keys()].filter((k) => /\.(jpg|png|webp|avif)$/.test(k))).toEqual([
        "/og.png",
      ]);
    } finally {
      await site.close();
    }
  });
});
