/**
 * The app's database login for the tests: a role that is not the owner, not a superuser, NOINHERIT, and a
 * member of service_role and authenticated only, like Supabase's `authenticator`. The harness's own
 * connection is the owner (it creates the tables); the API under test connects as this role.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { TEST_DATABASE_URL, type Sql } from "../../../db/__tests__/harness.js";

export async function appLogin(
  owner: Sql,
): Promise<{ sql: Sql; url: string; role: string; drop: () => Promise<void> }> {
  const role = `gl_app_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  await owner.unsafe(
    `create role ${role} login noinherit nosuperuser nobypassrls password '${password}';
     grant service_role, authenticated to ${role};`,
  );
  const dbName = (await owner`select current_database() as n`)[0]!.n as string;
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${dbName}`;
  u.username = role;
  u.password = password;
  const sql = postgres(u.href, { max: 4, onnotice: () => {} });
  return {
    sql,
    url: u.href,
    role,
    drop: async () => {
      await sql.end({ timeout: 1 });
      await owner
        .unsafe(`drop owned by ${role}; drop role if exists ${role}`)
        .catch(() => undefined);
    },
  };
}
