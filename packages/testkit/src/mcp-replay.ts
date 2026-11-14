import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpHttpError, type McpMessage, type McpReply, type McpTransport } from "@gaugeline/core";

/** Where the hand-written MCP recordings live (packages/fixtures/salesforce-mcp). */
export const MCP_RECORDINGS_DIR = fileURLToPath(
  new URL("../../fixtures/salesforce-mcp/", import.meta.url),
);

/** One recorded exchange. `result.text` is an object here and goes on the wire as a JSON string. */
export interface McpExchange {
  method: string;
  /** For tools/call: the tool this answers. */
  tool?: string;
  /** For soqlQuery: text the query must contain. */
  queryIncludes?: string;
  /** The allowance the server reported with this answer: "used/max". */
  apiUsage?: string;
  /** Answer with this HTTP status instead of a response. */
  http?: number;
  /** A JSON-RPC error instead of a result. */
  error?: { code: number; message: string };
  result?: Record<string, unknown>;
}

export interface McpRecording {
  note: string;
  server: string;
  /** The run's clock when it was written, ISO. */
  now: string;
  exchanges: McpExchange[];
}

export function readMcpRecording(name: string): McpRecording {
  return JSON.parse(readFileSync(join(MCP_RECORDINGS_DIR, `${name}.json`), "utf8")) as McpRecording;
}

export interface McpReplay extends McpTransport {
  /** Every message sent, in order, with the address it was sent to. */
  readonly seen: { server: string; message: McpMessage }[];
  /** Recorded exchanges nothing asked for. */
  unused(): McpExchange[];
}

/**
 * A stand-in for the MCP server: answers each message from the recording, in order, matching the
 * method, the tool and (for queries) a piece of the SOQL. A message the recording has no answer for
 * is an error, so a run cannot make a request nobody recorded. Nothing is sent anywhere.
 */
export function replayMcp(recording: McpRecording | string): McpReplay {
  const rec = typeof recording === "string" ? readMcpRecording(recording) : recording;
  const left = [...rec.exchanges];
  const seen: McpReplay["seen"] = [];
  return {
    seen,
    unused: () => [...left],
    send(server: string, message: McpMessage): Promise<McpReply> {
      seen.push({ server, message });
      const args = message.params?.arguments as Record<string, unknown> | undefined;
      const query = typeof args?.query === "string" ? args.query : "";
      const at = left.findIndex(
        (e) =>
          e.method === message.method &&
          (e.tool === undefined || e.tool === message.params?.name) &&
          (e.queryIncludes === undefined || query.includes(e.queryIncludes)),
      );
      if (at < 0)
        return Promise.reject(
          new Error(
            `The recording has no answer for ${message.method}${message.params?.name ? ` ${String(message.params.name)}` : ""}${query ? ` (${query})` : ""}.`,
          ),
        );
      const [exchange] = left.splice(at, 1);
      if (!exchange) return Promise.reject(new Error("unreachable"));
      if (exchange.http !== undefined) return Promise.reject(new McpHttpError(exchange.http));
      const usage = exchange.apiUsage?.split("/").map(Number);
      const apiUsage =
        usage && usage.length === 2 && usage.every((n) => Number.isFinite(n))
          ? { used: usage[0] ?? 0, max: usage[1] ?? 0 }
          : undefined;
      if (message.id === undefined) return Promise.resolve({ ...(apiUsage ? { apiUsage } : {}) });
      let body: Record<string, unknown>;
      if (exchange.error) body = { jsonrpc: "2.0", id: message.id, error: exchange.error };
      else {
        const result = { ...exchange.result };
        if (message.method === "tools/call" && "text" in result) {
          const { text, isError, ...rest } = result;
          body = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              ...rest,
              content: [{ type: "text", text: JSON.stringify(text) }],
              isError: isError === true,
            },
          };
        } else body = { jsonrpc: "2.0", id: message.id, result };
      }
      return Promise.resolve({ body, ...(apiUsage ? { apiUsage } : {}) });
    },
  };
}
