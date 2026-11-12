/**
 * A plain Node server around the route table, for development and the end-to-end tests. The hosted service
 * itself runs the same handlers behind Next.js Route Handlers (app/**\/route.ts).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { WebDeps } from "../lib/web/deps.js";
import { route } from "../lib/web/routes.js";

const MAX_BODY = 16 * 1024;

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  // The address is the configured origin plus the raw path, joined as text. `new URL(req.url, origin)`
  // would read `//evil.example/x` as a host and let the request choose its own origin.
  const path = req.url ?? "/";
  if (!path.startsWith("/")) throw new Error("request target must be a path");
  const base = new URL(origin).origin;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers))
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body: Buffer | undefined;
  if (hasBody) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error("request body too large");
      chunks.push(c as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(`${base}${path}`, { method: req.method, headers, body });
}

export function createWebServer(deps: WebDeps, origin: () => string): Server {
  return createServer((req, res) => {
    toRequest(req, origin())
      .then((request) => route(request, deps))
      .then(async (response) => {
        const headers: Record<string, string | string[]> = {};
        response.headers.forEach((v, k) => {
          if (k !== "set-cookie") headers[k] = v;
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) headers["set-cookie"] = cookies;
        res.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()));
      })
      .catch(() => {
        res.writeHead(400, { "content-type": "text/plain" }).end("Bad request");
      });
  });
}
