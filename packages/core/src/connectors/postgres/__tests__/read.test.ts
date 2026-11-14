import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../../fetcher.js";
import { sourcesConfigSchema } from "../config.js";
import { databaseEnvVars, lazyDatabases, readDatabases } from "../read.js";
import { startFakePostgres, type FakePostgres } from "./fake-postgres.js";
import { localUrl } from "./helpers.js";

const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const config = sourcesConfigSchema.parse({
  sources: {
    db: {
      type: "postgres",
      queries: {
        prices: {
          sql: "select name, cents from items",
          fact: { kind: "price", item: "name", value: "cents" },
        },
        gone: "select name from items where gone",
      },
    },
  },
});

describe("readDatabases", () => {
  it("reads every named query once per run, maps the facts, and shares the read between checks", async () => {
    const server = await startFakePostgres({
      onQuery: (sql) =>
        sql.startsWith("select name, cents")
          ? {
              columns: [{ name: "name" }, { name: "cents", oid: 23 }],
              rows: [
                ["Mezcal Mule", "1250"],
                ["Paloma", null],
              ],
            }
          : sql.startsWith("select name from items")
            ? { columns: [{ name: "name" }], rows: [["Negroni"]] }
            : undefined,
    });
    servers.push(server);
    const settings = { config, env: { GAUGELINE_POSTGRES_URL: localUrl(server.port) } };
    const read = lazyDatabases(settings, createFetcher({}));
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toBe(b);
    expect(a.queries.map((q) => `${q.source}.${q.query}:${q.status}`)).toEqual([
      "db.prices:ok",
      "db.gone:ok",
    ]);
    expect(a.byName.get("db.gone")?.rows).toEqual([{ name: "Negroni" }]);
    expect(a.facts).toEqual([
      { id: "db.prices.1", kind: "price", item: "Mezcal Mule", value: "$12.50" },
    ]);
    expect(a.notices).toEqual([
      expect.objectContaining({
        kind: "advice",
        message: expect.stringContaining('1 row of "prices" could not become a fact'),
      }),
    ]);
    // The second call used the first read: the server saw each query once.
    expect(
      server.received.filter((r) => r.sql === "select name from items where gone"),
    ).toHaveLength(1);
  });

  it("with the variable unset it says what to set and connects to nothing", async () => {
    const read = await readDatabases({ config, env: {} }, createFetcher({}));
    expect(read.queries).toEqual([]);
    expect(read.notices).toEqual([
      expect.objectContaining({
        kind: "not-configured",
        message: expect.stringContaining("GAUGELINE_POSTGRES_URL"),
      }),
    ]);
  });

  it("does not read anything until a check asks", async () => {
    const server = await startFakePostgres();
    servers.push(server);
    lazyDatabases(
      { config, env: { GAUGELINE_POSTGRES_URL: localUrl(server.port) } },
      createFetcher({}),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(server.received).toEqual([]);
    expect(server.startup).toEqual({});
  });

  it("names the variables the CLI must copy", () => {
    expect(databaseEnvVars(config)).toEqual(["GAUGELINE_POSTGRES_URL"]);
  });

  it("two sources are read at the same time, and one failing leaves the other's rows", async () => {
    const server = await startFakePostgres({
      onQuery: () => ({ columns: [{ name: "n", oid: 23 }], rows: [["1"]] }),
    });
    servers.push(server);
    const two = sourcesConfigSchema.parse({
      sources: {
        up: { type: "postgres", env: "UP_DB", queries: { q: "select 1 as n" } },
        down: { type: "postgres", env: "DOWN_DB", queries: { q: "select 1 as n" } },
      },
    });
    const read = await readDatabases(
      {
        config: two,
        env: {
          UP_DB: localUrl(server.port),
          DOWN_DB: "postgres://r:x@127.0.0.1:1/d?sslmode=disable",
        },
      },
      createFetcher({}),
    );
    expect(read.queries.map((q) => `${q.source}.${q.query}`)).toEqual(["up.q"]);
    expect(read.notices.filter((n) => n.kind !== "advice")).toEqual([
      expect.objectContaining({ connector: "db:down", kind: "unreachable" }),
    ]);
  });
});
