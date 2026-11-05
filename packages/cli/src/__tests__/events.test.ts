import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("event checks: e2e (CLI, version 0.1.0)", () => {
  it("the venue fixture, clock fixed, prints exactly the events guide's Output block", async () => {
    const site = await startFixture("venue");
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const out: string[] = [];
      const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } };
      const code = await main([site.origin, "--no-open", "--allow-private"], io, {
        version: "0.1.0",
        now: () => new Date("2026-11-05T20:00:00Z"),
      });
      expect(code).toBe(0);
      // One "✓ <id>" line per passed check is left out of the docs block: it grows with every check.
      expect(withoutPassed(out.join("")).trimEnd()).toBe(
        expectedOutput("guides/events", "Example"),
      );
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });
});
