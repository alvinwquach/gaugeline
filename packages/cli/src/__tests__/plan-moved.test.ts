import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

/**
 * plan-moved-not-indexable (NAV-04), through the CLI: Quarry Lane Dental is an invented practice.
 * Two of its three moved pages are set noindex (one in the page, one in a header).
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("plan-moved-not-indexable: end to end", () => {
  it("--base prints the two moved pages that are set noindex, as the docs show, with GET only", async () => {
    const site = await startFixture("plan-moved");
    try {
      const dir = mkdtempSync(join(tmpdir(), "gaugeline-moved-"));
      dirs.push(dir);
      cpSync(join(SITES_DIR, "plan-moved", "plan.csv"), join(dir, "plan.csv"));
      const run = capture();
      const code = await main(
        ["plan", "plan.csv", "--base", site.origin, "--allow-private"],
        run.io,
        {
          cwd: dir,
        },
      );
      expect(code).toBe(1);
      expect(withoutPassed(run.out()).trimEnd()).toBe(
        expectedOutput("plan-check", "Moved pages: can they be indexed?"),
      );
      expect([...site.methods.keys()]).toEqual(["GET"]);
      expect(site.hits.get("/robots.txt")).toBe(1);
    } finally {
      await site.close();
    }
  });
});
