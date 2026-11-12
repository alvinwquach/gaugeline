import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp, isLoopbackHost, tokenMatches, type RunningHttp } from "../http.js";
import { createGaugelineServer } from "../server.js";
import { createState } from "../state.js";

const running: RunningHttp[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

async function start(extra: Partial<Parameters<typeof startHttp>[0]> = {}) {
  const state = createState();
  const r = await startHttp({ makeServer: () => createGaugelineServer({ state }), ...extra });
  running.push(r);
  return r;
}

const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

/** A raw POST, so the Host and Origin headers can be set to anything. */
function post(
  r: RunningHttp,
  headers: Record<string, string>,
  opts: { path?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: r.port,
        path: opts.path ?? "/mcp",
        method: opts.method ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(BODY);
  });
}

describe("streamable HTTP transport", () => {
  it("binds 127.0.0.1 by default, and a client can list the tools", async () => {
    const r = await start();
    expect(r.host).toBe("127.0.0.1");
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(r.url)));
    expect((await client.listTools()).tools).toHaveLength(6);
    await client.close();
  });

  it("refuses a Host header that is not the bound address (DNS rebinding)", async () => {
    const r = await start();
    const bad = await post(r, { host: "evil.example" });
    expect(bad.status).toBe(403);
    const other = await post(r, { host: `127.0.0.1:${r.port + 1}` });
    expect(other.status).toBe(403);
    expect((await post(r, { host: `127.0.0.1:${r.port}` })).status).toBe(200);
  });

  it("refuses any request that carries an Origin unless it is on the list", async () => {
    const r = await start();
    expect((await post(r, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(r, { origin: `http://127.0.0.1:${r.port}` })).status).toBe(403);
    const listed = await start({ allowedOrigins: ["https://app.harbourline.example"] });
    expect((await post(listed, { origin: "https://app.harbourline.example" })).status).toBe(200);
    expect((await post(listed, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("answers POST on /mcp only", async () => {
    const r = await start();
    expect((await post(r, {}, { method: "GET" })).status).toBe(405);
    expect((await post(r, {}, { method: "DELETE" })).status).toBe(405);
    expect((await post(r, {}, { path: "/other" })).status).toBe(404);
  });

  it("refuses a non-loopback bind without the flag, a token and named hosts", async () => {
    await expect(
      startHttp({ makeServer: () => createGaugelineServer(), host: "0.0.0.0" }),
    ).rejects.toThrow(/allow-non-loopback/);
    await expect(
      startHttp({
        makeServer: () => createGaugelineServer(),
        host: "0.0.0.0",
        allowNonLoopback: true,
      }),
    ).rejects.toThrow(/token/);
    await expect(
      startHttp({
        makeServer: () => createGaugelineServer(),
        host: "0.0.0.0",
        allowNonLoopback: true,
        token: "t",
      }),
    ).rejects.toThrow(/allowed-host/);
  });

  it("requires the bearer token on every request when one is set", async () => {
    const token = ["tok", "en", "for", "tests"].join("-");
    const r = await start({ token });
    expect((await post(r, {})).status).toBe(401);
    expect((await post(r, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(r, { authorization: `Bearer ${token}` })).status).toBe(200);
    // The check comes before the body is read: a bad token gets no answer about the tools.
    expect((await post(r, { authorization: "Bearer wrong" })).body).not.toContain("run_check");
  });

  it("compares tokens without leaking length, and knows loopback addresses", () => {
    expect(tokenMatches("a", "a")).toBe(true);
    expect(tokenMatches("a", "ab")).toBe(false);
    expect(["127.0.0.1", "127.9.9.9", "::1"].every(isLoopbackHost)).toBe(true);
    expect(["0.0.0.0", "192.168.1.4", "example.com", "localhost"].some(isLoopbackHost)).toBe(false);
  });
});
