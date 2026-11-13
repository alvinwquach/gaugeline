/** The API's dependencies for a running server: one pooled connection, opened and checked once. */
import type { ApiDeps } from "./handlers.js";
import { openAgentDatabase } from "./agent-db.js";
import { openDatabase } from "./startup.js";

let shared: Promise<ApiDeps> | undefined;

/**
 * Opens the database on first use (or at start-up, from instrumentation.ts) and keeps the connection. A
 * failure is not kept: a server whose login skips row-level security is refused again on every request.
 */
export function getDeps(): Promise<ApiDeps> {
  shared ??= openDatabase(process.env)
    .then(async (sql) => {
      try {
        const agentSql = await openAgentDatabase(process.env);
        return agentSql ? { sql, agentSql } : { sql };
      } catch (e) {
        await sql.end({ timeout: 1 });
        throw e;
      }
    })
    .catch((e: unknown) => {
      // Not kept: a login that was wrong a moment ago may be fixed now. A refused start keeps being refused,
      // because each request tries again and gets the same refusal.
      shared = undefined;
      throw e;
    });
  return shared;
}
