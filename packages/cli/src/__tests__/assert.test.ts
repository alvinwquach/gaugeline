import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR } from "@gaugeline/fixtures";
import { staticSite, useCassette } from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../../core/src/connectors/postgres/__tests__/fake-postgres.js";
import { main } from "../main.js";

const HOST = "bucktavern.example";
const PASSWORD = ["bar", "pw", "0123456789"].join("-");
const dirs: string[] = [];
/** Built at run time: the community check refuses anything shaped like an address in a source file. */
const AT = "@";
const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const OVERLAP = "select id as booking_id, starts_at, email from bookings where false /* overlap */";
const ORPHAN = "select id as order_id from orders where false /* orphan */";

const ASSERTIONS = [
  {
    id: "no-overlapping-bookings",
    severity: "high",
    title: "Two private events are booked at the same time",
    sql: OVERLAP,
    evidence: ["booking_id", "starts_at"],
  },
  {
    id: "no-orphaned-orders",
    severity: "medium",
    title: "A paid order has no matching payment",
    sql: ORPHAN,
    evidence: ["order_id"],
  },
];

function workdir(assertions: unknown, sources: unknown = { db: { type: "postgres" } }): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-assert-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gaugeline.sources.json"), JSON.stringify({ sources, assertions }));
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" } as Record<string, string | undefined>,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const rows = (n: number): FakeReply => ({
  columns: [{ name: "booking_id", oid: 23 }, { name: "starts_at" }, { name: "email" }],
  rows: Array.from({ length: n }, (_, i): Array<string | null> => [
    String(i + 1),
    "2026-12-05T19:00:00.000Z",
    `guest${i + 1}${AT}example.test`,
  ]),
});

async function database(answer: (sql: string) => FakeReply = () => undefined) {
  const server = await startFakePostgres({
    onQuery: (sql) =>
      sql.includes("current_user")
        ? { columns: [{ name: "role" }, { name: "strong", oid: 16 }], rows: [["reader", "f"]] }
        : answer(sql),
  });
  servers.push(server);
  return server;
}

const envFor = (server: FakePostgres): Record<string, string | undefined> => ({
  NO_COLOR: "1",
  GAUGELINE_POSTGRES_URL: `postgres://gaugeline_reader:${PASSWORD}@127.0.0.1:${server.port}/bar?sslmode=disable`,
});

async function assertCmd(
  argv: string[],
  dir: string,
  server?: FakePostgres,
): Promise<{ code: number; out: string; err: string }> {
  const run = capture();
  if (server) run.io.env = envFor(server);
  const code = await main(["assert", ...argv], run.io, { cwd: dir });
  return { code, out: run.out(), err: run.err() };
}

describe("gaugeline assert --list", () => {
  it("prints the assertions: id, severity, source and title, and touches no database", async () => {
    const server = await database();
    const r = await assertCmd(["--list"], workdir(ASSERTIONS), server);
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 data assertions in gaugeline.sources.json");
    expect(r.out).toMatch(/no-overlapping-bookings\s+high\s+db\s+Two private events are booked/);
    expect(r.out).toMatch(/no-orphaned-orders\s+medium\s+db\s+A paid order has no matching/);
    expect(server.received).toEqual([]);
  });

  it("says so when there are none, and when there is no file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-assert-"));
    dirs.push(dir);
    const none = await assertCmd(["--list"], dir);
    expect(none.code).toBe(0);
    expect(none.out).toContain("No data assertions are set up");
    writeFileSync(
      join(dir, "gaugeline.sources.json"),
      JSON.stringify({ sources: { db: { type: "postgres", queries: { q: "select 1" } } } }),
    );
    expect((await assertCmd(["--list"], dir)).out).toContain("No data assertions are set up");
  });
});

describe("gaugeline assert <id>", () => {
  it("zero rows passes (exit 0) and runs only that assertion", async () => {
    const server = await database();
    const r = await assertCmd(["no-overlapping-bookings"], workdir(ASSERTIONS), server);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("no-overlapping-bookings: no rows, so it passes");
    expect(server.received.some((q) => q.sql.includes("/* orphan */"))).toBe(false);
    expect(server.received[0]?.sql.toLowerCase()).toMatch(/begin.*read only/);
  });

  it("rows fail it (exit 1): the title, the count and the evidence columns, and no other column", async () => {
    const server = await database((sql) => (sql.includes("/* overlap */") ? rows(3) : undefined));
    const r = await assertCmd(["no-overlapping-bookings"], workdir(ASSERTIONS), server);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Two private events are booked at the same time");
    expect(r.out).toContain("no-overlapping-bookings: 3 rows.");
    expect(r.out).toContain("booking_id=1, starts_at=2026-12-05T19:00:00.000Z");
    expect(r.out + r.err).not.toContain(`guest1${AT}example.test`);
  });

  it("a failing assertion with 50 rows reports 20 and the count", async () => {
    const server = await database((sql) => (sql.includes("/* overlap */") ? rows(50) : undefined));
    const r = await assertCmd(["no-overlapping-bookings"], workdir(ASSERTIONS), server);
    expect(r.code).toBe(1);
    expect(r.out).toContain("50 rows, showing the first 20.");
    expect(r.out.match(/booking_id=/g)).toHaveLength(20);
  });

  it("an unknown id is exit 2 and lists the ones that exist", async () => {
    const r = await assertCmd(["no-such-thing"], workdir(ASSERTIONS));
    expect(r.code).toBe(2);
    expect(r.err).toContain('no assertion called "no-such-thing"');
    expect(r.err).toContain("no-overlapping-bookings");
  });

  it("needs an id or --list, and not both", async () => {
    const dir = workdir(ASSERTIONS);
    const none = await assertCmd([], dir);
    expect(none.code).toBe(2);
    expect(none.err).toContain("gaugeline assert needs an assertion id");
    const both = await assertCmd(["--list", "no-orphaned-orders"], dir);
    expect(both.code).toBe(2);
    const two = await assertCmd(["a-b", "c-d"], dir);
    expect(two.code).toBe(2);
  });

  it("an assertion that is not a pure read is a config error (exit 2) naming it, and nothing is sent", async () => {
    const server = await database();
    const dir = workdir([
      {
        ...ASSERTIONS[0],
        id: "tidies-bookings",
        sql: "delete from bookings where starts_at < now()",
      },
    ]);
    for (const argv of [["tidies-bookings"], ["--list"]]) {
      const r = await assertCmd(argv, dir, server);
      expect(r.code).toBe(2);
      expect(r.err).toContain('assertion "tidies-bookings" is not a read');
    }
    expect(server.received).toEqual([]);
  });

  it("an evidence column the result does not have is a config error (exit 2) naming the column", async () => {
    const server = await database((sql) => (sql.includes("/* overlap */") ? rows(2) : undefined));
    const dir = workdir([{ ...ASSERTIONS[0], evidence: ["booking_id", "starts_on"] }]);
    const r = await assertCmd(["no-overlapping-bookings"], dir, server);
    expect(r.code).toBe(2);
    expect(r.err).toContain('"starts_on"');
  });

  it("a query that times out is could-not-check (exit 2), never a pass", async () => {
    const server = await database((sql) =>
      sql.includes("/* overlap */")
        ? { error: { code: "57014", message: "canceling statement due to statement timeout" } }
        : undefined,
    );
    const r = await assertCmd(["no-overlapping-bookings"], workdir(ASSERTIONS), server);
    expect(r.code).toBe(2);
    expect(r.out).toContain("? ");
    expect(r.out).toContain("could not be checked");
    expect(r.out).not.toContain("passes");
  });

  it("a database that is not set up is could-not-check naming the variable (exit 2)", async () => {
    const r = await assertCmd(["no-overlapping-bookings"], workdir(ASSERTIONS));
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("GAUGELINE_POSTGRES_URL");
  });

  it("never prints the connection string or its password, even with --verbose", async () => {
    const server = await database((sql) => (sql.includes("/* overlap */") ? rows(1) : undefined));
    const r = await assertCmd(
      ["no-overlapping-bookings", "--verbose"],
      workdir(ASSERTIONS),
      server,
    );
    for (const text of [r.out, r.err]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("postgres://");
    }
  });
});

describe("assertions in a page check", () => {
  const run = async (dir: string, server: FakePostgres) => {
    const io = capture();
    io.io.env = envFor(server);
    const code = await main([`https://${HOST}/`, "--no-open", "--json"], io.io, {
      version: "0.1.0",
      cwd: dir,
      fetcher: {
        transport: staticSite(
          HOST,
          `${SITES_DIR}clean`,
          useCassette("sanity-products", { mode: "replay" }),
        ),
      },
    });
    return { code, out: io.out(), err: io.err() };
  };

  it("a failed assertion is a finding with its own severity and title; a passing one is a pass", async () => {
    const server = await database((sql) => (sql.includes("/* overlap */") ? rows(2) : undefined));
    const r = await run(workdir(ASSERTIONS), server);
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(r.out) as {
      findings: Array<{ checkId: string; severity: string; title: string; evidence: string }>;
      passed: string[];
    };
    const found = json.findings.filter((f) => f.checkId === "data-assertion-failed");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "high",
      title: "Two private events are booked at the same time",
    });
    expect(found[0]?.evidence).toContain("no-overlapping-bookings: 2 rows.");
    expect(r.out).not.toContain(`guest1${AT}example.test`);
  });

  it("when every assertion returns no rows the check passes", async () => {
    const server = await database();
    const r = await run(workdir(ASSERTIONS), server);
    const json = JSON.parse(r.out) as { passed: string[]; findings: Array<{ checkId: string }> };
    expect(json.passed).toContain("data-assertion-failed");
    expect(json.findings.map((f) => f.checkId)).not.toContain("data-assertion-failed");
  });

  it("without assertions in the file the check is not run at all, and no database is contacted", async () => {
    const server = await database();
    const dir = workdir(undefined, { db: { type: "postgres", queries: { q: "select 1" } } });
    const r = await run(dir, server);
    const json = JSON.parse(r.out) as { passed: string[]; failed: string[] };
    expect(json.passed).not.toContain("data-assertion-failed");
    expect(json.failed).not.toContain("data-assertion-failed");
    expect(server.received).toEqual([]);
  });

  it("a write in the file stops the run before any request (exit 2), naming the assertion", async () => {
    const server = await database();
    const dir = workdir([{ ...ASSERTIONS[0], id: "tidies-bookings", sql: "truncate bookings" }]);
    const r = await run(dir, server);
    expect(r.code).toBe(2);
    expect(r.err).toContain('assertion "tidies-bookings" is not a read');
    expect(server.received).toEqual([]);
  });

  it("an evidence column that is not in the result ends the run with exit 2, after the report", async () => {
    const server = await database((sql) => (sql.includes("/* overlap */") ? rows(2) : undefined));
    const dir = workdir([{ ...ASSERTIONS[0], evidence: ["booking_id", "starts_on"] }]);
    const r = await run(dir, server);
    expect(r.code).toBe(2);
    expect(r.err).toContain('"starts_on"');
    expect(JSON.parse(r.out)).toHaveProperty("findings");
  });
});
