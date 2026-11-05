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

describe("schema rules: e2e (CLI, version 0.1.0)", () => {
  it("northwind with its gaugeline.schema.json prints exactly the guide's Output block", async () => {
    const site = await startFixture("northwind");
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const run = capture();
      const code = await main([site.origin, "--no-open", "--allow-private"], run.io, {
        version: "0.1.0",
        cwd: `${SITES_DIR}northwind`,
      });
      expect(code).toBe(0);
      expect(withoutPassed(run.out()).trimEnd()).toBe(
        expectedOutput("guides/schema-rules", "Example"),
      );
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });

  it("an invalid gaugeline.schema.json stops the run with one sentence naming the field (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-schema-"));
    try {
      writeFileSync(
        join(dir, "gaugeline.schema.json"),
        JSON.stringify({ templates: [{ match: "/blog/*" }] }),
      );
      const run = capture();
      const code = await main(["https://clinic.example/"], run.io, { cwd: dir });
      expect(code).toBe(2);
      expect(run.err()).toContain("gaugeline.schema.json: templates.0.require:");
      writeFileSync(join(dir, "gaugeline.schema.json"), "{ not json");
      const again = capture();
      expect(await main(["https://clinic.example/"], again.io, { cwd: dir })).toBe(2);
      expect(again.err()).toContain("gaugeline.schema.json is not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
