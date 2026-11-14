import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGaugelineServer } from "../server.js";
import type { ServerOptions } from "../state.js";

export interface Connected {
  client: Client;
  close(): Promise<void>;
}

/** A client wired to a server in the same process, as the SDK documents for tests. */
export async function connect(options: ServerOptions = {}): Promise<Connected> {
  const server = createGaugelineServer(options);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: () => client.close() };
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

/** The text of a tool result, and whether it was an error. */
export function textOf(result: unknown): { text: string; isError: boolean } {
  const r = result as ToolResult;
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
}

/** The JSON a tool returned. */
export function jsonOf<T = Record<string, unknown>>(result: unknown): T {
  const { text, isError } = textOf(result);
  if (isError) throw new Error(`tool error: ${text}`);
  return JSON.parse(text) as T;
}
