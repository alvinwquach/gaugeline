import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * A fake of Supabase's hosted MCP server in read-only mode, as an injected transport: no socket,
 * no vendor, no key. The tool list is a hand-written recording modelled on the tool names and
 * annotations in `@supabase/mcp-server-supabase` 0.16.1; the schemas, rows, names and lints are
 * invented (CLAUDE.md rule 12). The listing hashes in adapters/supabase-mcp.ts are taken from this
 * recording until the owner records the real `tools/list`.
 */
export const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export const RECORDED_TOOLS = [
  {
    name: "list_tables",
    description: "Lists all tables in one or more schemas.",
    annotations: { title: "List tables", ...READ, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        schemas: { type: "array", items: { type: "string" }, default: ["public"] },
        verbose: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "get_advisors",
    description: "Gets a list of advisory notices for the Supabase project.",
    annotations: { title: "Get project advisors", ...READ, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", enum: ["security", "performance"] } },
      required: ["type"],
    },
  },
  {
    name: "list_migrations",
    description: "Lists all migrations in the database.",
    annotations: { title: "List migrations", ...READ, idempotentHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_docs",
    description: "Searches the Supabase documentation.",
    annotations: { title: "Search docs", ...READ, idempotentHint: true },
    inputSchema: { type: "object", properties: { graphql_query: { type: "string" } } },
  },
] as const;

/** What the invented project holds: a pop-up bar's booking tables. */
export const RECORDED_ANSWERS: Record<string, unknown> = {
  list_tables: {
    tables: [
      { name: "public.bookings", rls_enabled: false, rows: 214, comment: "Friday guest list" },
      { name: "public.menu_items", rls_enabled: true, rows: 38 },
    ],
  },
  get_advisors: {
    result: {
      lints: [
        {
          name: "rls_disabled_in_public",
          level: "ERROR",
          facing: "EXTERNAL",
          title: "RLS Disabled in Public",
          description: "Table public.bookings is public.",
        },
        { name: "function_search_path_mutable", level: "WARN", facing: "EXTERNAL" },
        { name: "unused_index", level: "INFO", facing: "EXTERNAL" },
      ],
    },
  },
  list_migrations: {
    migrations: [
      { version: "20261020101500", name: "create_bookings" },
      { version: "20261101093000", name: "add_menu_items" },
    ],
  },
};

export interface FakeOptions {
  tools?: readonly unknown[];
  answers?: Record<string, unknown>;
  /** Answer a tool call with this raw result instead of the recorded text. */
  rawResult?: Record<string, unknown>;
  /** Answer every request with this status. */
  status?: number;
  /** Put a request from the server in the stream before the answer to a tool call. */
  askBack?: boolean;
  /** Reject every request as a timeout. */
  timeout?: boolean;
}

export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function fakeSupabase(opts: FakeOptions = {}): { transport: Transport; sent: Sent[] } {
  const sent: Sent[] = [];
  const transport: Transport = (url, req) => {
    sent.push({ url: url.href, method: req.method, headers: req.headers, body: req.body ?? "" });
    if (opts.timeout) {
      const err = new Error("deadline");
      err.name = "TimeoutError";
      return Promise.reject(err);
    }
    const msg = JSON.parse(req.body ?? "{}") as {
      id?: number;
      method: string;
      params?: { name?: string };
    };
    const answer = (result: unknown, extra: Record<string, string> = {}, before = "") =>
      Promise.resolve({
        status: opts.status ?? (msg.id === undefined ? 202 : 200),
        headers: { "content-type": "text/event-stream", ...extra },
        body: Readable.from([
          Buffer.from(
            msg.id === undefined
              ? ""
              : `${before}event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`,
          ),
        ]),
      });
    if (msg.method === "initialize")
      return answer(
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake" },
        },
        { "mcp-session-id": "fake-session-1" },
      );
    if (msg.method === "tools/list") return answer({ tools: opts.tools ?? RECORDED_TOOLS });
    if (msg.method === "tools/call") {
      const name = msg.params?.name ?? "";
      const data = (opts.answers ?? RECORDED_ANSWERS)[name];
      const ask = opts.askBack
        ? `data: ${JSON.stringify({ jsonrpc: "2.0", id: "s-9", method: "elicitation/create", params: {} })}\n\n`
        : "";
      return answer(
        opts.rawResult ?? { content: [{ type: "text", text: JSON.stringify(data) }] },
        {},
        ask,
      );
    }
    return answer({});
  };
  return { transport, sent };
}
