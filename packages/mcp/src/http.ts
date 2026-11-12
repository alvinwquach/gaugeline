/**
 * The streamable HTTP transport, with the MCP specification's transport security guidance applied by us
 * and tested here (the SDK's own allowedHosts options are deprecated in favour of this):
 *   - bind 127.0.0.1 by default; any other address needs allowNonLoopback AND a token AND named hosts;
 *   - validate the Host header (DNS rebinding: a page on the web cannot reach a local server through a
 *     name that resolves to 127.0.0.1) and the Origin header (a browser page is refused unless its origin
 *     is on the list; clients that are not browsers send none);
 *   - a token, when one is set, is required on every request (Authorization: Bearer), compared in constant time.
 * Stateless: each request gets its own server and transport, so nothing is shared between callers except
 * the run store and the in-flight limit.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  /** What to serve: one fresh server per request. */
  makeServer: () => McpServer;
  host?: string;
  port?: number;
  /** Required on every request when set. Comes from the environment, never from argv. */
  token?: string;
  /** Needed, with a token and allowedHosts, to bind anything but loopback. */
  allowNonLoopback?: boolean;
  /** Host header values (with or without a port) accepted besides the bound loopback address. */
  allowedHosts?: string[];
  /** Origin header values accepted. By default none: a request that carries an Origin is refused. */
  allowedOrigins?: string[];
}

export interface RunningHttp {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  return host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

const digest = (s: string) => createHash("sha256").update(s).digest();
export const tokenMatches = (given: string, expected: string): boolean =>
  timingSafeEqual(digest(given), digest(expected));

function refuse(res: ServerResponse, status: number, message: string, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RangeError("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** The Host header values this server answers to. */
function hostAllowed(header: string | undefined, bound: string, port: number, extra: string[]) {
  if (!header) return false;
  const h = header.toLowerCase();
  const bare = h.replace(/:\d+$/, "");
  const loopback = isLoopbackHost(bound)
    ? [`${bound}:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`]
    : [];
  return (
    loopback.includes(h) ||
    extra.some((e) => e.toLowerCase() === h || (!/:\d+$/.test(e) && e.toLowerCase() === bare))
  );
}

export async function startHttp(opts: HttpOptions): Promise<RunningHttp> {
  const host = opts.host ?? "127.0.0.1";
  const extraHosts = opts.allowedHosts ?? [];
  const origins = new Set((opts.allowedOrigins ?? []).map((o) => o.toLowerCase()));
  if (!isLoopbackHost(host)) {
    if (opts.allowNonLoopback !== true)
      throw new Error(
        `Refusing to listen on ${host}: this server binds 127.0.0.1 unless started with --allow-non-loopback, a token and --allowed-host.`,
      );
    if (!opts.token) throw new Error("A non-loopback bind needs a token: set GAUGELINE_MCP_TOKEN.");
    if (extraHosts.length === 0)
      throw new Error("A non-loopback bind needs --allowed-host for each name clients use.");
  }
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) refuse(res, 500, "Internal error");
      else res.end();
    });
  });
  let port = opts.port ?? 0;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) return refuse(res, 404, "Not found");
    // DNS rebinding: the Host must be one we expect, and a browser's Origin must be on the list.
    if (!hostAllowed(req.headers.host, host, port, extraHosts))
      return refuse(res, 403, "Forbidden: unexpected Host header");
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(String(origin).toLowerCase()))
      return refuse(res, 403, "Forbidden: unexpected Origin header");
    if (opts.token) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      if (!m?.[1] || !tokenMatches(m[1], opts.token))
        return refuse(res, 401, "Unauthorized", { "www-authenticate": "Bearer" });
    }
    if (req.method !== "POST")
      return refuse(res, 405, "Method not allowed: this server answers POST only", {
        allow: "POST",
      });
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      return refuse(res, e instanceof RangeError ? 413 : 400, "Bad request body");
    }
    const mcp = opts.makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, resolve);
  });
  port = (server.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}${MCP_PATH}`,
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
