/**
 * How the web app reaches the database. Two rules, both from the G34 review:
 *
 *  1. The login is the app's own role (GAUGELINE_DATABASE_URL), never the table owner and never a
 *     superuser: both skip row-level security. connectionSkipsRls() is asked once, at start-up, outside any
 *     transaction, and the app refuses to start if the answer is yes.
 *  2. Every read a signed-in person causes runs in a transaction that starts with
 *     `set local role authenticated` and sets request.jwt.claims to that person's verified claims, so
 *     auth.uid() is theirs and the policies decide what they see. `set local` ends with the transaction, so
 *     the pooled connection is the plain login again afterwards. There is no service connection here: runs
 *     and findings are written by the runs API, not by this app.
 */
import postgres from "postgres";
import { connectionSkipsRls } from "../../db/audit.js";
import type { Claims } from "./auth.js";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export const APP_URL_ENV = "GAUGELINE_DATABASE_URL";
const STATEMENT_TIMEOUT_MS = 10_000;

export async function openAppDatabase(env: Record<string, string | undefined>): Promise<Sql> {
  const url = env[APP_URL_ENV];
  if (!url) throw new Error(`${APP_URL_ENV} is not set: the app has no database to open.`);
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  try {
    if (await connectionSkipsRls(sql))
      throw new Error(
        `Refusing to start: the login in ${APP_URL_ENV} skips row-level security (a superuser, or the owner of the tables). Use the app's own login role there.`,
      );
  } catch (e) {
    await sql.end({ timeout: 1 });
    throw e;
  }
  return sql;
}

/**
 * One transaction as the signed-in person. It commits when `fn` returns. `claims` must come from
 * AuthProvider.verify, never from a request; the transaction checks that the database now sees the same
 * person (auth.uid()) and that the role in effect is `authenticated`.
 */
export async function asUser<T>(sql: Sql, claims: Claims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx.unsafe("set local role authenticated");
    await tx.unsafe(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const who = (await tx`select current_user as role, auth.uid() as uid`)[0];
    if (who?.role !== "authenticated" || who.uid !== claims.sub)
      throw new Error("the database session does not match the signed-in person");
    return fn(tx);
  })) as T;
}
