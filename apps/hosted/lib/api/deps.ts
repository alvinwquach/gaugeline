/** The API's dependencies for a running server: one pooled connection, opened and checked once. */
import type { ApiDeps } from "./handlers.js";
import { openAgentDatabase } from "./agent-db.js";
import type { Sql } from "./db.js";
import { openDatabase } from "./startup.js";

let shared: Promise<Sql> | undefined;
/** The agent's login: opened once; a refusal is kept for AGENT_RETRY_MS, then tried again. */
let agent: Promise<Sql | undefined> | undefined;
let agentRefusedAt = 0;
export const AGENT_RETRY_MS = 60_000;

/**
 * Opens the database on first use (or at start-up, from instrumentation.ts) and keeps the connection. A
 * failure is not kept: a server whose login skips row-level security is refused again on every request.
 *
 * The agent's login (GAUGELINE_AGENT_DATABASE_URL) is separate: when it is set but refused (a wrong role, a
 * login that skips row-level security, a server that does not answer), only the agent reads are off
 * (`agentUnavailable`, a 503 for an agent's token); uploads and a site's token keep working. The refusal is
 * logged by its code only, never the address.
 */
export async function getDeps(now: () => number = Date.now): Promise<ApiDeps> {
  shared ??= openDatabase(process.env).catch((e: unknown) => {
    // Not kept: a login that was wrong a moment ago may be fixed now. A refused start keeps being refused,
    // because each request tries again and gets the same refusal.
    shared = undefined;
    throw e;
  });
  const sql = await shared;
  if (agent === undefined && now() - agentRefusedAt >= AGENT_RETRY_MS) {
    agent = openAgentDatabase(process.env).catch((e: unknown) => {
      const err = e as { code?: string; name?: string; message?: string };
      const code = /^Refusing to start/.test(err.message ?? "")
        ? "refused"
        : (err.code ?? err.name);
      console.error("agent api: the agent login was not opened:", code ?? "error");
      agent = undefined;
      agentRefusedAt = now();
      throw e;
    });
  }
  if (agent === undefined) return { sql, agentUnavailable: true };
  try {
    const agentSql = await agent;
    return agentSql ? { sql, agentSql } : { sql };
  } catch {
    return { sql, agentUnavailable: true };
  }
}
