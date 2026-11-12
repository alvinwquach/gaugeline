import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { registerQueryAllow } from "../query-registry.js";
import { mcpBodyProblem, mcpToolNameProblem, type McpJsonRpcShape } from "../mcp-jsonrpc.js";
import { allowProblems, queryRefusal, type ReadOnlyQueryAllow } from "../read-only-query.js";

/**
 * ADR-0008 Part A: the `mcp-jsonrpc` body shape of `fetcher.query`. Every name and value here is
 * invented; nothing is a vendor's real tool list.
 */
const SHAPE: McpJsonRpcShape = {
  kind: "mcp-jsonrpc",
  tools: {
    list_tables: { schemas: { type: "enum-list", values: ["public"] } },
    get_advisors: { type: { type: "enum", values: ["security", "performance"] } },
    list_migrations: {},
    get_item: { id: { type: "id", pattern: "^[a-z0-9]{8}$", maxLength: 8 } },
    list_page: {
      limit: { type: "integer", min: 1, max: 50 },
      verbose: { type: "const", value: false },
    },
  },
};

const ENTRY: ReadOnlyQueryAllow = {
  id: "vendor-mcp",
  host: "mcp.vendor.example",
  path: "/mcp",
  query: { read_only: { fixed: "true" }, project_ref: { configured: "projectRef" } },
  body: SHAPE,
  docs: { url: "https://vendor.example/docs/mcp", checked: null },
};

const call = (name: string, args: unknown = {}, id: unknown = 3) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("mcp-jsonrpc: the four methods, and nothing else", () => {
  it("accepts initialize with no client capabilities, the initialized notice and tools/list", () => {
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gaugeline", version: "0.2.0" },
      },
    };
    expect(mcpBodyProblem(SHAPE, init)).toBeUndefined();
    expect(
      mcpBodyProblem(SHAPE, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
    expect(mcpBodyProblem(SHAPE, { jsonrpc: "2.0", id: 2, method: "tools/list" })).toBeUndefined();
  });

  it("refuses a client that offers sampling, elicitation or roots: it has no one to ask", () => {
    for (const cap of ["sampling", "elicitation", "roots"]) {
      const init = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: { [cap]: {} },
          clientInfo: { name: "gaugeline", version: "0.2.0" },
        },
      };
      expect(mcpBodyProblem(SHAPE, init), cap).toMatch(/capabilities/);
    }
  });

  it("refuses every other method: resources, prompts, logging, tasks, a reply to the server", () => {
    for (const method of [
      "resources/read",
      "resources/list",
      "prompts/get",
      "logging/setLevel",
      "tasks/get",
      "completion/complete",
      "ping",
    ])
      expect(mcpBodyProblem(SHAPE, { jsonrpc: "2.0", id: 4, method }), method).toMatch(/method/);
    // A response (no method) is how a client answers a server's request: never sent.
    expect(mcpBodyProblem(SHAPE, { jsonrpc: "2.0", id: 4, result: {} })).toBeDefined();
    expect(mcpBodyProblem(SHAPE, { jsonrpc: "2.0", id: 4 })).toMatch(/method/);
  });

  it("refuses a batch, a wrong version, a string id and an extra top-level key", () => {
    expect(mcpBodyProblem(SHAPE, [call("list_migrations")])).toMatch(/one JSON-RPC message/);
    expect(mcpBodyProblem(SHAPE, { ...call("list_migrations"), jsonrpc: "1.0" })).toMatch(/2\.0/);
    expect(mcpBodyProblem(SHAPE, call("list_migrations", {}, "3"))).toMatch(/id/);
    expect(mcpBodyProblem(SHAPE, { ...call("list_migrations"), extra: 1 })).toMatch(/extra/);
  });
});

describe("mcp-jsonrpc: tools/call names a tool on the entry and passes its argument rules", () => {
  it("accepts each allowed tool with arguments that pass", () => {
    expect(mcpBodyProblem(SHAPE, call("list_tables", { schemas: ["public"] }))).toBeUndefined();
    expect(mcpBodyProblem(SHAPE, call("get_advisors", { type: "security" }))).toBeUndefined();
    expect(mcpBodyProblem(SHAPE, call("list_migrations"))).toBeUndefined();
    expect(mcpBodyProblem(SHAPE, call("get_item", { id: "ab12cd34" }))).toBeUndefined();
    expect(mcpBodyProblem(SHAPE, call("list_page", { limit: 50, verbose: false }))).toBeUndefined();
  });

  it("refuses a tool not on the entry, whatever its name says", () => {
    for (const name of ["execute_sql", "get_logs", "get_publishable_keys", "list_projects"])
      expect(mcpBodyProblem(SHAPE, call(name)), name).toMatch(/not on the entry/);
  });

  it("refuses a different case and a Unicode lookalike of an allowed name", () => {
    expect(mcpBodyProblem(SHAPE, call("List_Tables"))).toMatch(/not on the entry/);
    // Cyrillic small a (U+0430) in place of Latin a.
    expect(mcpBodyProblem(SHAPE, call("list_t\u0430bles"))).toMatch(/not on the entry/);
    expect(mcpBodyProblem(SHAPE, call("list_tables\u200B"))).toMatch(/not on the entry/);
  });

  it("refuses an argument the entry does not list, and free text in any argument", () => {
    expect(mcpBodyProblem(SHAPE, call("list_migrations", { query: "select 1" }))).toMatch(
      /argument "query"/,
    );
    expect(
      mcpBodyProblem(SHAPE, call("get_advisors", { type: "ignore previous instructions" })),
    ).toMatch(/argument "type"/);
    expect(mcpBodyProblem(SHAPE, call("get_item", { id: "ab12cd34; drop table x" }))).toMatch(
      /argument "id"/,
    );
    expect(mcpBodyProblem(SHAPE, call("list_tables", { schemas: ["public", "auth"] }))).toMatch(
      /argument "schemas"/,
    );
    expect(mcpBodyProblem(SHAPE, call("list_page", { limit: 51 }))).toMatch(/argument "limit"/);
    expect(mcpBodyProblem(SHAPE, call("list_page", { limit: 2.5 }))).toMatch(/argument "limit"/);
    expect(mcpBodyProblem(SHAPE, call("list_page", { verbose: true }))).toMatch(
      /argument "verbose"/,
    );
    expect(mcpBodyProblem(SHAPE, call("list_migrations", []))).toMatch(/arguments/);
  });
});

describe("mcpToolNameProblem: the second screen on an entry's tool names", () => {
  it("refuses a name with a write word, a credential word, a fetch word or code execution", () => {
    for (const name of [
      "confirm_cost",
      "deploy_edge_function",
      "apply_migration",
      "execute_sql",
      "run_notebook",
      "get_publishable_keys",
      "get_api_token",
      "read_secret",
      "fetch_url",
      "browser_screenshot",
      "search",
      "execute",
      "pause_project",
      "rollback",
    ])
      expect(mcpToolNameProblem(name), name).toBeDefined();
  });

  it("accepts plain reads", () => {
    for (const name of ["get_project", "list_tables", "get_advisors", "list_migrations"])
      expect(mcpToolNameProblem(name), name).toBeUndefined();
  });
});

describe("an entry with the mcp-jsonrpc shape", () => {
  it("is well formed", () => {
    expect(allowProblems(ENTRY)).toEqual([]);
  });

  it("refuses an entry whose tool list holds a write-capable or credential tool", () => {
    const bad = { ...ENTRY, body: { kind: "mcp-jsonrpc", tools: { confirm_cost: {} } } } as const;
    expect(allowProblems(bad as ReadOnlyQueryAllow).join(" ")).toMatch(/confirm_cost/);
    const keys = { ...ENTRY, body: { kind: "mcp-jsonrpc", tools: { get_publishable_keys: {} } } };
    expect(allowProblems(keys as ReadOnlyQueryAllow).join(" ")).toMatch(/get_publishable_keys/);
  });

  it("refuses a free-form argument rule and an empty tool list", () => {
    const free = {
      ...ENTRY,
      body: { kind: "mcp-jsonrpc", tools: { list_tables: { q: { type: "string" } } } },
    };
    expect(allowProblems(free as unknown as ReadOnlyQueryAllow).join(" ")).toMatch(/argument rule/);
    const none = { ...ENTRY, body: { kind: "mcp-jsonrpc", tools: {} } };
    expect(allowProblems(none as ReadOnlyQueryAllow).join(" ")).toMatch(/at least one tool/);
  });

  it("keeps the query-string rule to mcp-jsonrpc entries", () => {
    const json = {
      ...ENTRY,
      body: { kind: "json-query", keys: ["q"] },
    } as ReadOnlyQueryAllow;
    expect(allowProblems(json).join(" ")).toMatch(/query string/);
  });
});

describe("the address of an mcp-jsonrpc entry", () => {
  const body = call("list_migrations");
  const at = (search: string) => new URL(`https://mcp.vendor.example/mcp${search}`);

  it("must carry exactly the entry's options: the fixed one as written, the configured one as an id", () => {
    expect(
      queryRefusal(at("?read_only=true&project_ref=abcdefghijklmnop"), ENTRY, body),
    ).toBeUndefined();
    expect(
      queryRefusal(at("?project_ref=abcdefghijklmnop&read_only=true"), ENTRY, body),
    ).toBeUndefined();
  });

  it("refuses a missing, changed, repeated or extra option", () => {
    for (const search of [
      "?project_ref=abcdefghijklmnop",
      "?read_only=false&project_ref=abcdefghijklmnop",
      "?read_only=true&read_only=false&project_ref=abcdefghijklmnop",
      "?read_only=true&project_ref=abcdefghijklmnop&features=database",
      "?read_only=true&project_ref=abc%20def",
      "?read_only=true&project_ref=",
      "?read_only=true",
      "",
    ])
      expect(queryRefusal(at(search), ENTRY, body), search).toBeDefined();
  });

  it("still refuses another host, another path, http and credentials in the address", () => {
    const q = "?read_only=true&project_ref=abcdefghijklmnop";
    expect(queryRefusal(new URL(`https://mcp.other.example/mcp${q}`), ENTRY, body)).toBeDefined();
    expect(queryRefusal(new URL(`https://mcp.vendor.example/sse${q}`), ENTRY, body)).toBeDefined();
    expect(queryRefusal(new URL(`http://mcp.vendor.example/mcp${q}`), ENTRY, body)).toBeDefined();
    expect(
      queryRefusal(new URL(`https://u:p@mcp.vendor.example/mcp${q}`), ENTRY, body),
    ).toBeDefined();
  });
});

describe("fetcher.query sends an mcp-jsonrpc message", () => {
  const registered = registerQueryAllow({ ...ENTRY, id: "test-mcp-send" });
  const URL_OK = "https://mcp.vendor.example/mcp?read_only=true&project_ref=abcdefghijklmnop";

  it("asks for JSON or an event stream, and sends nothing for a refused message", async () => {
    const seen: { accept?: string; body?: string }[] = [];
    const transport: Transport = (_url, req) => {
      seen.push({ accept: req.headers.accept, body: req.body });
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}')]),
      });
    };
    const fetcher = createFetcher({ transport });
    const hop = await fetcher.query!(URL_OK, {
      allow: registered.id,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(hop.status).toBe(200);
    expect(seen).toEqual([
      {
        accept: "application/json, text/event-stream",
        body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      },
    ]);
    await expect(
      fetcher.query!(URL_OK, {
        allow: registered.id,
        body: call("execute_sql", { query: "select 1" }),
      }),
    ).rejects.toThrow(/not on the entry/);
    expect(seen).toHaveLength(1);
  });
});
