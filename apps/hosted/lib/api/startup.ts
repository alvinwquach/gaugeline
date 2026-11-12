/**
 * Opening the API's database connection, once, when the server starts.
 *
 * Two logins, two variables (secrets, server-only):
 *   GAUGELINE_MIGRATE_URL   the owner (the migration role). Only `db:migrate` reads it; the API never does.
 *   GAUGELINE_DATABASE_URL  the app login: a separate role that is not the owner, not a superuser and has
 *                           no BYPASSRLS, NOINHERIT, and a member of service_role (and authenticated) only,
 *                           like Supabase's `authenticator`. Each unit of work SETs ROLE to service_role.
 *
 * The owner skips every row-level security policy, so a server connected as the owner would be a server
 * with no tenancy. connectionSkipsRls() is asked once here, outside any transaction (inside one, after
 * `set local role`, it would answer for the role that was switched to and pass for the wrong reason), and
 * the server refuses to start if the login skips row-level security.
 */
import postgres from "postgres";
import { connectionSkipsRls } from "../../db/audit.js";
import type { Sql } from "./db.js";

export const APP_URL_ENV = "GAUGELINE_DATABASE_URL";

export async function openDatabase(env: Record<string, string | undefined>): Promise<Sql> {
  const url = env[APP_URL_ENV];
  if (!url) throw new Error(`${APP_URL_ENV} is not set: the API has no database to open.`);
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  try {
    if (await connectionSkipsRls(sql))
      throw new Error(
        `Refusing to start: the login in ${APP_URL_ENV} skips row-level security (a superuser, or the owner of the tables). ` +
          "Use the app login there, a separate role that is a member of service_role; the owner's address is for migrations only (GAUGELINE_MIGRATE_URL).",
      );
  } catch (e) {
    await sql.end({ timeout: 1 });
    throw e;
  }
  return sql;
}
