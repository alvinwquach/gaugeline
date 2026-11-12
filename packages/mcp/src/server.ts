import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, assertLabelled, describeTool, type ToolDef } from "./registry.js";
import { DEFAULT_CALL_MS, contextFor, createState, type ServerOptions } from "./state.js";
import { ToolError } from "./errors.js";
import { asToolError } from "./tools/shared.js";

export const SERVER_NAME = "gaugeline";
export const SERVER_VERSION = "0.1.0";

/**
 * An MCP server over the registry's tools. It holds no logic of its own: every tool calls the same core
 * functions as the CLI, and every request goes through the core fetcher.
 */
export function createGaugelineServer(options: ServerOptions = {}): McpServer {
  assertLabelled(TOOLS);
  const state = options.state ?? createState();
  const ctx = contextFor(options, state);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const limit = options.maxActiveCalls ?? 16;
  // The operator's own plan bases stay readable in an error; every other address is withheld.
  const keep = (options.planBases ?? []).flatMap((b) =>
    URL.canParse(b) ? [new URL(b).origin, new URL(b).host] : [],
  );
  for (const [name, def] of Object.entries(TOOLS) as [string, ToolDef][]) {
    if (def.enabled && !def.enabled(options)) continue;
    server.registerTool(
      name,
      {
        title: def.title,
        description: describeTool(def),
        inputSchema: def.inputSchema,
        annotations: {
          title: def.title,
          // True for every tool: none changes anything. `draft` returns text and applies nothing.
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: def.requests,
        },
        _meta: { "gaugeline/kind": def.kind },
      },
      async (args: unknown) => {
        // Calls that make requests wait behind one shared in-flight limit; the waiting line is bounded, so
        // a flood is refused with a clear message instead of queueing memory and time without end.
        if (def.requests && state.active >= limit)
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `The server is busy: ${state.active} checks are already running or waiting. Try again shortly.`,
              },
            ],
          };
        if (def.requests) state.active++;
        try {
          const data = await withDeadline(
            def.run(args as never, ctx),
            (options.maxCallMs ?? DEFAULT_CALL_MS) + 2000,
          );
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const e = asToolError(err, keep);
          return { isError: true, content: [{ type: "text" as const, text: e.message }] };
        } finally {
          if (def.requests) state.active--;
        }
      },
    );
  }
  return server;
}

/**
 * Answers at the limit even if something below is stuck. The work itself is stopped by the hop-level
 * deadline; this only makes sure the caller is not left waiting, and that a late failure of the abandoned
 * work is swallowed here and never becomes an unhandled rejection.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError("This check ran past its time limit and was stopped.")),
      ms,
    );
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
