import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createKey, keyMatches } from "./key.js";

/** The only address the app listens on: this computer. Never 0.0.0.0, never "::", never omitted. */
export const APP_HOST = "127.0.0.1";
export const FIRST_PORT = 4817;
export const PORT_ATTEMPTS = 10;

/** Every port in the range was taken. The CLI exits 2 with this message. */
export class PortRangeError extends Error {
  constructor(first: number, attempts: number) {
    super(
      `Ports ${first} to ${first + attempts - 1} are all in use, so the app could not start. Close what is using them (another gaugeline open, perhaps) and try again.`,
    );
    this.name = "PortRangeError";
  }
}

/**
 * Try `first`, then the next port, up to `attempts`: only EADDRINUSE moves on. Anything else
 * (EACCES, say) is the machine telling us something, and is thrown as it is.
 */
export async function pickPort(
  listen: (port: number) => Promise<void>,
  first = FIRST_PORT,
  attempts = PORT_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    try {
      await listen(first + i);
      return first + i;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new PortRangeError(first, attempts);
}

export interface RunningApp {
  /** http://localhost:<port>/?s=<key>: printed once, the only place the key appears. */
  url: string;
  port: number;
  /** The address the listener is bound to, read back from the socket: always 127.0.0.1. */
  host: string;
  /** Stop listening, end open connections (keep-alive included), resolve once the port is free. */
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  /** The address to check, given on the command line. Read by the API in G21b. */
  address?: string;
  signal?: AbortSignal;
}

const REFUSED =
  "Gaugeline refused this request: it needs the one-time key from the link printed in the terminal.\n";
const PLACEHOLDER =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Gaugeline</title><p>Gaugeline is running on this computer. The app itself arrives in a later version.</p></html>\n';

export async function startApp(opts: StartOptions = {}): Promise<RunningApp> {
  const key = createKey();
  const sockets = new Set<Socket>();
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!keyMatches(url.searchParams.get("s") ?? undefined, key)) {
      res
        .writeHead(403, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(REFUSED);
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(PLACEHOLDER);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.\n");
  };
  const server = createServer(handle);
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  const port = await pickPort(
    (p) =>
      new Promise<void>((resolve, reject) => {
        const failed = (err: Error) => {
          server.off("listening", ok);
          reject(err);
        };
        const ok = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", ok);
        server.listen({ host: APP_HOST, port: p });
      }),
    opts.port ?? FIRST_PORT,
  );
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
    }));
  opts.signal?.addEventListener("abort", () => void close(), { once: true });
  const host = (server.address() as AddressInfo).address;
  return { url: `http://localhost:${port}/?s=${key}`, port, host, close };
}
