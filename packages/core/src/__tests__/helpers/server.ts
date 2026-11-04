import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface LoggedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

export interface FixtureServer {
  origin: string;
  port: number;
  log: LoggedRequest[];
  /** Highest number of requests being handled at the same moment. */
  maxConcurrent: number;
  close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1 with a request log. Routes are matched on the exact path. */
export async function startServer(
  routes: Record<string, Handler>,
  fallback?: Handler,
): Promise<FixtureServer> {
  const log: LoggedRequest[] = [];
  let concurrent = 0;
  const state = { maxConcurrent: 0 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    log.push({ method: req.method ?? "", path: url.pathname + url.search, headers: req.headers });
    concurrent += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, concurrent);
    res.on("close", () => {
      concurrent -= 1;
    });
    const handler = routes[url.pathname + url.search] ?? routes[url.pathname] ?? fallback;
    if (!handler) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    void Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    log,
    get maxConcurrent() {
      return state.maxConcurrent;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A raw TCP server for responses an HTTP server will not send (wrong lengths, silence). */
export async function startRawServer(onSocket: (socket: Socket) => void): Promise<{
  origin: string;
  port: number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export function redirect(status: number, location: string): Handler {
  return (_req, res) => {
    res.writeHead(status, { location }).end();
  };
}

export function html(body: string, status = 200): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
  };
}
