/**
 * A small migrator for the plain SQL files in db/migrations (reviewed in the pull request that adds them).
 * Files are named NNNN_description.sql, numbered from 0001 with no gaps; each runs once and is recorded in
 * private.schema_migrations. One run is one transaction: if any file fails, nothing from that run stays.
 * An advisory lock stops two deploys migrating at the same time.
 *
 *   GAUGELINE_DATABASE_URL=postgres://... pnpm --filter @gaugeline/hosted db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export interface Migration {
  version: number;
  /** The file name without ".sql", recorded in private.schema_migrations. */
  name: string;
  file: string;
}

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** The migrations in `dir`, in order. Throws on a badly named .sql file, a repeated number or a gap. */
export function listMigrations(dir: string): Migration[] {
  const list: Migration[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".sql")) continue;
    const m = FILE.exec(f);
    if (!m) throw new Error(`migration file name must look like 0001_description.sql: ${f}`);
    list.push({ version: Number(m[1]), name: f.slice(0, -4), file: join(dir, f) });
  }
  list.sort((a, b) => a.version - b.version);
  list.forEach((m, i) => {
    if (i > 0 && list[i - 1]!.version === m.version)
      throw new Error(`migration number ${m.version} is used twice`);
    if (m.version !== i + 1) throw new Error(`migration numbers have a gap before ${m.name}`);
  });
  return list;
}

/** Any number unlikely to clash with another advisory lock: "gl" "mi" as bytes. */
const LOCK_KEY = 0x676c6d69;

/**
 * Apply the migrations in `dir` that have not run yet, up to and including version `to` when given.
 * Returns the names applied. The connection must be the schema owner (the "postgres" role on Supabase).
 */
export async function migrate(
  sql: postgres.Sql,
  dir: string = MIGRATIONS_DIR,
  options: { to?: number } = {},
): Promise<string[]> {
  const wanted = listMigrations(dir).filter(
    (m) => options.to === undefined || m.version <= options.to,
  );
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx.unsafe(`
      create schema if not exists private;
      revoke all on schema private from public;
      create table if not exists private.schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      );
    `);
    const done = new Set(
      (await tx`select name from private.schema_migrations`).map((r) => r.name as string),
    );
    for (const m of wanted) {
      if (done.has(m.name)) continue;
      await tx.unsafe(readFileSync(m.file, "utf8")).simple();
      await tx`insert into private.schema_migrations (name) values (${m.name})`;
      applied.push(m.name);
    }
  });
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.GAUGELINE_DATABASE_URL;
  if (!url) {
    process.stderr.write("GAUGELINE_DATABASE_URL is not set.\n");
    process.exitCode = 2;
  } else {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    migrate(sql)
      .then((names) => {
        process.stdout.write(names.length ? `applied: ${names.join(", ")}\n` : "up to date\n");
      })
      .catch((e: unknown) => {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      })
      .finally(() => sql.end());
  }
}
