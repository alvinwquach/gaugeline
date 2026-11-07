import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlExport, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-verify-"));
  dirs.push(d);
  return d;
};

describe("verify: e2e (the built bin)", () => {
  it("gaugeline verify fixture-export.csv --limit 0 prints the summary, exits 0, makes no request", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "fixture-export.csv"), crawlExport());
    const r = await runBin(
      ["verify", "fixture-export.csv", "--limit", "0"],
      { NO_COLOR: "1" },
      { cwd: dir },
    );
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("crawler-view", "How rows are classified"));
  });
});

describe("verify: e2e (the built bin re-checking the rsc-app fixture)", () => {
  const recheck = async (extra: string[]) => {
    const site = await startFixture("rsc-app");
    try {
      const dir = scratch();
      writeFileSync(join(dir, "fixture-export.csv"), crawlExport(site.origin));
      const env = {
        NO_COLOR: "1",
        NODE_OPTIONS: `--require=${MAP_HOSTS}`,
        // Nothing but the mapped fixture hosts resolves: no live request can leave this test.
        GAUGELINE_TEST_OFFLINE: "1",
        GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
      };
      const r = await runBin(["verify", "fixture-export.csv", "--allow-private", ...extra], env, {
        cwd: dir,
      });
      return { ...r, methods: [...site.methods.keys()] };
    } finally {
      await site.close();
    }
  };

  it("--limit 3 prints three results and the summary line", async () => {
    const r = await recheck(["--limit", "3"]);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("crawler-view", "Re-check the pages"));
    expect(r.methods).toEqual(["GET"]);
    expect(r.status).toBe(0);
  });

  it("--ci exits 1 when a high finding exists", async () => {
    expect((await recheck(["--limit", "3", "--ci"])).status).toBe(1);
  });
});

describe("verify: integration (in-process)", () => {
  const run = async (dir: string, file: string, extra: string[] = ["--limit", "0"]) => {
    let requests = 0;
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["verify", file, ...extra],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: (s: string) => err.push(s) },
        env: {},
      },
      {
        cwd: dir,
        // A transport that counts: classification must never reach it.
        fetcher: {
          transport: () => {
            requests++;
            return Promise.reject(new Error("no request expected"));
          },
        },
      },
    );
    return { code, out: out.join(""), err: err.join(""), requests };
  };

  it("classification (--limit 0) makes zero requests", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "e.csv"), crawlExport());
    const r = await run(dir, "e.csv");
    expect([r.code, r.requests]).toEqual([0, 0]);
    expect(r.out.split("\n")[0]).toBe("4,061 of 4,180 orphan URLs were prefetch payloads");
  });

  it("an export with no address column exits 2, naming its columns", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "e.csv"), "Status,Title\n200,Home\n");
    const r = await run(dir, "e.csv");
    expect(r.code).toBe(2);
    expect(r.err).toContain('e.csv: No address column found: the header has "Status", "Title"');
  });
});
