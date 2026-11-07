import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The built bin, --since last, against one of the two fixtures (one host, fernkiln.example), from `dir`. */
async function run(name: string, dir: string) {
  const site = await startFixture(name);
  try {
    const env: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      NODE_OPTIONS: `--require=${MAP_HOSTS}`,
      // Nothing but the mapped fixture host resolves: no live request can leave this test.
      GAUGELINE_TEST_OFFLINE: "1",
      GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
    };
    const r = await runBin([site.origin, "--since", "last", "--no-open", "--allow-private"], env, {
      cwd: dir,
    });
    return {
      status: r.status,
      out: withoutPassed(r.stdout).trimEnd(),
      err: r.stderr,
      methods: [...site.methods.keys()],
    };
  } finally {
    await site.close();
  }
}

describe("page snapshots: e2e (the built bin, --since last across two runs)", () => {
  it("prints the page that lost a section, with before and after word counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-snap-"));
    dirs.push(dir);
    const before = await run("snap-before", dir);
    expect(before.status).toBe(0);
    expect(before.out).toBe(expectedOutput("guides/page-snapshots", "The first run"));
    const after = await run("snap-after", dir);
    expect(after.status).toBe(0);
    expect(after.out).toBe(expectedOutput("guides/page-snapshots", "The next run"));
    expect(after.out).toContain(
      'A page lost content since the last run\n    139 words, now 101 (−27%); section gone: "Awards"',
    );
    expect(after.err).toContain("Since the last run:\n  New page: /gift-cards\n");
    expect([...before.methods, ...after.methods].every((m) => m === "GET" || m === "HEAD")).toBe(
      true,
    );
  });
});
