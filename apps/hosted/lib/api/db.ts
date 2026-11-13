/**
 * How the API reaches the database: as service_role, never as the table owner (the "postgres" role on
 * Supabase), because the owner skips every row-level security policy. The connection logs in as a separate
 * app role (startup.ts refuses to start otherwise); each unit of work switches to service_role for its
 * transaction only (`set local role`, which ends with the transaction), and checks that it did. A registered
 * agent's reads (AG-08) run on the agent's own login as gaugeline_agent instead (withAgent). Nothing in
 * lib/api issues `reset role` or `set session authorization`; a test scans for both.
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

export const AGENT_ROLE = "gaugeline_agent";
const AGENT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * One transaction as gaugeline_agent on the agent's own login (agent-db.ts), with a statement timeout;
 * checked before `fn` runs. The role holds no table: it may only run the agent's private functions.
 */
export async function withAgent<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${AGENT_ROLE}`);
    await tx.unsafe(`set local statement_timeout = ${AGENT_STATEMENT_TIMEOUT_MS}`);
    const [r] = await tx`select current_user as u`;
    if (r?.u !== AGENT_ROLE) throw new Error(`the agent's reads must run as ${AGENT_ROLE}`);
    return fn(tx);
  })) as T;
}
