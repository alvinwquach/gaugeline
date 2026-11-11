import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("astro: e2e", () => {
  it("the guide's Output block is the CLI's output on astro-like (version 0.1.0), and no endpoint is requested", async () => {
    const site = await startFixture("astro-like");
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
      expect(withoutPassed(out.join("")).trimEnd()).toBe(expectedOutput("guides/astro", "Example"));
      expect(
        [...site.hits.keys()].filter((k) => /^\/(_actions|_server-islands|_image)/.test(k)),
      ).toEqual([]);
    } finally {
      await site.close();
    }
  });
});
