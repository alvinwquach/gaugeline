import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  startFakePostgres,
  type FakePostgres,
  type FakeReply,
} from "../../connectors/postgres/__tests__/fake-postgres.js";
import { localUrl } from "../../connectors/postgres/__tests__/helpers.js";
import { sourcesConfigSchema } from "../../connectors/postgres/config.js";
import { lazyDatabases } from "../../connectors/postgres/read.js";
import type { Env } from "../../connectors/types.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { freshnessConfigSchema } from "../config.js";
import { show } from "../decimal.js";
import { createFreshness } from "../read.js";

const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const PASSWORD = ["hoop", "pw", "0123456789"].join("-");
const NOW = Date.UTC(2026, 10, 10, 12, 0);
const same = (text: string) => text;

const SOURCES = sourcesConfigSchema.parse({
  sources: {
    db: {
      type: "postgres",
      queries: {
        latestSync: "select max(finished_at) as value from sync_runs /* sync */",
        playerPpg: "select slug as key, ppg as value from player_stats /* ppg */",
        teamWins: "select wins as value from standings where team = 'hawks' /* wins */",
      },
    },
  },
});

async function database(
  answers: Record<string, FakeReply>,
): Promise<{ server: FakePostgres; env: Env; queries: string[] }> {
  const queries: string[] = [];
  const server = await startFakePostgres({
    onQuery: (sql) => {
      if (sql.includes("current_user"))
        return {
          columns: [{ name: "role" }, { name: "strong", oid: 16 }],
          rows: [["reader", "f"]],
        };
      queries.push(sql);
      for (const [word, reply] of Object.entries(answers)) if (sql.includes(word)) return reply;
      return undefined;
    },
  });
  servers.push(server);
  return {
    server,
    queries,
    env: { GAUGELINE_POSTGRES_URL: localUrl(server.port, "reader", PASSWORD) },
  };
}

function freshnessOver(env: Env, sanity?: Fetcher) {
  const fetcher = sanity ?? createFetcher({});
  const config = freshnessConfigSchema.parse({
    freshness: [{ page: "/x", forecast: { jsonld: "startDate" } }],
  });
  return createFreshness(
    { config, env: { SANITY_PROJECT_ID: "hoop1234" } },
    {
      fetcher,
      databases: { config: SOURCES, read: lazyDatabases({ config: SOURCES, env }, fetcher) },
      redact: same,
    },
  );
}

function sanityAnswering(result: unknown, status = 200): { fetcher: Fetcher; seen: string[] } {
  const seen: string[] = [];
  const transport: Transport = (url, req) => {
    seen.push(`${req.method} ${url.href}`);
    return Promise.resolve({
      status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(JSON.stringify({ ms: 1, query: "q", result }), "utf8")]),
    });
  };
  return { fetcher: createFetcher({ transport, timeoutMs: 5000 }), seen };
}

describe("freshness sources: the newest sync time", () => {
  it("reads a timestamp from a query, once however many rules ask", async () => {
    const { env, queries } = await database({
      "/* sync */": { columns: [{ name: "value", oid: 1184 }], rows: [["2026-11-10 11:50:00+00"]] },
    });
    const f = freshnessOver(env);
    const a = await f.sourceTime("db:latestSync", NOW);
    const b = await f.sourceTime("db:latestSync", NOW);
    expect(a).toEqual({ ok: true, at: Date.UTC(2026, 10, 10, 11, 50) });
    expect(b).toBe(a);
    expect(queries.filter((q) => q.includes("/* sync */"))).toHaveLength(1);
  });

  it("reads a timestamp with no zone as UTC, and epoch seconds", async () => {
    const { env } = await database({
      "/* sync */": { columns: [{ name: "value" }], rows: [["2026-11-10 11:50:00"]] },
    });
    expect(await freshnessOver(env).sourceTime("db:latestSync", NOW)).toEqual({
      ok: true,
      at: Date.UTC(2026, 10, 10, 11, 50),
    });
    const epoch = await database({
      "/* sync */": { columns: [{ name: "value", oid: 20 }], rows: [["1794311400"]] },
    });
    expect(await freshnessOver(epoch.env).sourceTime("db:latestSync", NOW)).toEqual({
      ok: true,
      at: 1794311400 * 1000,
    });
  });

  it("says why when the answer is not a time", async () => {
    const { env } = await database({
      "/* sync */": { columns: [{ name: "value" }], rows: [["last night"]] },
    });
    const got = await freshnessOver(env).sourceTime("db:latestSync", NOW);
    expect(got).toEqual({
      ok: false,
      reason: expect.stringContaining(
        'db:latestSync gave "last night", which is not a date and time',
      ),
    });
  });

  it("no row, or two, is could not check with the reason", async () => {
    const none = await database({ "/* sync */": { columns: [{ name: "value" }], rows: [] } });
    expect(await freshnessOver(none.env).sourceTime("db:latestSync", NOW)).toEqual({
      ok: false,
      reason: expect.stringContaining("returned no rows; it must return exactly one"),
    });
  });

  it("reads a Sanity document's _updatedAt with one published-only GET", async () => {
    const { fetcher, seen } = sanityAnswering("2026-11-10T11:00:00Z");
    const f = freshnessOver({}, fetcher);
    expect(await f.sourceTime("sanity:siteSettings._updatedAt", NOW)).toEqual({
      ok: true,
      at: Date.UTC(2026, 10, 10, 11, 0),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^GET https:\/\/hoop1234\.api\.sanity\.io\/.*perspective=published/);
  });

  it("a Sanity source with no project id is could not check, naming the variable", async () => {
    const config = freshnessConfigSchema.parse({
      freshness: [{ page: "/x", forecast: { jsonld: "startDate" } }],
    });
    const f = createFreshness({ config, env: {} }, { fetcher: createFetcher({}), redact: same });
    expect(await f.sourceTime("sanity:siteSettings._updatedAt", NOW)).toEqual({
      ok: false,
      reason: expect.stringContaining("SANITY_PROJECT_ID is not set"),
    });
  });

  it("a db: source with no database set up is could not check", async () => {
    const config = freshnessConfigSchema.parse({
      freshness: [{ page: "/x", forecast: { jsonld: "startDate" } }],
    });
    const f = createFreshness({ config, env: {} }, { fetcher: createFetcher({}), redact: same });
    expect(await f.sourceTime("db:latestSync", NOW)).toEqual({
      ok: false,
      reason: expect.stringContaining("no database source is set up"),
    });
  });

  it("an unset connection variable is could not check, and never a pass", async () => {
    const got = await freshnessOver({}).sourceTime("db:latestSync", NOW);
    expect(got.ok).toBe(false);
    expect(got.ok ? "" : got.reason).toMatch(/GAUGELINE_POSTGRES_URL|not set|could not be read/);
  });
});

describe("freshness sources: a figure for a page", () => {
  it("one row is the figure, whichever page asks", async () => {
    const { env } = await database({
      "/* wins */": { columns: [{ name: "value", oid: 23 }], rows: [["41"]] },
    });
    const got = await freshnessOver(env).sourceFigure("db:teamWins", "hawks");
    expect(got.ok && show(got.value)).toBe("41");
  });

  it("many rows: the row whose key is the last part of the page's address", async () => {
    const { env } = await database({
      "/* ppg */": {
        columns: [{ name: "key" }, { name: "value", oid: 1700 }],
        rows: [
          ["jane-example", "27.30"],
          ["sam-sample", "19.1"],
        ],
      },
    });
    const f = freshnessOver(env);
    const a = await f.sourceFigure("db:playerPpg", "sam-sample");
    expect(a.ok && show(a.value)).toBe("19.1");
    const b = await f.sourceFigure("db:playerPpg", "Jane-Example");
    expect(b.ok && show(b.value)).toBe("27.3");
  });

  it("says which key was missing, and what the query must return", async () => {
    const { env } = await database({
      "/* ppg */": {
        columns: [{ name: "key" }, { name: "value" }],
        rows: [["jane-example", "27.3"]],
      },
    });
    const missing = await freshnessOver(env).sourceFigure("db:playerPpg", "nobody");
    expect(missing).toEqual({
      ok: false,
      reason: expect.stringContaining('has no row whose key is "nobody"'),
    });
    const bare = await database({
      "/* ppg */": {
        columns: [{ name: "slug" }, { name: "ppg" }],
        rows: [
          ["a", "1"],
          ["b", "2"],
        ],
      },
    });
    const got = await freshnessOver(bare.env).sourceFigure("db:playerPpg", "a");
    expect(got.ok ? "" : got.reason).toContain('columns named "key" and "value"');
  });

  it("a value that is not a number is could not check, quoting it safely", async () => {
    const { env } = await database({
      "/* wins */": { columns: [{ name: "value" }], rows: [["n/a"]] },
    });
    const got = await freshnessOver(env).sourceFigure("db:teamWins", "x");
    expect(got).toEqual({ ok: false, reason: 'db:teamWins gave "n/a", which is not a number.' });
  });

  it("never prints the connection string or its password", async () => {
    const { env, server } = await database({
      "/* wins */": { columns: [{ name: "value" }], rows: [] },
    });
    const got = await freshnessOver(env).sourceFigure("db:teamWins", "x");
    const text = JSON.stringify(got);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(String(server.port) + "/bar");
  });
});
