import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, FetchError, type Transport } from "../../fetcher.js";
import {
  COULD_NOT_CHECK,
  listingHash,
  readRpcAnswer,
  sessionIdOf,
  sessionReadOnlyProblem,
  toolLockProblem,
} from "../../sources/mcp-guard.js";
import { registerQueryAllow } from "../query-registry.js";
import { QueryRefusedError } from "../read-only-query.js";

/**
 * Integration: the real fetcher's `query()` talking to a fake remote MCP server (an injected
 * transport; no socket, no vendor, no key). The server, its tools and the token are invented.
 */
const ENTRY = registerQueryAllow({
  id: "test-vendor-mcp",
  host: "mcp.vendor.example",
  path: "/mcp",
  query: { read_only: { fixed: "true" }, project_ref: { configured: "projectRef" } },
  body: {
    kind: "mcp-jsonrpc",
    tools: { list_tables: { schemas: { type: "enum-list", values: ["public"] } } },
  },
  docs: { url: "https://vendor.example/docs/mcp", checked: null },
});
const URL_OK = "https://mcp.vendor.example/mcp?read_only=true&project_ref=abcdefghijklmnopqrst";
// Built at run time so no key-shaped string sits in the repository (push protection).
const TOKEN = ["tok", "en", "_", "fake", "0123456789", "abcdef"].join("");

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const LISTED = [
  { name: "list_tables", annotations: READ, inputSchema: { type: "object" } },
  { name: "list_migrations", annotations: READ, inputSchema: { type: "object" } },
];

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fake Streamable HTTP server: answers by method, records everything it was sent. */
function fakeServer(listed: unknown[] = LISTED, opts: { stream?: boolean } = {}) {
  const seen: Seen[] = [];
  const transport: Transport = (url, req) => {
    seen.push({
      url: url.href,
      method: req.method,
      headers: req.headers,
      ...(req.body ? { body: req.body } : {}),
    });
    const msg = JSON.parse(req.body ?? "{}") as { id?: number; method: string };
    const reply = (result: unknown, headers: Record<string, string> = {}) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      return Promise.resolve({
        status: msg.id === undefined ? 202 : 200,
        headers: {
          "content-type": opts.stream ? "text/event-stream" : "application/json",
          ...headers,
        },
        body: Readable.from([
          Buffer.from(msg.id === undefined ? "" : opts.stream ? `data: ${text}\n\n` : text),
        ]),
      });
    };
    if (msg.method === "initialize")
      return reply(
        { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
        { "mcp-session-id": "s-1" },
      );
    if (msg.method === "tools/list") return reply({ tools: listed });
    if (msg.method === "tools/call")
      return reply({
        content: [{ type: "text", text: '[{"name":"menu_items","rls_enabled":true}]' }],
      });
    return reply({});
  };
  return { seen, fetcher: createFetcher({ transport }) };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("fetcher.query with an mcp-jsonrpc entry", () => {
  it("runs the handshake, lists tools and calls an allowlisted one, with the token only in a header", async () => {
    const { seen, fetcher } = fakeServer(LISTED, { stream: true });
    const q = fetcher.query!;
    const init = await q(URL_OK, {
      allow: ENTRY.id,
      headers: auth,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "gaugeline", version: "0.0.0" },
        },
      },
    });
    const session = sessionIdOf(init);
    expect(session).toBe("s-1");
    const headers = { ...auth, "mcp-session-id": session! };
    await q(URL_OK, {
      allow: ENTRY.id,
      headers,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    const list = readRpcAnswer(
      await q(URL_OK, {
        allow: ENTRY.id,
        headers,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      }),
      2,
    );
    expect(list.ok).toBe(true);
    const tools = list.ok ? (list.result.tools as unknown[]) : [];
    expect(sessionReadOnlyProblem(tools)).toBeUndefined();
    expect(
      toolLockProblem({ tool: "list_tables", listingHash: listingHash(LISTED[0]!) }, tools),
    ).toBeUndefined();
    const answer = readRpcAnswer(
      await q(URL_OK, {
        allow: ENTRY.id,
        headers,
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_tables", arguments: { schemas: ["public"] } },
        },
      }),
      3,
    );
    expect(answer.ok).toBe(true);
    expect(seen.map((s) => s.method)).toEqual(["POST", "POST", "POST", "POST"]);
    expect(seen[0]!.headers.accept).toBe("application/json, text/event-stream");
    expect(seen[0]!.url).toBe(URL_OK);
    // The token went in the authorization header and nowhere else: not the address, not a body.
    for (const s of seen) {
      expect(s.url).not.toContain(TOKEN);
      expect(s.body ?? "").not.toContain(TOKEN);
    }
    expect(JSON.stringify(fetcher.history?.() ?? [])).not.toContain(TOKEN);
  });

  it("refuses, before anything is sent, a tool not on the entry and a method that is not one of the four", async () => {
    const { seen, fetcher } = fakeServer();
    for (const body of [
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_migrations", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "execute_sql", arguments: { query: "select 1" } },
      },
      { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "file:///etc/passwd" } },
    ]) {
      const err = await fetcher.query!(URL_OK, { allow: ENTRY.id, headers: auth, body }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(QueryRefusedError);
      expect(String((err as Error).message)).not.toContain(TOKEN);
    }
    expect(seen).toEqual([]);
  });

  it("refuses an address that drops read_only or adds an option", async () => {
    const { seen, fetcher } = fakeServer();
    for (const url of [
      "https://mcp.vendor.example/mcp?project_ref=abcdefghijklmnopqrst",
      `${URL_OK}&features=database`,
      "https://mcp.vendor.example/mcp?read_only=false&project_ref=abcdefghijklmnopqrst",
    ]) {
      const err = await fetcher.query!(url, {
        allow: ENTRY.id,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      }).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(QueryRefusedError);
    }
    expect(seen).toEqual([]);
  });

  it("a server whose listing marks a write tool read-only is not a read-only session", async () => {
    const liar = [
      ...LISTED,
      { name: "apply_migration", annotations: READ, inputSchema: { type: "object" } },
    ];
    const { fetcher } = fakeServer(liar);
    const list = readRpcAnswer(
      await fetcher.query!(URL_OK, {
        allow: ENTRY.id,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      }),
      2,
    );
    expect(list.ok && sessionReadOnlyProblem(list.result.tools)).toBe(
      COULD_NOT_CHECK.sessionNotReadOnly,
    );
  });

  it("a redirect is refused and the body goes nowhere else", async () => {
    const seen: string[] = [];
    const transport: Transport = (url) => {
      seen.push(url.href);
      return Promise.resolve({
        status: 307,
        headers: { location: "https://evil.example/mcp" },
        body: Readable.from([]),
      });
    };
    const err = await createFetcher({ transport }).query!(URL_OK, {
      allow: ENTRY.id,
      headers: auth,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(seen).toEqual([URL_OK]);
  });

  it("an oversized answer is cut at the cap and read as could-not-check", async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([
          Buffer.from(`{"jsonrpc":"2.0","id":2,"result":{"x":"${"a".repeat(10_000)}"}}`),
        ]),
      });
    const hop = await createFetcher({ transport }).query!(URL_OK, {
      allow: ENTRY.id,
      maxBytes: 1024,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(readRpcAnswer(hop, 2)).toEqual({ ok: false, reason: COULD_NOT_CHECK.tooLarge });
  });

  it("a server that never answers times out, and the error holds no token", async () => {
    const transport: Transport = () => {
      const err = new Error("deadline");
      err.name = "TimeoutError";
      return Promise.reject(err);
    };
    const err = await createFetcher({ transport, timeoutMs: 50 }).query!(URL_OK, {
      allow: ENTRY.id,
      headers: auth,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).reason).toBe("timeout");
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(TOKEN);
  });
});
