/**
 * What an agent client can rely on (AG-25): every claim on docs/ag-25-agent-client-compat.md that says
 * "verified" is checked here against the server, with the MCP SDK's own client over an in-memory link and
 * over Streamable HTTP, and with raw HTTP requests. No vendor client is run. The page's example output is
 * compared with what the server answers.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { startHttp, type RunningHttp } from "../http.js";
import { TOOLS } from "../registry.js";
import { SERVER_NAME, SERVER_VERSION, createGaugelineServer } from "../server.js";
import { createState } from "../state.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/ag-25-agent-client-compat.md", import.meta.url)),
  "utf8",
);
const block = (title: string) =>
  new RegExp("```[a-z]* title=" + title + "[^\\n]*\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((o) => o.close()));
});

async function inMemory(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createGaugelineServer({ state: createState() }).connect(b);
  const client = new Client({ name: "compat", version: "0" });
  await client.connect(a);
  open.push(client);
  return client;
}
async function http(extra: Partial<Parameters<typeof startHttp>[0]> = {}): Promise<RunningHttp> {
  const r = await startHttp({
    makeServer: () => createGaugelineServer({ state: createState() }),
    ...extra,
  });
  open.push(r);
  return r;
}

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
function raw(r: RunningHttp, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new Promise<Raw>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: r.port,
        path: "/mcp",
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? JSON.stringify(body) : undefined);
  });
}
const initialize = (version: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "curl-example", version: "0" },
  },
});

describe("verified: what the server says about itself", () => {
  it("is named gaugeline and offers tools and nothing else", async () => {
    const c = await inMemory();
    expect(c.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(c.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    await expect(c.listResources()).rejects.toThrow();
    await expect(c.listPrompts()).rejects.toThrow();
  });

  it("lists five tools by default, each marked read-only, with its kind first in the description", async () => {
    const c = await inMemory();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_runs",
      "draft_fix",
      "explain_finding",
      "list_checks",
      "run_check",
    ]);
    for (const t of tools) {
      const def = TOOLS[t.name as keyof typeof TOOLS];
      expect(t.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: def.requests,
      });
      expect(t.description).toMatch(/^\[(read|draft)\] /);
      expect(Object.keys(t._meta ?? {}).sort()).toEqual([
        "gaugeline/kind",
        "gaugeline/untrustedSlots",
      ]);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tools.find((t) => t.name === "run_check")?.annotations?.openWorldHint).toBe(true);
    expect(tools.find((t) => t.name === "list_checks")?.annotations?.openWorldHint).toBe(false);
  });

  it("answers a tool call with one text item that holds JSON, and no structured content", async () => {
    const c = await inMemory();
    const r = await c.callTool({ name: "list_checks", arguments: {} });
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const content = r.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });

  it("answers arguments of the wrong shape with a tool error, not a protocol error", async () => {
    const c = await inMemory();
    const r = await c.callTool({ name: "explain_finding", arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]?.text).toMatch(/^MCP error -32602: /);
  });
});

describe("verified: Streamable HTTP", () => {
  it("answers every protocol version the SDK lists with that version, and an unknown one with the latest", async () => {
    const r = await http();
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = await raw(r, initialize(v));
      expect(JSON.parse(res.body).result.protocolVersion, v).toBe(v);
    }
    const unknown = await raw(r, initialize("2099-01-01"));
    expect(JSON.parse(unknown.body).result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("answers with plain JSON and no session id: a client need not keep a session", async () => {
    const r = await http();
    const res = await raw(r, initialize(LATEST_PROTOCOL_VERSION));
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/json");
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("answers GET with 405 and Allow: POST: there is no stream for the server to push on", async () => {
    const r = await http();
    const res = await raw(r, undefined, {}, "GET");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("with a token, refuses a request without it (401, WWW-Authenticate: Bearer) and accepts it with", async () => {
    const r = await http({ token: "demo-token-value-1234" });
    const no = await raw(r, initialize(LATEST_PROTOCOL_VERSION));
    expect(no.status).toBe(401);
    expect(no.headers["www-authenticate"]).toBe("Bearer");
    const yes = await raw(r, initialize(LATEST_PROTOCOL_VERSION), {
      authorization: "Bearer demo-token-value-1234",
    });
    expect(yes.status).toBe(200);
  });

  it("refuses a request with an Origin header that was not listed (403)", async () => {
    const r = await http();
    const res = await raw(r, initialize(LATEST_PROTOCOL_VERSION), {
      origin: "https://page.example",
    });
    expect(res.status).toBe(403);
  });

  it("works with the SDK's own HTTP client, and lists the same tools as the in-memory link", async () => {
    const r = await http();
    const c = new Client({ name: "compat", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(r.url)));
    open.push(c);
    const viaHttp = (await c.listTools()).tools.map((t) => t.name).sort();
    const viaMemory = (await (await inMemory()).listTools()).tools.map((t) => t.name).sort();
    expect(viaHttp).toEqual(viaMemory);
  });
});

describe("the page", () => {
  it("lists the protocol versions the SDK lists, latest first", () => {
    expect(
      block("Versions")
        ?.split(",")
        .map((s) => s.trim()),
    ).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
  });

  it("shows the answer to the curl example's initialize, as the server gives it", async () => {
    const r = await http();
    const res = await raw(r, initialize(LATEST_PROTOCOL_VERSION));
    expect(JSON.parse(block("Output") ?? "null")).toEqual(JSON.parse(res.body));
  });

  it("names every tool the server offers by default, and the ones it holds back", () => {
    for (const name of ["run_check", "list_checks", "explain_finding", "compare_runs", "draft_fix"])
      expect(page).toContain(`\`${name}\``);
    for (const name of ["plan_check", "list_pending_approvals", "read_run_history"])
      expect(page).toContain(`\`${name}\``);
  });

  it("says the capabilities exactly as the server reports them", () => {
    expect(page).toContain('{"tools":{"listChanged":true}}');
  });

  it("does not name a vendor, a product or a client: the clients are described by what they read", () => {
    expect(page).not.toMatch(/claude|anthropic|cursor|windsurf|codex|copilot|openai|vs ?code/i);
  });

  it("marks what is not verified", () => {
    expect(page).toMatch(/\*\*Unverified[.:]?\*\*/);
  });
});
