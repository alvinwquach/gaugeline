import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  startServer,
  type FixtureServer,
} from "../../packages/core/src/__tests__/helpers/server.js";
import { wpPage } from "../../packages/core/src/wordpress/__tests__/world.js";

/**
 * Start-up time, on the built bin (`pnpm build` first, like the other tests that spawn it).
 *
 * The time assertions are generous on purpose (this file runs on Windows and macOS runners, Node 22 and 24):
 * the bound is about seven times what a laptop measures, so only a real regression, such as every adapter
 * loading at start-up, can reach it. The structural assertions do not depend on time at all: with
 * GAUGELINE_TRACE_ADAPTER_LOADS=1 the bin names each adapter it loads on stderr (packages/core/src/adapters/
 * registry.ts onAdapterLoad), and `--version`, `--help` and a run that names no adapter load none, while a run
 * that names WordPress loads that one and no other.
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(repoRoot, "packages/cli/dist");
const bin = join(dist, "index.js");

/** Measured on a laptop, Node 22: about 210 ms for --version and --help. The bound is for a slow shared runner. */
const MEDIAN_BOUND_MS = 1500;
const RUNS = 5;

const traceEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["CI", "NO_COLOR", "FORCE_COLOR", "GITHUB_ACTIONS"]) delete env[key];
  return { ...env, GAUGELINE_TRACE_ADAPTER_LOADS: "1", ...extra };
};

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<Ran> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { encoding: "utf8", env, ...(cwd ? { cwd } : {}) },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({
          status: err === null ? 0 : typeof code === "number" ? code : -1,
          stdout,
          stderr,
          ms: performance.now() - started,
        });
      },
    );
  });
}

/** The ids the run named as loaded, in order. */
const loaded = (stderr: string): string[] =>
  [...stderr.matchAll(/^gaugeline: loaded adapter (\S+)$/gm)].map((m) => m[1] ?? "");

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const version = (
  JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8")) as {
    version: string;
  }
).version;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0))
    rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const folder = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-startup-")));
  temps.push(dir);
  return dir;
};

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({
    "/": (_req, res) => {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(wpPage({ plugins: [["gallery-lite", "1.3.0"]] }));
    },
  });
});
afterAll(() => site.close());

describe("the built bin starts without loading any adapter", () => {
  it("is built, and its entry file is only the start-up guard", () => {
    expect(existsSync(bin), "run `pnpm build` before the tests").toBe(true);
    // The version guard (index.ts) imports the rest by a dynamic import, so on an old Node it is all that is parsed.
    expect(statSync(bin).size).toBeLessThan(20_000);
  });

  for (const flag of ["--version", "--help"]) {
    it(`${flag}: loads no adapter and the median of ${RUNS} runs is under ${MEDIAN_BOUND_MS} ms`, async () => {
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const r = await run([flag], traceEnv());
        expect(r.status).toBe(0);
        if (flag === "--version") expect(r.stdout.trim()).toBe(version);
        else expect(r.stdout).toContain("gaugeline");
        expect(loaded(r.stderr)).toEqual([]);
        times.push(r.ms);
      }
      expect(median(times), `the runs took ${times.map(Math.round).join(", ")} ms`).toBeLessThan(
        MEDIAN_BOUND_MS,
      );
    });
  }

  it("the trace is silent unless asked for", async () => {
    const env = traceEnv();
    delete env.GAUGELINE_TRACE_ADAPTER_LOADS;
    const r = await run(["--version"], env);
    expect(r.stderr).not.toContain("loaded adapter");
  });

  it("a run with no adapters configured loads none", async () => {
    const r = await run(
      [site.origin, "--allow-private", "--no-open", "--quiet"],
      traceEnv(),
      folder(),
    );
    expect(r.status === 0 || r.status === 1).toBe(true);
    expect(loaded(r.stderr)).toEqual([]);
  });

  it("a WordPress-only run loads wordpress and no other adapter", async () => {
    const dir = folder();
    writeFileSync(
      join(dir, "gaugeline.adapters.json"),
      JSON.stringify({ adapters: [{ id: "wordpress" }] }),
    );
    const r = await run(
      ["advisory", site.origin, "wp-plugin:gallery-lite@<9.0.0", "--allow-private"],
      traceEnv({ WORDPRESS_URL: site.origin }),
      dir,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(loaded(r.stderr)).toEqual(["wordpress"]);
  });
});
