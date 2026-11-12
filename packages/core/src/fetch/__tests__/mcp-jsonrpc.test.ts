import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, FetchError, type Transport } from "../../fetcher.js";
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
  const MINE = { projectRef: "abcdefghijklmnop" };
  const refuse = (search: string, configured: Record<string, string> | undefined = MINE) =>
    queryRefusal(at(search), ENTRY, body, undefined, configured);

  it("must carry exactly the entry's options: the fixed one as written, the configured one as configured", () => {
    expect(refuse("?read_only=true&project_ref=abcdefghijklmnop")).toBeUndefined();
    expect(refuse("?project_ref=abcdefghijklmnop&read_only=true")).toBeUndefined();
  });

  it("refuses a configured option that is not the value the person configured (review #262 M1)", () => {
    expect(refuse("?read_only=true&project_ref=otherprojectzzzzz")).toMatch(/project_ref/);
    expect(refuse("?read_only=true&project_ref=..")).toMatch(/project_ref/);
    // No configured value given at all: nothing to compare with, so refused.
    expect(queryRefusal(at("?read_only=true&project_ref=abcdefghijklmnop"), ENTRY, body)).toMatch(
      /configured/,
    );
    expect(refuse("?read_only=true&project_ref=abcdefghijklmnop", {})).toMatch(/configured/);
    // A configured value that is not a plain id is refused even when the address repeats it.
    expect(refuse("?read_only=true&project_ref=a%26b", { projectRef: "a&b" })).toBeDefined();
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
      expect(refuse(search), search).toBeDefined();
  });

  it("still refuses another host, another path, http and credentials in the address", () => {
    const q = "?read_only=true&project_ref=abcdefghijklmnop";
    for (const u of [
      `https://mcp.other.example/mcp${q}`,
      `https://mcp.vendor.example/sse${q}`,
      `http://mcp.vendor.example/mcp${q}`,
      `https://u:p@mcp.vendor.example/mcp${q}`,
    ])
      expect(queryRefusal(new URL(u), ENTRY, body, undefined, MINE), u).toBeDefined();
  });
});

describe("the registry refuses an mcp-jsonrpc entry that is not read-only by its address (review #262 M2)", () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ["no query string at all", { query: undefined }],
    [
      "read_only fixed to false",
      { query: { read_only: { fixed: "false" }, project_ref: { configured: "projectRef" } } },
    ],
    ["read_only left to configuration", { query: { read_only: { configured: "readOnly" } } }],
    ["no read_only option", { query: { project_ref: { configured: "projectRef" } } }],
    ["a configured (self-hosted) host", { host: { configured: "MCP_HOST" } }],
  ];

  for (const [what, change] of BAD)
    it(`refuses ${what}`, () => {
      const entry = { ...ENTRY, id: `bad-mcp-${what.replace(/[^a-z]+/g, "-")}`, ...change };
      if (change.query === undefined && "query" in change)
        delete (entry as { query?: unknown }).query;
      expect(allowProblems(entry as ReadOnlyQueryAllow).length, what).toBeGreaterThan(0);
      expect(() => registerQueryAllow(entry as ReadOnlyQueryAllow), what).toThrow(TypeError);
    });
});

describe("the tool-name screen sees words run together (review #262 L3)", () => {
  it("refuses glued and camel-case write, credential and code names", () => {
    for (const name of [
      "executesql",
      "deployfunction",
      "applymigration",
      "listsecrets",
      "get_anonkey",
      "runquery",
      "dropall",
      "getapitoken",
      "bulkdelete",
    ])
      expect(mcpToolNameProblem(name), name).toBeDefined();
  });

  it("still accepts the plain reads, including list_migrations", () => {
    for (const name of [
      "get_project",
      "list_tables",
      "get_advisors",
      "list_migrations",
      "list_extensions",
    ])
      expect(mcpToolNameProblem(name), name).toBeUndefined();
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
      configured: { projectRef: "abcdefghijklmnop" },
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
        configured: { projectRef: "abcdefghijklmnop" },
        body: call("execute_sql", { query: "select 1" }),
      }),
    ).rejects.toThrow(/not on the entry/);
    expect(seen).toHaveLength(1);
  });
});

describe("fetcher.query against a fake MCP server: redirect, size cap, timeout, token (review #262 L4)", () => {
  const registered = registerQueryAllow({ ...ENTRY, id: "test-mcp-edges" });
  const URL_OK = "https://mcp.vendor.example/mcp?read_only=true&project_ref=abcdefghijklmnop";
  const configured = { projectRef: "abcdefghijklmnop" };
  // Built at run time so no key-shaped string sits in the repository (push protection).
  const TOKEN = ["tok", "en_", "fake", "0123456789abcdef"].join("");
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const ask = (transport: Transport, maxBytes?: number) => {
    const fetcher = createFetcher({ transport, timeoutMs: 50 });
    const result = fetcher.query!(URL_OK, {
      allow: registered.id,
      configured,
      headers: { authorization: `Bearer ${TOKEN}` },
      body: list,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }).catch((e: unknown) => e);
    return { fetcher, result };
  };

  it("refuses a redirect and sends the body nowhere else", async () => {
    const seen: string[] = [];
    const { result } = ask((url) => {
      seen.push(url.href);
      return Promise.resolve({
        status: 307,
        headers: { location: "https://evil.example/mcp" },
        body: Readable.from([]),
      });
    });
    expect(await result).toBeInstanceOf(FetchError);
    expect(seen).toEqual([URL_OK]);
  });

  it("cuts an oversized answer at the cap and flags it", async () => {
    const { result } = ask(
      () =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([Buffer.from(`{"x":"${"a".repeat(10_000)}"}`)]),
        }),
      1024,
    );
    const hop = (await result) as { truncated?: boolean; body?: string };
    expect(hop.truncated).toBe(true);
    expect((hop.body ?? "").length).toBeLessThanOrEqual(1024);
  });

  it("times out a server that never answers, and neither the error nor the history holds the token", async () => {
    const { fetcher, result } = ask(() => {
      const err = new Error("deadline");
      err.name = "TimeoutError";
      return Promise.reject(err);
    });
    const err = await result;
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).reason).toBe("timeout");
    expect(
      String((err as Error).message) + JSON.stringify(fetcher.history?.() ?? []),
    ).not.toContain(TOKEN);
  });
});
