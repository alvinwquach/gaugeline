import type { Fetcher } from "../../fetcher.js";
import { isConfigured } from "../env.js";
import { createRedactor } from "../redact.js";
import type { Connector, Env } from "../types.js";
import { classifyStatement } from "./classify.js";
import {
  MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  connectionVar,
  keyVar,
  queryParts,
  type SourceConfig,
} from "./config.js";
import { DatabaseError, describeFailure, type Failure } from "./failure.js";
import { checkSupabaseKey } from "./key.js";
import { ReadOnlySession, type ResultRow } from "./session.js";
import { parseConnectionString, redactorFor } from "./url.js";

/** What one named query gave. A query that could not run says why; it never counts as a pass. */
export interface DatabaseQueryResult {
  /** The source's name in the config ("db"). */
  source: string;
  /** The query's name in the config ("eightySixed"). */
  query: string;
  status: "ok" | "could-not-check";
  columns: string[];
  rows: ResultRow[];
  /** True when there were more rows than were kept. */
  truncated: boolean;
  /** Why it could not be checked, or the truncation notice. */
  message?: string;
}

/** Roles whose connection bypasses row-level security or administers the project. */
const REFUSED_DB_USERS = new Set([
  "service_role",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "postgres",
]);

/** Whether a Supabase pooler user ("postgres.abcdefgh") names one of the refused roles. */
function refusedSupabaseUser(user: string): string | undefined {
  const role = user.toLowerCase().split(".")[0] ?? "";
  return REFUSED_DB_USERS.has(role) ? role : undefined;
}

const ROLE_ADVICE =
  "Create a role that can only SELECT what the named queries read, and put its connection string in the variable (docs/connectors/postgres).";

const fail = (failure: Failure): never => {
  throw new DatabaseError(failure);
};

export interface DatabaseConnector extends Connector<DatabaseQueryResult> {
  /** Close nothing is needed between runs; kept for tests that hold a session open. */
  readonly sourceName: string;
}

function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * A source from gaugeline.sources.json as a G23 connector. One instance serves one run: it holds
 * the notices of that run (a truncated result, a role with more power than it needs) for `advise`.
 * It never uses the fetcher: a database is not a site, and nothing here is an HTTP request.
 */
export function databaseConnector(name: string, source: SourceConfig): DatabaseConnector {
  const urlVar = connectionVar(source);
  const keyName = keyVar(source);
  let notes: string[] = [];

  return {
    id: `db:${name}`,
    sourceName: name,
    envVars: [urlVar],
    optionalEnvVars: keyName ? [keyName] : [],
    secretEnvVars: keyName ? [urlVar, keyName] : [urlVar],
    configured: (env: Env) => isConfigured(env, [urlVar]),

    async read(env: Env, _fetcher: Fetcher): Promise<DatabaseQueryResult[]> {
      void _fetcher;
      notes = [];
      const rawUrl = env[urlVar] ?? "";
      const rawKey = keyName ? (env[keyName] ?? "") : "";
      const early = createRedactor({ url: rawUrl, key: rawKey }, ["url", "key"]);

      const parsed = parseConnectionString(rawUrl, {});
      if (!parsed.ok) return fail({ kind: "config", message: `${urlVar}: ${parsed.message}` });
      const connection = parsed.value;
      const redact = redactorFor(rawUrl, connection, rawKey);
      const where = `${connection.host}:${connection.port}`;

      if (source.type === "supabase") {
        if (rawKey.trim() !== "") {
          const verdict = checkSupabaseKey(rawKey);
          if (!verdict.ok)
            return fail({ kind: "config", message: `${keyName}: ${early(verdict.message)}` });
        }
        const refused = refusedSupabaseUser(connection.user);
        if (refused !== undefined)
          return fail({
            kind: "config",
            message: `${urlVar} connects as ${refused}, which can read around row-level security, so Gaugeline will not use it. ${ROLE_ADVICE}`,
          });
      }

      // Layer 1 comes first and needs no connection: every query is judged before any is sent,
      // and a database is not even contacted when every query is refused.
      const results: DatabaseQueryResult[] = [];
      const todo: Array<{ index: number; sql: string }> = [];
      Object.entries(source.queries).forEach(([queryName, entry], index) => {
        const verdict = classifyStatement(queryParts(entry).sql, {
          ...(source.denyFunctions ? { denyFunctions: source.denyFunctions } : {}),
        });
        if (verdict.ok) {
          results[index] = {
            source: name,
            query: queryName,
            status: "ok",
            columns: [],
            rows: [],
            truncated: false,
          };
          todo.push({ index, sql: verdict.sql });
        } else {
          results[index] = {
            source: name,
            query: queryName,
            status: "could-not-check",
            columns: [],
            rows: [],
            truncated: false,
            message: `The query "${queryName}" was not sent. ${verdict.message}`,
          };
        }
      });
      if (todo.length === 0) return results;

      const limits = {
        statementTimeoutMs: source.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRows: Math.min(source.maxRows ?? MAX_ROWS, MAX_ROWS),
      };
      const session = new ReadOnlySession(connection);
      try {
        for (const { index, sql } of todo) {
          const base = results[index] as DatabaseQueryResult;
          try {
            const raw = await session.runUnchecked(sql, limits);
            results[index] = {
              ...base,
              columns: raw.columns,
              rows: raw.rows,
              truncated: raw.truncated,
              ...(raw.truncated
                ? {
                    message: `The query "${base.query}" returned more than ${thousands(limits.maxRows)} rows; only the first ${thousands(limits.maxRows)} were used.`,
                  }
                : {}),
            };
            if (raw.truncated) notes.push(results[index]?.message ?? "");
          } catch (err) {
            const failure = describeFailure(err, where, redact, connection.ssl !== false);
            if (
              failure.kind === "timeout" ||
              failure.kind === "query" ||
              failure.kind === "permission" ||
              failure.kind === "unexpected"
            ) {
              results[index] = {
                ...base,
                status: "could-not-check",
                message: `The query "${base.query}" could not be checked. ${failure.message}`,
              };
              continue;
            }
            throw new DatabaseError({ kind: failure.kind, message: failure.message });
          }
        }
        // Not a query of the owner's: one fixed question, to say if the role is stronger than a read needs.
        try {
          const who = await session.runUnchecked(
            "select current_user as role, (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as strong",
            { statementTimeoutMs: 3000, maxRows: 1 },
          );
          const row = who.rows[0];
          if (row && row.strong === true)
            notes.push(
              `${urlVar} connects as ${String(row.role)}, a role that can write and read around row-level security. Reads are still guarded, but the real boundary is the role. ${ROLE_ADVICE}`,
            );
        } catch {
          // Advice only; a role that cannot see pg_roles gets none.
        }
      } finally {
        await session.close();
      }
      return results;
    },

    advise(): Promise<string[]> {
      return Promise.resolve(notes);
    },
  };
}
