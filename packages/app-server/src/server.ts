import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createKey } from "./key.js";
import { checkRequest, REFUSAL_TEXT } from "./origin.js";
import { createSession, sessionCookie, setSessionCookie } from "./session.js";

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
  /** Requests that passed every rule (the link's exchange included). For tests. */
  accepted(): number;
  /** Stop listening, end open connections (keep-alive included), resolve once the port is free. */
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  /** The address to check, given on the command line. Read by the API in G21b. */
  address?: string;
  signal?: AbortSignal;
}

const PLACEHOLDER =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Gaugeline</title><p>Gaugeline is running on this computer. The app itself arrives in a later version.</p></html>\n';

/** The Host header, or undefined when it is missing or was sent more than once. */
function hostOf(req: IncomingMessage): string | undefined {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i]?.toLowerCase() === "host") count++;
  return count === 1 ? req.headers.host : undefined;
}
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? undefined : v);

export async function startApp(opts: StartOptions = {}): Promise<RunningApp> {
  const key = createKey();
  const session = createSession(key);
  const sockets = new Set<Socket>();
  let port = 0;
  let accepted = 0;
  const refuse = (res: ServerResponse, why: keyof typeof REFUSAL_TEXT) =>
    res
      .writeHead(403, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(REFUSAL_TEXT[why]),
        "cache-control": "no-store",
      })
      .end(REFUSAL_TEXT[why]);
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // Before any route: Host, Origin, the method's Origin, Sec-Fetch-Site. No CORS header, ever.
    const verdict = checkRequest(
      {
        method: req.method ?? "GET",
        host: hostOf(req),
        origin: one(req.headers.origin),
        secFetchSite: one(req.headers["sec-fetch-site"]),
      },
      port,
    );
    if (!verdict.ok) return refuse(res, verdict.reason);
    const url = new URL(req.url ?? "/", "http://localhost");
    // The link: its key, once, becomes the session cookie, and a 303 takes the key out of the
    // address bar. A spent or wrong key is refused like a missing one.
    if (url.searchParams.has("s")) {
      const token =
        req.method === "GET" && url.pathname === "/"
          ? session.exchange(url.searchParams.get("s") ?? undefined)
          : null;
      if (!token) return refuse(res, "session");
      accepted++;
      res
        .writeHead(303, {
          location: "/",
          "set-cookie": setSessionCookie(token),
          "cache-control": "no-store",
        })
        .end();
      return;
    }
    if (!session.isValid(sessionCookie(one(req.headers.cookie)))) return refuse(res, "session");
    accepted++;
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
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
  port = await pickPort(
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
  return { url: `http://localhost:${port}/?s=${key}`, port, host, close, accepted: () => accepted };
}
