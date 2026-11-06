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

async function withNoColor<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
}

describe("tag rules: e2e (CLI, version 0.1.0)", () => {
  it("tag-rules with its gaugeline.tags.json prints the tag rules guide's Output block and the summary line", async () => {
    const site = await startFixture("tag-rules");
    try {
      const run = capture();
      const code = await withNoColor(() =>
        main([site.origin, "--no-open", "--allow-private"], run.io, {
          version: "0.1.0",
          cwd: `${SITES_DIR}tag-rules`,
        }),
      );
      if (process.env.PRINT_TAGS_OUTPUT) console.log(withoutPassed(run.out()), run.err());
      expect(code).toBe(0);
      expect(withoutPassed(run.out()).trimEnd()).toBe(
        expectedOutput("guides/tag-rules", "Example"),
      );
      expect(run.err()).toContain(
        "Tag rules: read 8 triggers from GTM-TEST01; 4 can fire, 2 cannot, 2 could not be checked.\n",
      );
    } finally {
      await site.close();
    }
  });

  it("--json leaves the summary line out; the dead rules are findings", async () => {
    const site = await startFixture("tag-rules");
    try {
      const run = capture();
      await main([site.origin, "--json", "--allow-private"], run.io, {
        version: "0.1.0",
        cwd: `${SITES_DIR}tag-rules`,
      });
      expect(run.err()).not.toContain("Tag rules:");
      const json = JSON.parse(run.out()) as { findings: { checkId: string }[] };
      expect(
        json.findings.filter((f) => f.checkId.startsWith("tags-")).map((f) => f.checkId),
      ).toEqual(["tags-dead-rules", "tags-dead-rules", "tags-duplicate"]);
    } finally {
      await site.close();
    }
  });

  it("a gaugeline.tags.json naming a missing file, or a file that isn't an export, stops the run (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-tags-"));
    try {
      writeFileSync(join(dir, "gaugeline.tags.json"), JSON.stringify({ container: "gtm.json" }));
      let run = capture();
      expect(await main(["https://pop.example/"], run.io, { cwd: dir })).toBe(2);
      expect(run.err()).toContain("gaugeline.tags.json: container: gtm.json was not found.");
      writeFileSync(join(dir, "gtm.json"), JSON.stringify({ tags: [] }));
      run = capture();
      expect(await main(["https://pop.example/"], run.io, { cwd: dir })).toBe(2);
      expect(run.err()).toContain(
        "gtm.json is not a Tag Manager container export: containerVersion:",
      );
      writeFileSync(join(dir, "gaugeline.tags.json"), JSON.stringify({ container: "" }));
      run = capture();
      expect(await main(["https://pop.example/"], run.io, { cwd: dir })).toBe(2);
      expect(run.err()).toContain(
        "gaugeline.tags.json: container: must name the container export file.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
