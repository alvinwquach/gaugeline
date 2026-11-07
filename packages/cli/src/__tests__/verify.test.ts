import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crawlExport, expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

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
  it("gaugeline verify fixture-export.csv prints the summary and exits 0", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "fixture-export.csv"), crawlExport());
    const r = await runBin(["verify", "fixture-export.csv"], { NO_COLOR: "1" }, { cwd: dir });
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("crawler-view", "How rows are classified"));
  });
});

describe("verify: integration (in-process)", () => {
  const run = async (dir: string, file: string) => {
    let requests = 0;
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["verify", file],
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

  it("classification makes zero requests", async () => {
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
