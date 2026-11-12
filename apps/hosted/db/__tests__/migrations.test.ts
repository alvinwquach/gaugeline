/**
 * Migrations run from empty and from the previous version, run twice without harm, and the Drizzle schema
 * the app queries with matches the tables the SQL files create.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { listMigrations, MIGRATIONS_DIR, migrate } from "../migrate.js";
import * as schema from "../schema.js";
import { tablesWithoutRls } from "../audit.js";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  seed,
  SITE_B1,
  type TestDatabase,
  USER_A_MEMBER,
} from "./harness.js";

describe("listMigrations", () => {
  const dirs: string[] = [];
  const dirWith = (names: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "gl-migrations-"));
    dirs.push(dir);
    for (const n of names) writeFileSync(join(dir, n), "select 1;\n");
    return dir;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  });

  it("orders the repository's migrations by number, starting at 1 with no gaps", () => {
    const list = listMigrations(MIGRATIONS_DIR);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.map((m) => m.version)).toEqual(list.map((_, i) => i + 1));
  });

  it("sorts by number, not by file system order", () => {
    const list = listMigrations(dirWith(["0002_b.sql", "0001_a.sql"]));
    expect(list.map((m) => m.name)).toEqual(["0001_a", "0002_b"]);
  });

  it("refuses a gap, a duplicate number and a badly named SQL file", () => {
    expect(() => listMigrations(dirWith(["0001_a.sql", "0003_c.sql"]))).toThrow(/gap/);
    expect(() => listMigrations(dirWith(["0001_a.sql", "0001_b.sql"]))).toThrow(/twice/);
    expect(() => listMigrations(dirWith(["0001_a.sql", "fix.sql"]))).toThrow(/name/);
  });
});

describe.skipIf(!HAS_DATABASE)("migrations against a real Postgres", () => {
  let db: TestDatabase | undefined;
  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  it("run from empty, and a second run applies nothing", async () => {
    db = await freshDatabase();
    expect(await tablesWithoutRls(db.sql)).toEqual([]);
    expect(await migrate(db.sql, MIGRATIONS_DIR)).toEqual([]);
  });

  it("run from the previous version: data written before the last migration survives, and is fenced after", async () => {
    const all = listMigrations(MIGRATIONS_DIR);
    db = await freshDatabase({ to: all.length - 1 });
    await seed(db.sql);
    const applied = await migrate(db.sql, MIGRATIONS_DIR);
    expect(applied).toEqual([all[all.length - 1]!.name]);
    const counts = await db.sql`select (select count(*)::int from public.findings) as findings,
      (select count(*)::int from public.decisions) as decisions`;
    expect(counts[0]).toEqual({ findings: 2, decisions: 2 });
    const theirs = await as(
      db.sql,
      { role: "authenticated", userId: USER_A_MEMBER },
      (tx) => tx`select id from public.sites where id = ${SITE_B1}`,
    );
    expect(theirs).toHaveLength(0);
    expect(await tablesWithoutRls(db.sql)).toEqual([]);
  });

  it("a failing migration leaves nothing half-applied", async () => {
    db = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), "gl-migrations-"));
    try {
      for (const m of listMigrations(MIGRATIONS_DIR)) {
        writeFileSync(join(dir, `${m.name}.sql`), "select 1;\n");
      }
      const next = String(listMigrations(MIGRATIONS_DIR).length + 1).padStart(4, "0");
      writeFileSync(
        join(dir, `${next}_broken.sql`),
        `create table public.half (id int); select no_such_function();`,
      );
      expect(await errorOf(migrate(db.sql, dir))).toMatch(/no_such_function/);
      const half = await db.sql`select to_regclass('public.half') as t`;
      expect(half[0]!.t).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("the Drizzle schema names the same tables and columns as the SQL migrations", async () => {
    db = await freshDatabase();
    const tables = (Object.values(schema) as unknown[])
      .filter((v): v is PgTable => is(v, PgTable))
      .map((t) => getTableConfig(t));
    const fromDrizzle = Object.fromEntries(
      tables.map((t) => [t.name, t.columns.map((c) => c.name).sort()]),
    );
    const cols = await db.sql`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in (select tablename from pg_tables where schemaname = 'public')`;
    const fromDb: Record<string, string[]> = {};
    for (const r of cols) (fromDb[r.table_name as string] ??= []).push(r.column_name as string);
    for (const k of Object.keys(fromDb)) fromDb[k]!.sort();
    expect(fromDrizzle).toEqual(fromDb);
    for (const t of tables) expect(t.enableRLS, t.name).toBe(true);
  });

  it("the org_id the seed uses is a real organisation (sanity check on the fixtures)", async () => {
    db = await freshDatabase();
    await seed(db.sql);
    const r = await db.sql`select name from public.organisations where org_id = ${ORG_A}`;
    expect(r[0]!.name).toBe("Northgate Studio");
  });
});
