import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("language versions: e2e (CLI, version 0.1.0)", () => {
  it("bilingual-popup with its gaugeline.languages.json prints exactly the languages guide's Output block", async () => {
    const site = await startFixture("bilingual-popup");
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const run = capture();
      const code = await main([site.origin, "--no-open", "--allow-private"], run.io, {
        version: "0.1.0",
        cwd: `${SITES_DIR}bilingual-popup`,
      });
      expect(code).toBe(0);
      expect(withoutPassed(run.out()).trimEnd()).toBe(
        expectedOutput("guides/languages", "Example"),
      );
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });

  it("an invalid gaugeline.languages.json stops the run naming the field (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-languages-"));
    try {
      writeFileSync(join(dir, "gaugeline.languages.json"), JSON.stringify({ prefix: { en: "/" } }));
      const run = capture();
      expect(await main(["https://pop.example/"], run.io, { cwd: dir })).toBe(2);
      expect(run.err()).toContain("gaugeline.languages.json:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
