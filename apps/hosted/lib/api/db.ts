/**
 * How the API reaches the database: always as service_role, never as the table owner (the connecting
 * "postgres" role on Supabase), because the owner skips every row-level security policy. The connection
 * may log in as the owner; each unit of work switches to service_role for its transaction only, and
 * checks that it did.
 */
import type postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export const SERVICE_ROLE = "service_role";
const STATEMENT_TIMEOUT_MS = 30_000;

/** Throws unless the transaction runs as service_role. Called at the start of every unit of work. */
export async function assertServiceRole(tx: Tx): Promise<void> {
  const rows = await tx`select current_user as u`;
  if (rows[0]?.u !== SERVICE_ROLE)
    throw new Error(`the API's database access must run as ${SERVICE_ROLE}`);
}

/** One transaction as service_role, with a statement timeout; it commits when `fn` returns. */
export async function withService<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SERVICE_ROLE}`);
    await tx.unsafe(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await assertServiceRole(tx);
    return fn(tx);
  })) as T;
}
