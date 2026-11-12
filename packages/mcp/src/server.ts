import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, describeTool, type ToolDef } from "./registry.js";
import { contextFor, createState, type ServerOptions } from "./state.js";
import { asToolError } from "./tools/shared.js";

export const SERVER_NAME = "gaugeline";
export const SERVER_VERSION = "0.1.0";

/**
 * An MCP server over the registry's tools. It holds no logic of its own: every tool calls the same core
 * functions as the CLI, and every request goes through the core fetcher.
 */
export function createGaugelineServer(options: ServerOptions = {}): McpServer {
  const state = options.state ?? createState();
  const ctx = contextFor(options, state);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const [name, def] of Object.entries(TOOLS) as [string, ToolDef][]) {
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
        try {
          const data = await def.run(args as never, ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const e = asToolError(err);
          return { isError: true, content: [{ type: "text" as const, text: e.message }] };
        }
      },
    );
  }
  return server;
}
