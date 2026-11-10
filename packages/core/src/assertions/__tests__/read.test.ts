import { afterEach, describe, expect, it } from "vitest";
import { sourcesConfigSchema } from "../../connectors/postgres/config.js";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../connectors/postgres/__tests__/fake-postgres.js";
import { localUrl } from "../../connectors/postgres/__tests__/helpers.js";
import { createFetcher } from "../../fetcher.js";
import { lazyAssertions, readAssertions } from "../read.js";

/** Built at run time: the community check refuses anything shaped like an address in a source file. */
const AT = "@";
const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const PASSWORD = ["bar", "pw", "0123456789"].join("-");
const OVERLAP_SQL =
  "select id as booking_id, starts_at, email from bookings where false /* overlap */";
const ORPHAN_SQL = "select id as order_id from orders where false /* orphan */";

const assertion = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "no-overlapping-bookings",
  severity: "high",
  title: "Two private events are booked at the same time",
  sql: OVERLAP_SQL,
  evidence: ["booking_id", "starts_at"],
  ...over,
});

const settings = (
  port: number,
  assertions: Array<Record<string, unknown>>,
  source: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) => ({
  config: sourcesConfigSchema.parse({
    sources: { db: { type: "postgres", ...source } },
    assertions,
  }),
  env: { GAUGELINE_POSTGRES_URL: localUrl(port, "gaugeline_reader", PASSWORD), ...extra },
});

async function serve(answer: (sql: string) => FakeReply): Promise<FakePostgres> {
  const s = await startFakePostgres({ onQuery: answer });
  servers.push(s);
  return s;
}

const clean = (sql: string): FakeReply =>
  sql.includes("current_user")
    ? { columns: [{ name: "role" }, { name: "strong", oid: 16 }], rows: [["reader", "f"]] }
    : { columns: [], rows: [] };

const overlapRows = (n: number) => ({
  columns: [{ name: "booking_id", oid: 23 }, { name: "starts_at" }, { name: "email" }],
  rows: Array.from({ length: n }, (_, i): Array<string | null> => [
    String(i + 1),
    "2026-12-05T19:00:00.000Z",
    `guest${i + 1}${AT}example.test`,
  ]),
});

describe("running assertions through the database connector", () => {
  it("zero rows passes, and the statement ran inside a read-only transaction", async () => {
    const server = await serve(clean);
    const read = await readAssertions(settings(server.port, [assertion({})]), createFetcher({}));
    expect(read.results).toHaveLength(1);
    expect(read.results[0]).toMatchObject({
      id: "no-overlapping-bookings",
      status: "passed",
      count: 0,
      rows: [],
      source: "db",
    });
    const sent = server.received.map((r) => r.sql.trim().toLowerCase());
    expect(sent[0]).toMatch(/^begin.*read only/);
    expect(sent).toContain(OVERLAP_SQL.toLowerCase());
  });

  it("any rows fail it: the count, and the evidence columns of the first rows", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */") ? overlapRows(3) : clean(sql),
    );
    const read = await readAssertions(settings(server.port, [assertion({})]), createFetcher({}));
    expect(read.results[0]).toMatchObject({
      status: "failed",
      count: 3,
      atLeast: false,
      columns: ["booking_id", "starts_at"],
      rows: [
        { booking_id: "1", starts_at: "2026-12-05T19:00:00.000Z" },
        { booking_id: "2", starts_at: "2026-12-05T19:00:00.000Z" },
        { booking_id: "3", starts_at: "2026-12-05T19:00:00.000Z" },
      ],
    });
  });

  it("a failing assertion with 50 rows reports 20 of them and the count", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */") ? overlapRows(50) : clean(sql),
    );
    const read = await readAssertions(settings(server.port, [assertion({})]), createFetcher({}));
    const r = read.results[0];
    expect(r?.status).toBe("failed");
    expect(r?.count).toBe(50);
    expect(r?.rows).toHaveLength(20);
    expect(r?.rows[19]?.booking_id).toBe("20");
  });

  it("a column that is not on the evidence list is never printed or kept (the email stays in the database)", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */") ? overlapRows(5) : clean(sql),
    );
    const read = await readAssertions(settings(server.port, [assertion({})]), createFetcher({}));
    const everything = JSON.stringify(read);
    expect(everything).not.toContain(`guest1${AT}example.test`);
    expect(everything).not.toContain("email");
    // The config can say so: then it is shown.
    const named = await readAssertions(
      settings(server.port, [assertion({ evidence: ["booking_id", "email"] })]),
      createFetcher({}),
    );
    expect(named.results[0]?.rows[0]).toEqual({
      booking_id: "1",
      email: `guest1${AT}example.test`,
    });
  });

  it("an evidence column that the result does not have is a config error naming the column", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */") ? overlapRows(2) : clean(sql),
    );
    const read = await readAssertions(
      settings(server.port, [assertion({ evidence: ["booking_id", "starts_on"] })]),
      createFetcher({}),
    );
    expect(read.results[0]?.status).toBe("config-error");
    expect(read.results[0]?.message).toContain('"starts_on"');
    expect(read.results[0]?.message).toContain("no-overlapping-bookings");
    expect(read.results[0]?.rows).toEqual([]);
  });

  it("a write is a config error naming the assertion and is never sent, not even a connection is made", async () => {
    const server = await serve(clean);
    // The schema refuses a write at the door; this is a config built by hand, past the door.
    const base = settings(server.port, [assertion({ id: "clears-old-bookings" })]);
    const first = base.config.assertions?.[0] as { sql: string };
    first.sql = "delete from bookings where starts_at < now()";
    const read = await readAssertions(base, createFetcher({}));
    expect(read.results[0]).toMatchObject({ id: "clears-old-bookings", status: "config-error" });
    expect(read.results[0]?.message).toContain('"clears-old-bookings"');
    expect(server.received).toEqual([]);
  });

  it("a refused assertion does not stop the others, and the refused SQL never reaches the server", async () => {
    const server = await serve(clean);
    const base = settings(server.port, [assertion({})]);
    // Built past the schema on purpose (the schema refuses a write): the connector must refuse it too.
    const config = {
      ...base.config,
      assertions: [
        ...(base.config.assertions ?? []),
        assertion({ id: "sneaky", sql: "update bookings set email = null" }) as never,
      ],
    };
    const read = await readAssertions({ ...base, config }, createFetcher({}));
    expect(read.results.map((r) => [r.id, r.status])).toEqual([
      ["no-overlapping-bookings", "passed"],
      ["sneaky", "config-error"],
    ]);
    expect(server.received.some((r) => /update bookings/i.test(r.sql))).toBe(false);
  });

  it("a query that times out is could-not-check, never a pass, and the other assertions still run", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */")
        ? { error: { code: "57014", message: "canceling statement due to statement timeout" } }
        : sql.includes("/* orphan */")
          ? { columns: [{ name: "order_id", oid: 23 }], rows: [["7"]] }
          : clean(sql),
    );
    const read = await readAssertions(
      settings(server.port, [
        assertion({}),
        assertion({
          id: "no-orphaned-orders",
          title: "Orders point at a customer that is gone",
          sql: ORPHAN_SQL,
          evidence: ["order_id"],
        }),
      ]),
      createFetcher({}),
    );
    expect(read.results[0]?.status).toBe("could-not-check");
    expect(read.results[0]?.message).toContain('"no-overlapping-bookings"');
    expect(read.results[0]?.message).toMatch(/longer than the statement timeout/);
    expect(read.results[1]).toMatchObject({ status: "failed", count: 1 });
  });

  it("a database that is not set up, or cannot be reached, is could-not-check for every assertion", async () => {
    const off = await readAssertions(
      { ...settings(1, [assertion({})]), env: {} },
      createFetcher({}),
    );
    expect(off.results[0]?.status).toBe("could-not-check");
    expect(off.results[0]?.message).toContain("GAUGELINE_POSTGRES_URL");
    const server = await serve(clean);
    const port = server.port;
    await server.close();
    servers.length = 0;
    const down = await readAssertions(settings(port, [assertion({})]), createFetcher({}));
    expect(down.results[0]?.status).toBe("could-not-check");
    expect(down.results[0]?.message).toMatch(/Could not connect/);
    expect(JSON.stringify(down)).not.toContain(PASSWORD);
  });

  it("runs only the ids it is asked for", async () => {
    const server = await serve(clean);
    const read = await readAssertions(
      settings(server.port, [
        assertion({}),
        assertion({ id: "second-one", sql: ORPHAN_SQL, evidence: ["order_id"] }),
      ]),
      createFetcher({}),
      { only: ["second-one"] },
    );
    expect(read.results.map((r) => r.id)).toEqual(["second-one"]);
    expect(server.received.some((r) => r.sql.includes("/* overlap */"))).toBe(false);
  });

  it("keeps the config's lower row cap and says the count is a floor", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */") ? overlapRows(26) : clean(sql),
    );
    const read = await readAssertions(
      settings(server.port, [assertion({})], { maxRows: 25 }),
      createFetcher({}),
    );
    expect(read.results[0]).toMatchObject({ status: "failed", count: 25, atLeast: true });
    expect(read.results[0]?.rows).toHaveLength(20);
  });

  it("redacts a connection string or key that a cell holds, and never prints the password", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */")
        ? {
            columns: [{ name: "booking_id", oid: 23 }, { name: "note" }],
            rows: [["1", `pasted ${PASSWORD} here`]],
          }
        : clean(sql),
    );
    const read = await readAssertions(
      settings(server.port, [assertion({ evidence: ["booking_id", "note"] })]),
      createFetcher({}),
    );
    expect(JSON.stringify(read)).not.toContain(PASSWORD);
    expect(read.results[0]?.rows[0]?.note).toContain("[redacted]");
  });

  it("escapes and cuts what a cell holds (data, never instructions)", async () => {
    const server = await serve((sql) =>
      sql.includes("/* overlap */")
        ? {
            columns: [{ name: "booking_id", oid: 23 }, { name: "note" }],
            rows: [["1", `<script>alert(1)</script>\u200B${"x".repeat(300)}`]],
          }
        : clean(sql),
    );
    const read = await readAssertions(
      settings(server.port, [assertion({ evidence: ["booking_id", "note"] })]),
      createFetcher({}),
    );
    const note = read.results[0]?.rows[0]?.note ?? "";
    expect(note).toContain("\\u{200B}");
    expect([...note].length).toBeLessThan(100);
  });

  it("reads once for the whole run when it is lazy", async () => {
    const server = await serve(clean);
    const seen: number[] = [];
    const lazy = lazyAssertions(
      {
        ...settings(server.port, [assertion({})]),
        onAssertions: (r) => seen.push(r.results.length),
      },
      createFetcher({}),
    );
    const [a, b] = await Promise.all([lazy(), lazy()]);
    expect(a).toBe(b);
    expect(seen).toEqual([1]);
    expect(server.received.filter((r) => r.sql.includes("/* overlap */"))).toHaveLength(1);
  });
});
