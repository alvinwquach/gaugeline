import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadOnlySession } from "../session.js";
import { parseConnectionString } from "../url.js";
import { DB_VAR, localUrl, runSource, source } from "./helpers.js";
import {
  SKIP_REASON,
  findPostgres,
  startLocalPostgres,
  type LocalPostgres,
} from "./local-postgres.js";

const bin = findPostgres();
const docs = readFileSync(
  fileURLToPath(new URL("../../../../../../docs/connectors/postgres.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** The SQL block the docs page shows under a title, so the page and the test cannot drift. */
function docSql(title: string): string {
  const m = new RegExp('```sql title="?' + title + '"?\\n([\\s\\S]*?)\\n```').exec(docs);
  if (!m) throw new Error(`docs/connectors/postgres.md has no sql block titled ${title}`);
  return m[1] as string;
}

const READER_PASSWORD = ["reader", "pw", "0123456789"].join("-");

describe.skipIf(!bin)(
  `against a real throwaway Postgres server${bin ? "" : ` (skipped: ${SKIP_REASON})`}`,
  () => {
    let pg: LocalPostgres;
    let admin: postgres.Sql;

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
      await admin.unsafe(`
        create table menu_items (id serial primary key, name text not null, is_86 boolean not null default false, price_cents integer not null);
        insert into menu_items (name, is_86, price_cents) values ('Negroni', true, 1400), ('Old Fashioned', false, 1500), ('Paloma', true, 1300), ('Mezcal Mule', false, 1250);
        create table bookings (id serial primary key, name text, party_size integer, booked_for timestamptz);
        insert into bookings (name, party_size, booked_for) values ('Ada', 4, '2026-12-05 19:30:00+00'), ('Grace', 12, '2026-12-06 21:00:00+00');
        create sequence ticket_numbers;
      `);
      await admin.unsafe(
        docSql("Read-only role").replace("choose-a-long-password", READER_PASSWORD),
      );
    }, 120_000);

    afterAll(async () => {
      await admin?.end({ timeout: 2 }).catch(() => undefined);
      pg?.stop();
    }, 60_000);

    const url = (user = "gaugeline_reader", password = READER_PASSWORD): string =>
      localUrl(pg.port, user, password, "postgres");
    const reader = (): ReadOnlySession => {
      const parsed = parseConnectionString(url(), {});
      if (!parsed.ok) throw new Error("setup");
      return new ReadOnlySession(parsed.value);
    };
    const count = async (table: string): Promise<number> =>
      Number(
        (
          (await admin.unsafe(`select count(*) as n from ${table}`)) as unknown as Array<{
            n: string;
          }>
        )[0]?.n,
      );

    it("a SELECT returns rows, typed as plain data", async () => {
      const { results } = await runSource(
        source({
          type: "postgres",
          queries: {
            eightySixed: "select name from menu_items where is_86 = true order by id",
            bookings: "select name, party_size, booked_for from bookings order by id",
          },
        }),
        { [DB_VAR]: url() },
      );
      expect(results[0]).toMatchObject({
        status: "ok",
        columns: ["name"],
        rows: [{ name: "Negroni" }, { name: "Paloma" }],
        truncated: false,
      });
      expect(results[1]?.rows).toEqual([
        { name: "Ada", party_size: 4, booked_for: "2026-12-05T19:30:00.000Z" },
        { name: "Grace", party_size: 12, booked_for: "2026-12-06T21:00:00.000Z" },
      ]);
    });

    it("an UPDATE smuggled in a CTE is refused before it is sent: the server's own log never sees it, and nothing changes", async () => {
      const smuggled =
        "with u as (update menu_items set is_86 = false returning 1) select count(*) from u";
      const { results } = await runSource(
        source({
          type: "postgres",
          queries: { smuggled, plain: "select count(*) as n from menu_items" },
        }),
        { [DB_VAR]: url() },
      );
      expect(results[0]?.status).toBe("could-not-check");
      expect(results[1]?.rows).toEqual([{ n: "4" }]);
      expect(pg.log()).not.toContain("update menu_items");
      expect(await count("menu_items where is_86")).toBe(2);
    });

    it("every write is refused by the database inside the read-only transaction, as the reader and as the superuser, even when the classifier is bypassed", async () => {
      const attempts = [
        "update menu_items set is_86 = false",
        "delete from bookings",
        "insert into bookings (name) values ('x')",
        "truncate bookings",
        "create table sneaky (id int)",
        "drop table bookings",
        "select nextval('ticket_numbers')",
        "with d as (delete from bookings returning 1) select * from d",
      ];
      const parsedAdmin = parseConnectionString(url("postgres", pg.adminPassword), {});
      if (!parsedAdmin.ok) throw new Error("setup");
      for (const session of [reader(), new ReadOnlySession(parsedAdmin.value)]) {
        for (const sql of attempts) {
          await expect(
            session.runUnchecked(sql, { statementTimeoutMs: 2000, maxRows: 10 }),
            sql,
          ).rejects.toMatchObject({ code: expect.stringMatching(/^(25006|42501)$/) });
        }
        await session.close();
      }
      expect(await count("bookings")).toBe(2);
      expect(await count("menu_items where is_86")).toBe(2);
      const tables = (await admin.unsafe(
        "select tablename from pg_tables where schemaname = 'public'",
      )) as unknown as Array<{ tablename: string }>;
      expect(tables.map((t) => t.tablename).sort()).toEqual(["bookings", "menu_items"]);
    });

    it("the server accepts one statement only, so a second one cannot ride along even if it got past the classifier", async () => {
      const session = reader();
      await expect(
        session.runUnchecked("select 1; select 2", { statementTimeoutMs: 2000, maxRows: 10 }),
      ).rejects.toMatchObject({ code: "42601" });
      await session.close();
    });

    // FIX-1. This test used to run "select count(*) from generate_series(1, 100000000000)" and wait for the
    // server's 300 ms statement timeout. That query is a bad way to be slow: Postgres plans JIT for it
    // (compiling cannot be cancelled) and writes its rows to a temp file until the cancel arrives, so how
    // soon the cancel took effect depended on the CPU and the disk of the machine. On a loaded Ubuntu runner
    // the client's deadline (the 10 s slack) fired first and the message was "did not answer in time" instead
    // of the server's. Now the query waits on a lock that this test holds: it uses no CPU, no disk and no
    // JIT, it is slow for exactly as long as the test says, and only the statement timeout can end it. The
    // client's side of the same race (a slow connection using up the deadline) is tested in readonly.test.ts.
    it("statement_timeout stops a slow query; the run goes on with could-not-check and the next query", async () => {
      await admin.unsafe("create table gate (id int)");
      try {
        await admin.unsafe("grant select on gate to gaugeline_reader");
        await admin.begin(async (tx) => {
          // Held until this callback returns, so "slow" cannot finish before the statement timeout.
          await tx.unsafe("lock table gate in access exclusive mode");
          const { results, run } = await runSource(
            source({
              type: "postgres",
              timeoutMs: 300,
              queries: { slow: "select count(*) from gate", fast: "select 1 as one" },
            }),
            { [DB_VAR]: url() },
          );
          expect(results[0]).toMatchObject({ status: "could-not-check" });
          expect(results[0]?.message).toMatch(/longer than the statement timeout/);
          expect(results[1]).toMatchObject({ status: "ok", rows: [{ one: 1 }] });
          expect(run.notices.filter((n) => n.kind !== "advice")).toEqual([]);
        });
      } finally {
        await admin.unsafe("drop table if exists gate");
      }
    });

    it("6,000 rows are cut at 5,000 with a notice, and the connection is still usable afterwards", async () => {
      const { results, run } = await runSource(
        source({
          type: "postgres",
          queries: { many: "select g from generate_series(1, 6000) g", after: "select 2 as two" },
        }),
        { [DB_VAR]: url() },
      );
      expect(results[0]?.rows).toHaveLength(5000);
      expect(results[0]).toMatchObject({ truncated: true, status: "ok" });
      expect(results[1]).toMatchObject({ status: "ok", rows: [{ two: 2 }] });
      expect(run.notices).toContainEqual(
        expect.objectContaining({
          kind: "advice",
          message: expect.stringContaining("only the first 5,000"),
        }),
      );
    });

    it("a trailing comment or semicolon does not break the query", async () => {
      const { results } = await runSource(
        source({
          type: "postgres",
          queries: { a: "select 1 as n -- last", b: "select 2 as n;", c: "select 3 as n; -- done" },
        }),
        { [DB_VAR]: url() },
      );
      expect(results.map((r) => r.rows[0])).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it("a wrong password is a plain message that does not contain the password", async () => {
      const wrong = ["wrong", "pw", "9876543210"].join("-");
      const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
        [DB_VAR]: url("gaugeline_reader", wrong),
      });
      expect(run.notices[0]?.message).toMatch(/refused the user name or password/);
      expect(JSON.stringify(run.notices)).not.toContain(wrong);
    });

    it("asking for TLS from a server without it is a plain message that says what to change", async () => {
      const { run } = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
        [DB_VAR]: url().replace("sslmode=disable", "sslmode=require"),
      });
      expect(run.notices[0]?.message).toMatch(/encrypted one was being set up.*sslmode=disable/);
    });

    it("a permission the role lacks is could-not-check with the fix", async () => {
      await admin.unsafe("create table secrets (note text); insert into secrets values ('x')");
      const { results } = await runSource(
        source({ type: "postgres", queries: { s: "select note from secrets" } }),
        { [DB_VAR]: url() },
      );
      expect(results[0]?.status).toBe("could-not-check");
      expect(results[0]?.message).toMatch(/not allowed to read.*Grant SELECT/);
    });

    it("advises when the role can write, and stays quiet for the documented read-only role", async () => {
      const strong = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
        [DB_VAR]: url("postgres", pg.adminPassword),
      });
      expect(strong.run.notices.filter((n) => n.kind === "advice")).toHaveLength(1);
      const weak = await runSource(source({ type: "postgres", queries: { q: "select 1" } }), {
        [DB_VAR]: url(),
      });
      expect(weak.run.notices.filter((n) => n.kind === "advice")).toEqual([]);
    });

    it("the documented role cannot write even without the read-only transaction (layer 3 on its own)", async () => {
      const direct = postgres({
        host: "127.0.0.1",
        port: pg.port,
        username: "gaugeline_reader",
        password: READER_PASSWORD,
        database: "postgres",
        ssl: false,
        max: 1,
        onnotice: () => undefined,
      });
      try {
        // A plain connection, no BEGIN READ ONLY: the role's own settings stop the write.
        await expect(direct.unsafe("update menu_items set is_86 = false")).rejects.toMatchObject({
          code: expect.stringMatching(/^(25006|42501)$/),
        });
        await expect(direct.unsafe("create table x (id int)")).rejects.toMatchObject({
          code: expect.stringMatching(/^(25006|42501)$/),
        });
      } finally {
        await direct.end({ timeout: 2 });
      }
    });
  },
);

describe.skipIf(bin)("without a Postgres server program", () => {
  it(`says why the real-server tests are skipped`, () => {
    expect(SKIP_REASON).toMatch(/skipped/);
  });
});
