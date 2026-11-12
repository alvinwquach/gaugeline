/**
 * Test harness for the hosted database: a fresh Postgres database per test file, the Supabase stand-in,
 * the migrations, two invented organisations, and a way to run queries as a given user and role.
 *
 * The integration tests need a real Postgres server. They run when GAUGELINE_TEST_DATABASE_URL points at
 * one as a superuser (the "hosted database" CI job starts a postgres service container for that), and
 * are skipped otherwise, so the required test matrix (Windows and macOS included) does not need a server.
 * Set GAUGELINE_REQUIRE_TEST_DATABASE=1 to turn a missing URL into a failure instead of a skip.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { MIGRATIONS_DIR, migrate } from "../migrate.js";

export const TEST_DATABASE_URL = process.env.GAUGELINE_TEST_DATABASE_URL ?? "";
export const HAS_DATABASE = TEST_DATABASE_URL !== "";

if (!HAS_DATABASE && process.env.GAUGELINE_REQUIRE_TEST_DATABASE === "1") {
  throw new Error(
    "GAUGELINE_REQUIRE_TEST_DATABASE=1 but GAUGELINE_TEST_DATABASE_URL is not set: the hosted database tests cannot run.",
  );
}

export type Sql = postgres.Sql;

const STAND_IN = fileURLToPath(new URL("../stand-in/supabase-auth.sql", import.meta.url));

export interface TestDatabase {
  /** A superuser connection to the fresh database (the migration owner, like "postgres" on Supabase). */
  sql: Sql;
  /** The database's connection URL as the superuser; swap the user to connect as another login. */
  url: string;
  /** Drop the database and close the connection. */
  drop: () => Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.href;
}

/** A new, empty database on the test server with the Supabase stand-in applied; migrations up to `to`. */
export async function freshDatabase(options: { to?: number } = {}): Promise<TestDatabase> {
  const name = `gl_hosted_${randomBytes(6).toString("hex")}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const sql = postgres(withDatabase(TEST_DATABASE_URL, name), { max: 4, onnotice: () => {} });
  await applyStandIn(sql);
  if (options.to === undefined || options.to > 0) await migrate(sql, MIGRATIONS_DIR, options);
  return {
    sql,
    url: withDatabase(TEST_DATABASE_URL, name),
    drop: async () => {
      await sql.end();
      const a = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export async function applyStandIn(sql: Sql): Promise<void> {
  await sql.unsafe(readFileSync(STAND_IN, "utf8")).simple();
}

export type DbRole = "anon" | "authenticated" | "service_role";

class Rollback extends Error {}

/**
 * Run `fn` in a transaction as `role`, with the request claims Supabase would set for `userId`, then roll
 * back, so every test starts from the seed. An error thrown by a statement rejects the promise.
 */
export async function as<T>(
  sql: Sql,
  who: { role: DbRole; userId?: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  try {
    await sql.begin(async (tx) => {
      const claims = JSON.stringify({ role: who.role, ...(who.userId ? { sub: who.userId } : {}) });
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      await tx.unsafe(`set local role ${who.role}`);
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out as T;
}

/** Run `fn` in a transaction as the connecting (superuser) role, then roll it back. */
export async function rolledBack(
  sql: Sql,
  fn: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

/** The error message of a rejected promise, or "" when it resolved. */
export async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Invented organisations, people and sites (rule 12): two agencies, their client sites, a client viewer
// and one person who works for both agencies.
export const ORG_A = "0a000000-0000-4000-8000-00000000000a";
export const ORG_B = "0b000000-0000-4000-8000-00000000000b";
export const SITE_A1 = "a1000000-0000-4000-8000-0000000000a1"; // a cocktail bar
export const SITE_A2 = "a2000000-0000-4000-8000-0000000000a2"; // a weekend pop-up kitchen
export const SITE_B1 = "b1000000-0000-4000-8000-0000000000b1"; // a physiotherapy clinic
export const RUN_A1 = "a1a10000-0000-4000-8000-0000000000a1";
export const RUN_B1 = "b1b10000-0000-4000-8000-0000000000b1";
export const DRAFT_A1 = "a1d10000-0000-4000-8000-0000000000a1";
export const DRAFT_B1 = "b1d10000-0000-4000-8000-0000000000b1";
export const USER_A_OWNER = "11111111-0000-4000-8000-000000000001";
export const USER_A_MEMBER = "11111111-0000-4000-8000-000000000002";
export const USER_B_OWNER = "22222222-0000-4000-8000-000000000001";
export const USER_A_CLIENT = "33333333-0000-4000-8000-000000000001"; // client viewer of SITE_A1 only
export const USER_BOTH = "44444444-0000-4000-8000-000000000001"; // member of A and of B

/** Seed two organisations as the migration owner (bypasses RLS, like the service that creates them). */
export async function seed(sql: Sql): Promise<void> {
  await sql.unsafe(`
    insert into public.organisations (org_id, name) values
      ('${ORG_A}', 'Northgate Studio'), ('${ORG_B}', 'Brightfield Web');
    insert into public.sites (id, org_id, name, url, timezone) values
      ('${SITE_A1}', '${ORG_A}', 'The Tidewater Bar', 'https://tidewater-bar.test', 'Europe/London'),
      ('${SITE_A2}', '${ORG_A}', 'Juniper Pop-up Kitchen', 'https://juniper-popup.test', 'Europe/London'),
      ('${SITE_B1}', '${ORG_B}', 'Maple Street Physio', 'https://maple-physio.test', 'America/Toronto');
    insert into public.members (org_id, user_id, role, site_id) values
      ('${ORG_A}', '${USER_A_OWNER}', 'owner', null),
      ('${ORG_A}', '${USER_A_MEMBER}', 'member', null),
      ('${ORG_A}', '${USER_A_CLIENT}', 'client', '${SITE_A1}'),
      ('${ORG_A}', '${USER_BOTH}', 'member', null),
      ('${ORG_B}', '${USER_B_OWNER}', 'owner', null),
      ('${ORG_B}', '${USER_BOTH}', 'admin', null);
    insert into public.runs (id, org_id, site_id, started_at, finished_at, summary) values
      ('${RUN_A1}', '${ORG_A}', '${SITE_A1}', '2026-11-10T03:00:00Z', '2026-11-10T03:01:10Z', '{"high":1,"medium":0,"low":0}'),
      ('${RUN_B1}', '${ORG_B}', '${SITE_B1}', '2026-11-10T08:00:00Z', '2026-11-10T08:00:40Z', '{"high":0,"medium":1,"low":0}');
    insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint) values
      ('${ORG_A}', '${SITE_A1}', '${RUN_A1}', 'broken-links', 'high', 'Broken link on the menu page', '/menu links to /drinks-2025 (404)', 'https://tidewater-bar.test/menu', '0123456789abcdef'),
      ('${ORG_B}', '${SITE_B1}', '${RUN_B1}', 'canonical-missing', 'medium', 'No canonical address', '/book has no canonical link', 'https://maple-physio.test/book', 'fedcba9876543210');
    insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids) values
      ('${DRAFT_A1}', '${ORG_A}', '${SITE_A1}', 'email', '{"subject":"Your menu link is fixed","body":"The drinks page is back."}', '{}'),
      ('${DRAFT_B1}', '${ORG_B}', '${SITE_B1}', 'email', '{"subject":"Booking page canonical","body":"We added the canonical address."}', '{}');
    insert into public.decisions (org_id, draft_id, decision, decided_by) values
      ('${ORG_A}', '${DRAFT_A1}', 'approved', '${USER_A_OWNER}'),
      ('${ORG_B}', '${DRAFT_B1}', 'declined', '${USER_B_OWNER}');
    insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by) values
      ('${ORG_A}', '${SITE_A1}', 'granted', '2026-11-12', '${USER_A_OWNER}');
  `);
}
