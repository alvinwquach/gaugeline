import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** gaugeline ryeember.example --since last against one of the two fixtures, from `dir`. */
async function run(name: string, dir: string) {
  const site = await startFixture(name);
  try {
    const out: string[] = [];
    const io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => undefined },
      env: { NO_COLOR: "1" },
    };
    const code = await main([site.origin, "--since", "last", "--no-open"], io, {
      cwd: dir,
      fetcher: { hosts: site.hosts },
    });
    return { code, out: withoutPassed(out.join("")).trimEnd(), methods: [...site.methods.keys()] };
  } finally {
    await site.close();
  }
}

describe("navigation: e2e (CLI, --since last across the restructure)", () => {
  it("before saves the menu; after lists exactly what was removed, moved and renamed, and the one orphan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-nav-site-"));
    dirs.push(dir);
    const before = await run("nav-before", dir);
    expect(before.code).toBe(0);
    expect(before.out).toBe(expectedOutput("guides/navigation", "Before the restructure"));
    const after = await run("nav-after", dir);
    expect(after.code).toBe(0);
    expect(after.out).toBe(expectedOutput("guides/navigation", "After the restructure"));
    const changes = after.out
      .split("\n")
      .filter((l) => /^ {4}(Removed|Moved|Renamed|Added|Reordered):/.test(l));
    expect(changes.map((l) => l.trim().split(":")[0])).toEqual(["Removed", "Moved", "Renamed"]);
    expect(after.out).toContain("1 sitemap address has no link from the 5 pages read: /gift-cards");
    expect(after.methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
  });
});
