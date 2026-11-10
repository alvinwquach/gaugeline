import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRESHNESS_CHECKS } from "@gaugeline/core";
import { SITES_DIR } from "@gaugeline/fixtures";
import { staticSite } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../../core/src/connectors/postgres/__tests__/fake-postgres.js";
import { main } from "../main.js";

const HOST = "harbor.example";
const PASSWORD = ["harbor", "pw", "0123456789"].join("-");
const IN_SEASON = new Date("2026-11-10T12:00:00Z");

const dirs: string[] = [];
const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function workdir(files: Record<string, unknown> | "stats"): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-freshness-"));
  dirs.push(dir);
  if (files === "stats")
    for (const f of ["gaugeline.freshness.json", "gaugeline.sources.json"])
      cpSync(join(SITES_DIR, "freshness-stats", f), join(dir, f));
  else
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
}

const SYNCS: Record<string, FakeReply> = {
  "job = 'players'": {
    columns: [{ name: "value", oid: 1184 }],
    rows: [["2026-11-10 11:50:00+00"]],
  },
  "job = 'standings'": {
    columns: [{ name: "value", oid: 1184 }],
    rows: [["2026-11-07 11:05:00+00"]],
  },
  "from player_totals": {
    columns: [{ name: "key" }, { name: "value", oid: 1700 }],
    rows: [
      ["jane-example", "27.3"],
      ["sam-sample", "19.8"],
    ],
  },
};

async function database(answers: Record<string, FakeReply>): Promise<FakePostgres> {
  const server = await startFakePostgres({
    onQuery: (sql) => {
      if (sql.includes("current_user"))
        return {
          columns: [{ name: "role" }, { name: "strong", oid: 16 }],
          rows: [["reader", "f"]],
        };
      for (const [word, reply] of Object.entries(answers)) if (sql.includes(word)) return reply;
      return undefined;
    },
  });
  servers.push(server);
  return server;
}

const connection = (server: FakePostgres): string =>
  `postgres://gaugeline_reader:${PASSWORD}@127.0.0.1:${server.port}/hoops?sslmode=disable`;

async function run(
  args: string[],
  dir: string,
  env: Record<string, string | undefined> = {},
  requests: Array<{ method: string; url: string }> = [],
  now: Date = IN_SEASON,
) {
  const out: string[] = [];
  const err: string[] = [];
  const inner = staticSite(HOST, join(SITES_DIR, "freshness-stats"), () =>
    Promise.reject(new Error("only the fixture host is served")),
  );
  const code = await main(
    args,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    {
      cwd: dir,
      version: "0.1.0",
      now: () => now,
      fetcher: {
        transport: (url, req) => {
          requests.push({ method: req.method, url: url.href });
          return inner(url, req);
        },
      },
    },
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("gaugeline.freshness.json in the CLI", () => {
  it("a bad file stops the run naming the file and the field (exit 2)", async () => {
    const dir = workdir({
      "gaugeline.freshness.json": {
        freshness: [{ page: "/x", stamp: { selector: "time" }, maxAge: "soon" }],
      },
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain("gaugeline.freshness.json: freshness.0.maxAge:");
    expect(r.err).toContain('"6h", "2d", "90m"');
  });

  it("a db: source with no sources file stops the run, naming the file, the source and where to fix it", async () => {
    const dir = workdir({
      "gaugeline.freshness.json": {
        freshness: [
          {
            page: "/x",
            stamp: { selector: "time" },
            maxAge: "6h",
            source: "db:latestSync",
            maxLag: "1h",
          },
        ],
      },
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('gaugeline.freshness.json: freshness.0.source: "db:latestSync"');
    expect(r.err).toContain("gaugeline.sources.json");
    expect(r.err).toContain("docs/guides/data-freshness");
  });

  it("a spot check naming a query the sources file does not have stops the run", async () => {
    const dir = workdir({
      "gaugeline.freshness.json": {
        freshness: [{ page: "/x", spot: [{ selector: ".ppg", source: "db:nope" }] }],
      },
      "gaugeline.sources.json": {
        sources: { db: { type: "postgres", queries: { other: "select 1" } } },
      },
    });
    const r = await run([`https://${HOST}/`, "--no-open"], dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('freshness.0.spot.0.source: "db:nope"');
  });

  it("with the file, the four checks run and print what the site got wrong", async () => {
    const server = await database(SYNCS);
    const requests: Array<{ method: string; url: string }> = [];
    const r = await run(
      [`https://${HOST}/`, "--no-open"],
      workdir("stats"),
      { HARBOR_DB_URL: connection(server) },
      requests,
    );
    expect(r.code).toBe(0);
    for (const text of [
      "The numbers on this page are older than they should be",
      "The page is behind the data it is built from",
      "A page of changing numbers does not say when they were updated",
      "The page still shows a prediction for something that already happened",
      "/players/jane-example is stamped",
      "points per game on /players/sam-sample shows 19.1, and db:playerPpg has 19.8",
      "the sync looks stopped, not the site",
      "/teams/hawks shows no stamp (team-pages)",
      "/predictions lists 1 prediction whose event is already over",
    ])
      expect(r.out, text).toContain(text);
    // Reads only: every request is a GET or HEAD.
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(connection(server));
    }
  });

  it("--json lists the findings under their check ids", async () => {
    const server = await database(SYNCS);
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir("stats"), {
      HARBOR_DB_URL: connection(server),
    });
    const result = JSON.parse(r.out) as { findings: Array<{ checkId: string }> };
    const ids = new Set(result.findings.map((f) => f.checkId));
    for (const id of FRESHNESS_CHECKS) expect(ids.has(id), id).toBe(true);
  });

  it("in the off-season the windowed rules say so and report nothing", async () => {
    const server = await database(SYNCS);
    const r = await run(
      [`https://${HOST}/`, "--no-open"],
      workdir("stats"),
      { HARBOR_DB_URL: connection(server) },
      [],
      new Date("2026-07-15T12:00:00Z"),
    );
    expect(r.out).toContain(
      'data-stale could not be checked: The rule "player-pages" only applies in October to June (it is July in America/New_York), so how old the stamp is was not checked.',
    );
    expect(r.out).not.toContain("is stamped");
  });

  it("with the database variable unset, the checks that need it say so and the others still run (never a pass)", async () => {
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir("stats"), {});
    const result = JSON.parse(r.out) as {
      findings: Array<{ checkId: string }>;
      passed: string[];
      couldNotCheck: Array<{ id: string; reason: string }>;
    };
    expect(result.findings.some((f) => f.checkId === "data-behind-source")).toBe(false);
    expect(result.passed).not.toContain("data-behind-source");
    expect(
      result.couldNotCheck.some(
        (c) => c.id === "data-behind-source" && c.reason.includes("HARBOR_DB_URL"),
      ),
    ).toBe(true);
    expect(result.findings.some((f) => f.checkId === "data-no-stamp")).toBe(true);
  });

  it("without the file the freshness checks are not run: neither passed nor failed", async () => {
    const r = await run([`https://${HOST}/`, "--no-open", "--json"], workdir({}));
    const result = JSON.parse(r.out) as { passed: string[]; findings: Array<{ checkId: string }> };
    for (const id of FRESHNESS_CHECKS) {
      expect(result.passed).not.toContain(id);
      expect(result.findings.map((f) => f.checkId)).not.toContain(id);
    }
  });
});
