import * as z from "zod";
import type { Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import { registerQueryAllow } from "../fetch/query-registry.js";
import type { McpArgumentRule } from "../fetch/read-only-query.js";
import type { Fetcher } from "../fetcher.js";
import {
  COULD_NOT_CHECK,
  keepFields,
  readRpcAnswer,
  sessionIdOf,
  outputRuleProblems,
  cursorProblem,
  sessionReadOnlyProblem,
  toleratedProblems,
  toolLockProblem,
  toolResultData,
  type CouldNotCheckReason,
  type OutputRule,
  type ToleratedTool,
} from "../sources/mcp-guard.js";

/**
 * Supabase through its hosted MCP server, read-only (ADR-0008 Part A, MCP-03). Gaugeline is the
 * client; the server runs in its read-only mode for one project (`read_only=true` and the person's
 * `project_ref` are part of the registered address). Three tools are ever called, each a metadata
 * read: `list_tables` (names, whether row-level security is on, row counts), `get_advisors` for
 * security (lint codes and levels) and `list_migrations` (a count and the newest version). Never
 * `execute_sql`, logs, functions, keys or anything that writes: those are not on the entry, so the
 * fetcher refuses them before a socket opens.
 *
 * Credential: a personal access token in SUPABASE_ACCESS_TOKEN, sent as a bearer header. Supabase
 * has no read-only token (ADR-0008: `server-mode`), so the guarantee is the server's read-only mode,
 * checked from its own tool list. Whether the hosted server takes a token without a browser login
 * is uncited: the owner confirms it.
 */

export const SUPABASE_ACCESS_TOKEN = "SUPABASE_ACCESS_TOKEN";
export const SUPABASE_MCP_HOST = "mcp.supabase.com";
const PATH = "/mcp";
/** A Supabase project ref as the dashboard shows it: 20 lower-case letters and digits (uncited). */
export const PROJECT_REF = /^[a-z0-9]{20}$/;
/**
 * gaugeline.platforms.json: which platforms to read and the project id. The token stays in the
 * environment; a key in the file is refused (strict), not ignored.
 */
export const platformsConfigSchema = z.strictObject({
  supabase: z.strictObject({
    projectRef: z
      .string()
      .regex(PROJECT_REF, "must be the 20-character project ref from the dashboard"),
  }),
});
export type PlatformsConfig = z.infer<typeof platformsConfigSchema>;

const PROTOCOL_VERSION = "2025-06-18";
/** Pages of `tools/list` read at most; a longer listing is could-not-check. */
const MAX_LIST_PAGES = 8;
/** Requests in one read: initialize, initialized, every page of tools/list and the three calls. */
export const MAX_CALLS = 2 + MAX_LIST_PAGES + 3;
/** The most of an answer the fetcher reads; past it the answer is cut and the read stops. */
const MAX_ANSWER_BYTES = 1024 * 1024;
/** The most of one tool result parsed; past it that tool is could-not-check. */
const MAX_RESULT_BYTES = 256 * 1024;
export const MAX_TABLES = 500;
const MAX_LINTS = 200;

/** One allowlisted read: the tool, Gaugeline's fixed arguments, and the listing hash a person reviewed. */
interface SupabaseReadEntry {
  tool: "list_tables" | "get_advisors" | "list_migrations";
  rules: Readonly<Record<string, McpArgumentRule>>;
  arguments: Readonly<Record<string, unknown>>;
  /**
   * PLACEHOLDER: the hash of the hand-written recording in packages/testkit/src/supabase-mcp.ts,
   * not of the vendor's live listing. Until the owner records the real `tools/list`, a live server
   * fails this lock and the read is could-not-check ("the vendor changed this tool").
   */
  listingHash: string;
  semantics: string;
}

export const SUPABASE_READS: readonly SupabaseReadEntry[] = Object.freeze<SupabaseReadEntry[]>([
  {
    tool: "list_tables",
    rules: {
      schemas: { type: "enum-list", values: ["public"] },
      verbose: { type: "const", value: false },
    },
    arguments: { schemas: ["public"], verbose: false },
    listingHash: "594d30131a3a4f6973d5e3a4a1f992e8cc7ddee4eef512c5adf8d3ebdf40a3fc",
    semantics: "Lists all tables in one or more schemas.",
  },
  {
    tool: "get_advisors",
    rules: { type: { type: "enum", values: ["security"] } },
    arguments: { type: "security" },
    listingHash: "5e0395ae682b8045cbd9c4e918017940fdbf43aff278046f47cdc0820a668ebd",
    semantics: "Gets a list of advisory notices for the Supabase project.",
  },
  {
    tool: "list_migrations",
    rules: {},
    arguments: {},
    listingHash: "87f7b4725fd9455bd14d530b935c8f2e03a7c23105c1d9aa940f6e339fd38245",
    semantics: "Lists all migrations in the database.",
  },
]);

/**
 * Tools Supabase's read-only session lists that Gaugeline never calls (a key read, a docs search):
 * tolerated in the listing only when listed once, with all three hints and the reviewed hash. Any
 * other tool not called stops the read. PLACEHOLDER hashes, from the same invented recording.
 */
export const SUPABASE_TOLERATED: readonly ToleratedTool[] = Object.freeze([
  {
    tool: "get_publishable_keys",
    listingHash: "f96941aa5f0fb95f66d376a37ecca0959e9254b3d02d9feaa2b0916fafd11c3e",
  },
  {
    tool: "search_docs",
    listingHash: "ebfe7590fd2b6b53fe31e9abb703121995c298d674923c19052a1d289e75f79e",
  },
]);
{
  const problems = toleratedProblems(SUPABASE_TOLERATED, SUPABASE_READS);
  if (problems.length > 0)
    throw new TypeError(`Supabase tolerated tools are not valid: ${problems[0]}.`);
}

/** The one address Gaugeline may send to: the hosted server, read-only, one project. */
export const SUPABASE_MCP_ALLOW = registerQueryAllow({
  id: "supabase-mcp",
  host: SUPABASE_MCP_HOST,
  path: PATH,
  query: { read_only: { fixed: "true" }, project_ref: { configured: "projectRef" } },
  body: {
    kind: "mcp-jsonrpc",
    tools: Object.fromEntries(SUPABASE_READS.map((r) => [r.tool, r.rules])),
  },
  // The vendor's README (the docs page could not be reached from the build session): not verified.
  docs: { url: "https://github.com/supabase-community/supabase-mcp", checked: null },
});

const TABLE_RULES: Record<string, OutputRule> = {
  tables: {
    type: "list",
    max: MAX_TABLES,
    item: { name: { type: "name" }, rls_enabled: { type: "boolean" }, rows: { type: "integer" } },
  },
};
const LINT_RULES: Record<string, OutputRule> = {
  lints: {
    type: "list",
    max: MAX_LINTS,
    item: {
      name: { type: "id", pattern: "^[a-z0-9_]{1,64}$" },
      level: { type: "enum", values: ["ERROR", "WARN", "INFO"] },
      facing: { type: "enum", values: ["EXTERNAL", "INTERNAL"] },
    },
  },
};
const MIGRATION_RULES: Record<string, OutputRule> = {
  migrations: {
    type: "list",
    max: 10_000,
    item: { version: { type: "id", pattern: "^[0-9]{1,20}$" } },
  },
};

for (const rules of [TABLE_RULES, LINT_RULES, MIGRATION_RULES]) {
  const problems = outputRuleProblems(rules);
  if (problems.length > 0)
    throw new TypeError(`Supabase output rules are not valid: ${problems[0]}.`);
}

export interface SupabaseTable {
  name?: string;
  rls_enabled?: boolean;
  rows?: number;
}
export interface SupabaseLint {
  name?: string;
  level?: "ERROR" | "WARN" | "INFO";
  facing?: "EXTERNAL" | "INTERNAL";
}

export interface SupabaseRead {
  /** read: the session was read-only and the tools were tried; see notRead for any that were not. */
  status: "read" | "could-not-check" | "not-configured";
  /** For could-not-check: Gaugeline's own reason. Never the server's text. */
  reason?: CouldNotCheckReason;
  projectRef: string;
  calls: number;
  tables?: SupabaseTable[];
  advisors?: SupabaseLint[];
  migrations?: { count: number; latest?: string };
  notRead: { tool: string; reason: CouldNotCheckReason }[];
}

class Stop extends Error {
  constructor(readonly reason: CouldNotCheckReason) {
    super(reason);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Read the project's tables, security advisors and migrations. Nothing is sent without the token
 * in `env` (status not-configured); a project ref that is not an id throws ConfigError before
 * anything is sent. Every failure is could-not-check with a fixed reason.
 */
export async function readSupabase(options: {
  fetcher: Fetcher;
  env: Env;
  projectRef: string;
}): Promise<SupabaseRead> {
  const { fetcher, projectRef } = options;
  if (!PROJECT_REF.test(projectRef))
    throw new ConfigError(
      "The Supabase project ref must be the 20-character id from the dashboard.",
      {
        hint: "Copy it from Project Settings in the Supabase dashboard into gaugeline.platforms.json.",
      },
    );
  const out: SupabaseRead = { status: "read", projectRef, calls: 0, notRead: [] };
  const token = options.env[SUPABASE_ACCESS_TOKEN];
  if (token === undefined || token === "" || fetcher.query === undefined)
    return { ...out, status: "not-configured" };
  const query = fetcher.query.bind(fetcher);
  const address = new URL(`https://${SUPABASE_MCP_HOST}${PATH}`);
  address.searchParams.set("read_only", "true");
  address.searchParams.set("project_ref", projectRef);
  let session: string | undefined;
  let nextId = 1;

  async function send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (out.calls >= MAX_CALLS) throw new Stop(COULD_NOT_CHECK.callCap);
    out.calls += 1;
    const notice = method.startsWith("notifications/");
    const id = notice ? undefined : nextId++;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(session === undefined ? {} : { "mcp-session-id": session }),
    };
    let hop;
    try {
      hop = await query(address.href, {
        allow: SUPABASE_MCP_ALLOW.id,
        // The fetcher compares the address's project_ref with this, exactly (ADR-0008 point 3).
        configured: { projectRef },
        headers,
        maxBytes: MAX_ANSWER_BYTES,
        body: {
          jsonrpc: "2.0",
          ...(id === undefined ? {} : { id }),
          method,
          ...(params ? { params } : {}),
        },
      });
    } catch {
      // The error's text is the fetcher's and holds no token, but it is not shown either: one reason.
      throw new Stop(COULD_NOT_CHECK.httpStatus);
    }
    if (id === undefined) {
      if (hop.status < 200 || hop.status > 299) throw new Stop(COULD_NOT_CHECK.httpStatus);
      return {};
    }
    session ??= sessionIdOf(hop);
    const answer = readRpcAnswer(hop, id);
    if (!answer.ok) throw new Stop(answer.reason);
    return answer.result;
  }

  try {
    await send("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "gaugeline", version: "1" },
    });
    await send("notifications/initialized");
    // Every page, before any lock: a write tool on the last page must still stop the session.
    const listed: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_LIST_PAGES) throw new Stop(COULD_NOT_CHECK.callCap);
      const answer = await send("tools/list", cursor === undefined ? undefined : { cursor });
      if (!Array.isArray(answer.tools)) throw new Stop(COULD_NOT_CHECK.unexpectedShape);
      listed.push(...(answer.tools as unknown[]));
      if (answer.nextCursor === undefined) break;
      const badCursor = cursorProblem(answer.nextCursor);
      if (badCursor !== undefined) throw new Stop(badCursor);
      cursor = answer.nextCursor as string;
    }
    const notReadOnly = sessionReadOnlyProblem(listed, {
      called: SUPABASE_READS,
      tolerated: SUPABASE_TOLERATED,
    });
    if (notReadOnly !== undefined) throw new Stop(notReadOnly);
    for (const entry of SUPABASE_READS) {
      const locked = toolLockProblem(entry, listed);
      if (locked !== undefined) {
        out.notRead.push({ tool: entry.tool, reason: locked });
        continue;
      }
      const result = await send("tools/call", { name: entry.tool, arguments: entry.arguments });
      const data = toolResultData(result, MAX_RESULT_BYTES);
      const kept = data.ok ? keep(entry.tool, data.data, out) : data.reason;
      if (kept !== undefined) out.notRead.push({ tool: entry.tool, reason: kept });
    }
    return out;
  } catch (err) {
    if (err instanceof Stop)
      return {
        projectRef,
        status: "could-not-check",
        reason: err.reason,
        calls: out.calls,
        notRead: [],
      };
    throw err;
  }
}

/** Keep one tool's fields on the read; a reason when the answer did not have them. */
function keep(
  tool: SupabaseReadEntry["tool"],
  data: unknown,
  out: SupabaseRead,
): CouldNotCheckReason | undefined {
  const shaped = Array.isArray(data)
    ? { [tool === "list_tables" ? "tables" : "migrations"]: data }
    : data;
  if (tool === "list_tables") {
    const kept = keepFields(shaped, TABLE_RULES).tables;
    if (!Array.isArray(kept)) return COULD_NOT_CHECK.unexpectedShape;
    out.tables = kept as SupabaseTable[];
  } else if (tool === "get_advisors") {
    const inner = isObject(shaped) && isObject(shaped.result) ? shaped.result : shaped;
    const kept = keepFields(inner, LINT_RULES).lints;
    if (!Array.isArray(kept)) return COULD_NOT_CHECK.unexpectedShape;
    out.advisors = kept as SupabaseLint[];
  } else {
    const kept = keepFields(shaped, MIGRATION_RULES).migrations;
    if (!Array.isArray(kept)) return COULD_NOT_CHECK.unexpectedShape;
    const versions = (kept as { version?: string }[])
      .map((m) => m.version)
      .filter((v): v is string => v !== undefined)
      .sort();
    out.migrations = {
      count: kept.length,
      ...(versions.length > 0 ? { latest: versions.at(-1) } : {}),
    };
  }
  return undefined;
}
