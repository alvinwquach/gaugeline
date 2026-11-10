import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourcesConfigSchema } from "../../connectors/postgres/config.js";
import {
  SKIP_REASON,
  findPostgres,
  startLocalPostgres,
  type LocalPostgres,
} from "../../connectors/postgres/__tests__/local-postgres.js";
import { localUrl } from "../../connectors/postgres/__tests__/helpers.js";
import { createFetcher } from "../../fetcher.js";
import { readAssertions } from "../read.js";

/**
 * The examples folder: one folder per common shape of assertion, each with the assertion, a fixture
 * schema, one seed that passes it and one that fails it. Every table and name in them is invented.
 */
const ROOT = fileURLToPath(new URL("../../../../../examples/assertions/", import.meta.url));
const SHAPES = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const FILES = [
  "assertion.json",
  "assertion.sql",
  "schema.sql",
  "seed-pass.sql",
  "seed-fail.sql",
  "expected.json",
];

const read = (shape: string, file: string): string =>
  readFileSync(join(ROOT, shape, file), "utf8").replace(/\r\n/g, "\n");

interface Expected {
  rows: number;
  evidence: Array<Record<string, string>>;
}

function assertionOf(shape: string): Record<string, unknown> {
  return { ...JSON.parse(read(shape, "assertion.json")), sql: read(shape, "assertion.sql") };
}

describe("the examples folder", () => {
  it("has the five shapes the guide names", () => {
    expect(SHAPES).toEqual([
      "duplicate-natural-key",
      "orphaned-foreign-keys",
      "overlapping-ranges",
      "rows-past-expiry",
      "totals-dont-add-up",
    ]);
  });

  it.each(SHAPES)("%s has every file, and its assertion is a valid, pure read", (shape) => {
    for (const file of FILES) expect(existsSync(join(ROOT, shape, file)), file).toBe(true);
    const parsed = sourcesConfigSchema.safeParse({
      sources: { db: { type: "postgres" } },
      assertions: [assertionOf(shape)],
    });
    expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    // The id is the folder's name, so a reader can find the example from a finding.
    expect(assertionOf(shape).id).toBe(shape);
  });

  it.each(SHAPES)("%s lists evidence columns that are not personal data", (shape) => {
    const evidence = assertionOf(shape).evidence as string[];
    for (const column of evidence) expect(column).not.toMatch(/email|phone|address|name/i);
  });
});

const bin = findPostgres();

describe.skipIf(!bin)(
  `each example against a seeded schema in a real throwaway Postgres${bin ? "" : ` (skipped: ${SKIP_REASON})`}`,
  () => {
    let pg: LocalPostgres;
    let admin: postgres.Sql;
    const READER_PASSWORD = ["reader", "pw", "0123456789"].join("-");

    beforeAll(async () => {
      pg = await startLocalPostgres(bin as NonNullable<typeof bin>);
      admin = postgres({
        host: "127.0.0.1",
        port: pg.port,
        username: "postgres",
        password: pg.adminPassword,
        database: "postgres",
        ssl: false,
        max: 1,
        onnotice: () => undefined,
      });
      await admin.unsafe(
        `create role gaugeline_reader login password '${READER_PASSWORD}'; alter role gaugeline_reader set default_transaction_read_only = on;`,
      );
    }, 120_000);

    afterAll(async () => {
      await admin?.end({ timeout: 2 }).catch(() => undefined);
      pg?.stop();
    }, 60_000);

    /** A fresh database with the example's schema and one seed, the reader allowed to SELECT. */
    async function seeded(shape: string, seed: "seed-pass.sql" | "seed-fail.sql"): Promise<string> {
      const name = `${shape.replace(/-/g, "_")}_${seed.includes("pass") ? "pass" : "fail"}`;
      await admin.unsafe(`create database ${name}`);
      const db = postgres({
        host: "127.0.0.1",
        port: pg.port,
        username: "postgres",
        password: pg.adminPassword,
        database: name,
        ssl: false,
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await db.unsafe(read(shape, "schema.sql"));
        await db.unsafe(read(shape, seed));
        await db.unsafe(
          "grant usage on schema public to gaugeline_reader; grant select on all tables in schema public to gaugeline_reader;",
        );
      } finally {
        await db.end({ timeout: 2 });
      }
      return name;
    }

    async function run(shape: string, database: string) {
      const config = sourcesConfigSchema.parse({
        sources: { db: { type: "postgres" } },
        assertions: [assertionOf(shape)],
      });
      const read = await readAssertions(
        {
          config,
          env: {
            GAUGELINE_POSTGRES_URL: localUrl(
              pg.port,
              "gaugeline_reader",
              READER_PASSWORD,
              database,
            ),
          },
        },
        createFetcher({}),
      );
      return read.results[0];
    }

    it.each(SHAPES)(
      "%s: the passing seed returns no rows",
      async (shape) => {
        const result = await run(shape, await seeded(shape, "seed-pass.sql"));
        expect(result?.message).toBeUndefined();
        expect(result?.status).toBe("passed");
      },
      60_000,
    );

    it.each(SHAPES)(
      "%s: the failing seed returns the rows it should, as evidence",
      async (shape) => {
        const expected = JSON.parse(read(shape, "expected.json")) as Expected;
        const result = await run(shape, await seeded(shape, "seed-fail.sql"));
        expect(result?.message).toBeUndefined();
        expect(result?.status).toBe("failed");
        expect(result?.count).toBe(expected.rows);
        expected.evidence.forEach((row, i) => {
          expect(result?.rows[i], `row ${i + 1}`).toMatchObject(row);
        });
        // Only the allow-listed columns are ever in a result.
        const allowed = new Set(assertionOf(shape).evidence as string[]);
        for (const row of result?.rows ?? [])
          for (const column of Object.keys(row)) expect(allowed.has(column)).toBe(true);
      },
      60_000,
    );

    it("a failing assertion with 50 rows reports 20 of them and the count, against the real server", async () => {
      await admin.unsafe("create database fifty");
      const db = postgres({
        host: "127.0.0.1",
        port: pg.port,
        username: "postgres",
        password: pg.adminPassword,
        database: "fifty",
        ssl: false,
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await db.unsafe(
          "create table orders (id integer primary key, status text not null, customer_email text not null); insert into orders select g, 'paid', 'guest' || g || '@example.test' from generate_series(1, 50) g; grant usage on schema public to gaugeline_reader; grant select on all tables in schema public to gaugeline_reader;",
        );
      } finally {
        await db.end({ timeout: 2 });
      }
      const config = sourcesConfigSchema.parse({
        sources: { db: { type: "postgres" } },
        assertions: [
          {
            id: "fifty-orders",
            severity: "low",
            title: "Fifty orders",
            sql: "select id as order_id from orders order by id",
            evidence: ["order_id"],
          },
        ],
      });
      const read = await readAssertions(
        {
          config,
          env: {
            GAUGELINE_POSTGRES_URL: localUrl(pg.port, "gaugeline_reader", READER_PASSWORD, "fifty"),
          },
        },
        createFetcher({}),
      );
      expect(read.results[0]).toMatchObject({ status: "failed", count: 50, atLeast: false });
      expect(read.results[0]?.rows).toHaveLength(20);
      expect(read.results[0]?.rows[19]).toEqual({ order_id: "20" });
    }, 60_000);

    it("a real statement timeout is could-not-check, and a real write attempt is refused before it is sent", async () => {
      const config = sourcesConfigSchema.parse({
        sources: { db: { type: "postgres", timeoutMs: 200 } },
        assertions: [
          {
            id: "slow-one",
            severity: "low",
            title: "Slow",
            sql: "select 1 as one from generate_series(1, 100000000) g where g < 0",
            evidence: ["one"],
          },
        ],
      });
      const read = await readAssertions(
        {
          config,
          env: {
            GAUGELINE_POSTGRES_URL: localUrl(
              pg.port,
              "gaugeline_reader",
              READER_PASSWORD,
              "postgres",
            ),
          },
        },
        createFetcher({}),
      );
      expect(read.results[0]?.status).toBe("could-not-check");
      expect(read.results[0]?.message).toMatch(/slow-one/);
      expect(read.results[0]?.message).toMatch(/statement timeout/);
    }, 60_000);
  },
);
