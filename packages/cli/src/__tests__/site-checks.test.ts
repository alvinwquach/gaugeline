import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

function capture() {
  const out: string[] = [];
  return {
    io: { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } },
    out: () => out.join(""),
  };
}

describe("robots, sitemap and feed checks: e2e (CLI, version 0.1.0)", () => {
  it("the sitemap-feeds fixture prints the findings shown on the Privacy page", async () => {
    const site = await startFixture("sitemap-feeds");
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const run = capture();
      const code = await main([site.origin, "--no-open"], run.io, {
        version: "0.1.0",
        fetcher: { hosts: site.hosts },
      });
      expect(code).toBe(0);
      const stdout = run.out();
      // One "✓ <id>" line per passed check is left out of the docs block: it grows with every check.
      expect(withoutPassed(stdout).trimEnd()).toBe(
        expectedOutput("privacy", "robots.txt, sitemaps and feeds"),
      );
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });
});
