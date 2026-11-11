import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** The built bin, --since last, against one of the two clinic fixtures (one host), from `dir`. */
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

describe("script and header baseline: e2e (the built bin, --since last across two runs)", () => {
  it("the first run saves the baseline; the next run names the new scripts, the looser policy and the lost header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-baseline-"));
    dirs.push(dir);
    const before = await run("checkout-before", dir);
    expect(before.status).toBe(0);
    expect(before.out).toBe(expectedOutput("guides/script-baseline", "The first run"));
    const saved = readFileSync(
      join(dir, ".gaugeline", "last-run", "harbourphysio.example.json"),
      "utf8",
    );
    expect(saved).toContain("js.stripe.example/v3/");
    expect(saved).not.toContain("GTM-DEMO123");
    // The fixture's reporting address carries a key in its query: it is kept nowhere.
    expect(saved).not.toContain("PLANTEDREPORTKEY");
    const after = await run("checkout-after", dir);
    expect(after.status).toBe(0);
    expect(after.out).toBe(expectedOutput("guides/script-baseline", "The next run"));
    expect(
      readFileSync(join(dir, ".gaugeline", "last-run", "harbourphysio.example.json"), "utf8"),
    ).not.toContain("PLANTEDREPORTKEY");
    expect(before.out + before.err + after.out + after.err).not.toContain("PLANTEDREPORTKEY");
    expect([...before.methods, ...after.methods].every((m) => m === "GET" || m === "HEAD")).toBe(
      true,
    );
  });
});
