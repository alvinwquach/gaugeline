import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "@gaugeline/core";
import { main } from "../main.js";
import { buildRunRecord, hostDir, readRuns, saveRun } from "../runs.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-store-"));
  dirs.push(d);
  return d;
};
const page = { mainHash: "a".repeat(16), links: [], types: [], scripts: [] };
const good = (id: string, at: string): RunRecord => ({
  schema: 1,
  id,
  takenAt: at,
  pages: { "/events": page },
  findings: [],
});
const HOST = "victim.example";

describe("the runs store never trusts a name inside a file (review 1)", () => {
  it("a traversal id inside a file deletes nothing outside the host folder", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "precious"), { recursive: true });
    writeFileSync(join(cwd, "precious", "data.json"), "keep");
    const dir = hostDir(cwd, HOST);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "evil.json"),
      JSON.stringify({
        ...good("r-20200101T000000Z", "2020-01-01T00:00:00.000Z"),
        id: "../../../precious/data",
      }),
    );
    saveRun(
      cwd,
      HOST,
      good("r-20261103T100000Z", "2026-11-03T10:00:00.000Z"),
      new Date("2026-11-03T10:00:00Z"),
      7,
    );
    expect(readFileSync(join(cwd, "precious", "data.json"), "utf8")).toBe("keep");
    expect(readRuns(cwd, HOST).runs.map((r) => r.id)).toEqual(["r-20261103T100000Z"]);
  });
  it("a file whose name is not its run id is skipped", () => {
    const cwd = tmp();
    const dir = hostDir(cwd, HOST);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "r-20261101T100000Z.json"),
      JSON.stringify(good("r-20261102T100000Z", "2026-11-02T10:00:00.000Z")),
    );
    expect(readRuns(cwd, HOST).runs).toEqual([]);
  });
  it("a name made only of dots cannot leave the runs folder", () => {
    const cwd = tmp();
    for (const host of ["..", ".", "..."]) {
      const dir = resolve(hostDir(cwd, host));
      expect(dir.startsWith(resolve(cwd, ".gaugeline", "runs") + sep)).toBe(true);
    }
  });
});

describe("a malformed file is skipped, not a crash (review 6)", () => {
  it("a schema-1 file with no findings, and an oversized file, are skipped; changes still runs", async () => {
    const cwd = tmp();
    const dir = hostDir(cwd, HOST);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "r-20261101T100000Z.json"),
      JSON.stringify({
        schema: 1,
        id: "r-20261101T100000Z",
        takenAt: "2026-11-01T10:00:00.000Z",
        pages: {},
      }),
    );
    writeFileSync(
      join(dir, "r-20261102T100000Z.json"),
      JSON.stringify({
        ...good("r-20261102T100000Z", "2026-11-02T10:00:00.000Z"),
        pad: "x".repeat(1_100_000),
      }),
    );
    expect(readRuns(cwd, HOST).runs).toEqual([]);
    const out: string[] = [];
    const code = await main(
      ["changes", `https://${HOST}/`],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => 0 },
        env: { NO_COLOR: "1" },
      },
      { cwd },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("No runs are stored");
  });
  it("reads at most the newest 500 files", () => {
    const cwd = tmp();
    const dir = hostDir(cwd, HOST);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 520; i++) {
      const id = `r-2026${String(1 + Math.floor(i / 28)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T100000Z`;
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(good(id, "2026-01-01T10:00:00.000Z")));
    }
    expect(readRuns(cwd, HOST).runs.length).toBeLessThanOrEqual(500);
  });
});

describe("saving a run (review 10)", () => {
  it("writes with owner-only permissions, leaves no temp file, and refuses an id that is not a run id", () => {
    const cwd = tmp();
    saveRun(
      cwd,
      HOST,
      good("r-20261103T100000Z", "2026-11-03T10:00:00.000Z"),
      new Date("2026-11-03T10:00:00Z"),
      90,
    );
    const dir = hostDir(cwd, HOST);
    expect(readdirSync(dir)).toEqual(["r-20261103T100000Z.json"]);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "r-20261103T100000Z.json")).mode & 0o077).toBe(0);
    expect(() =>
      saveRun(cwd, HOST, { ...good("x", "2026-11-03T10:00:00.000Z"), id: "../x" }, new Date(), 90),
    ).toThrow();
    expect(existsSync(join(cwd, "x.json"))).toBe(false);
  });
});

describe("what a run records (review 7)", () => {
  const snapshot = { finalUrl: "https://harbourbar.example/events" } as Parameters<
    typeof buildRunRecord
  >[0];
  const record = { mainHash: "a".repeat(16), links: [], types: [], scripts: [] };
  it("keeps the findings on the checked page and counts the rest", () => {
    const run = buildRunRecord(
      snapshot,
      record,
      [
        {
          checkId: "a",
          url: "https://harbourbar.example/events",
          title: "on page",
          severity: "low",
          evidence: "",
        },
        {
          checkId: "b",
          url: "https://harbourbar.example/book",
          title: "elsewhere",
          severity: "low",
          evidence: "",
        },
        {
          checkId: "c",
          url: "https://other.example/x",
          title: "elsewhere too",
          severity: "low",
          evidence: "",
        },
      ],
      new Date("2026-11-03T10:00:00Z"),
    );
    expect(run.findings.map((f) => f.checkId)).toEqual(["a"]);
    expect(run.offPage).toBe(2);
    expect(Object.keys(run.pages)).toEqual(["/events"]);
  });
});

describe("keys never reach a saved run or the output (review 14)", () => {
  it("a planted token is in neither the store nor the report", async () => {
    const SECRET = ["tok", "en-store-only"].join("");
    const cwd = tmp();
    saveRun(
      cwd,
      HOST,
      good("r-20261103T100000Z", "2026-11-03T10:00:00.000Z"),
      new Date("2026-11-03T10:00:00Z"),
      90,
    );
    const out: string[] = [];
    await main(
      ["changes", `https://${HOST}/`],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: (s: string) => out.push(s) },
        env: { NO_COLOR: "1", SANITY_TOKEN: SECRET, VERCEL_TOKEN: SECRET },
      },
      { cwd },
    );
    expect(out.join("")).not.toContain(SECRET);
    for (const f of readdirSync(hostDir(cwd, HOST)))
      expect(readFileSync(join(hostDir(cwd, HOST), f), "utf8")).not.toContain(SECRET);
  });
});

describe("--since with an unknown run id (review 2)", () => {
  it("exits 2 and says where history starts", async () => {
    const cwd = tmp();
    saveRun(
      cwd,
      HOST,
      good("r-20261103T100000Z", "2026-11-03T10:00:00.000Z"),
      new Date("2026-11-03T10:00:00Z"),
      90,
    );
    const err: string[] = [];
    const code = await main(
      ["changes", `https://${HOST}/`, "--since", "r-20260101T000000Z"],
      {
        stdout: { write: () => 0 },
        stderr: { write: (s: string) => err.push(s) },
        env: { NO_COLOR: "1" },
      },
      { cwd },
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain(
      "r-20260101T000000Z is not stored; history kept from 3 Nov 2026",
    );
  });
});
