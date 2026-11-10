import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createKey } from "./key.js";
import { checkRequest, REFUSAL_TEXT } from "./origin.js";
import { createSession, sessionCookie, setSessionCookie } from "./session.js";
import { createPageRegistry, type FetcherOptions } from "@gaugeline/core";
import { loadAdsFile, type AdsEngine, type AdsInput } from "./ads.js";
import { DEMO_PATH, DemoError, fillDemo, parseDemo } from "./demo.js";
import { route } from "./routes.js";
import { createRunner } from "./runs.js";
import { applySecurityHeaders, ClientMissingError, loadClient, serveClient } from "./static.js";
import { createStore, type Run, type RunEvent, type Store } from "./store.js";

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
  /** Every request the app received, refused ones included. For tests. */
  received(): number;
  /** The session's runs (in memory only). */
  store: Store;
  /** With an address: the first run, settled when it has finished. */
  firstRun?: Promise<Run>;
  /** Stop listening, end open connections (keep-alive included), resolve once the port is free. */
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  /**
   * The built client: the folder holding client-manifest.json and the files it lists (the CLI passes
   * its own dist/client). Read and verified before the port is taken. Required: an app with no
   * client would answer 404 to everything, so leaving it out is ClientMissingError.
   */
  clientDir?: string;
  /** The address to check first, given on the command line: started like POST /api/check. */
  address?: string;
  signal?: AbortSignal;
  /** Base fetcher options for every run (tests pass a fixture's hosts map). */
  fetcher?: FetcherOptions;
  /** The runs' clock (tests). */
  now?: () => Date;
  /** Each progress line of the first run, as it happens (the CLI prints them). */
  onFirstStep?: (text: string) => void;
  /** Most runs kept in the session (default 50). */
  maxRuns?: number;
  /** The version shown by GET /api/session and written into every downloaded report. */
  version?: string;
  /**
   * The demo: the session starts with the example results from the client folder, no fetcher or
   * runner is made, and a check is refused with 409. With an address it is a usage error.
   */
  demo?: boolean;
  /**
   * An ads export to show (gaugeline open --ads): the file is read once, here, before the port is
   * taken, and its run starts as soon as the app is listening. The path is never kept and no route
   * accepts one. A file that cannot be used is an AdsInputError. Not with an address or the demo.
   */
  ads?: { file: string; engine: AdsEngine };
}

/** The Host header, or undefined when it is missing or was sent more than once. */
function hostOf(req: IncomingMessage): string | undefined {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i]?.toLowerCase() === "host") count++;
  return count === 1 ? req.headers.host : undefined;
}
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? undefined : v);

export async function startApp(opts: StartOptions = {}): Promise<RunningApp> {
  // Before anything listens: a missing or damaged client is a start-up error, not a blank page.
  if (opts.clientDir === undefined) throw new ClientMissingError("(no folder given)");
  const client = loadClient(opts.clientDir);
  // The example results travel in the client folder (so they are hashed like the rest), but they
  // are data for the store and are never served as a file.
  const demoFile = client.get(`/${DEMO_PATH}`);
  client.delete(`/${DEMO_PATH}`);
  if (opts.demo && opts.address !== undefined)
    throw new DemoError("The demo takes no address: it shows example results and checks nothing.");
  if (opts.demo && !demoFile)
    throw new DemoError(
      "The example results are not in this package (no demo/results.json). Reinstall gaugeline, or in a source checkout run pnpm build.",
    );
  if (opts.demo && opts.ads)
    throw new DemoError(
      "The demo takes no ads export: it shows example results and checks nothing.",
    );
  if (opts.ads && opts.address !== undefined)
    throw new DemoError("An ads export and an address cannot be opened together.");
  // Before the port is taken: an unusable export is a start-up error, not an app with nothing in it.
  const adsInput: AdsInput | undefined = opts.ads
    ? loadAdsFile(opts.ads.file, opts.ads.engine)
    : undefined;
  const demoRuns = opts.demo && demoFile ? parseDemo(demoFile.body.toString("utf8")) : undefined;
  const key = createKey();
  const session = createSession(key);
  const sockets = new Set<Socket>();
  const store = createStore({ ...(opts.maxRuns ? { max: opts.maxRuns } : {}) });
  const registry = createPageRegistry();
  const version = opts.version ?? "0.0.0";
  // The demo has no runner: with no fetcher made anywhere in the process, "it requests nothing" is
  // a fact about the code and not a promise about its behaviour.
  const runner = demoRuns
    ? undefined
    : createRunner(store, {
        ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        registry,
      });
  if (demoRuns) fillDemo(store, demoRuns);
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
  let received = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    received++;
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
    // "//index.html" is a path here, not the host "index.html": a request target that starts with a
    // slash is joined to the base as text, so a client path is only ever a key that exists or a 404.
    const target = req.url ?? "/";
    const url = new URL(
      target.startsWith("/") ? `http://localhost${target}` : target,
      "http://localhost",
    );
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
    if (
      await route(req, res, {
        store,
        ...(runner ? { runner } : {}),
        registry,
        version,
        demo: demoRuns !== undefined,
      })
    )
      return;
    // The client, from the Map. An /api/ path that the routes did not answer never gets here.
    serveClient(client, req, res, url.pathname);
  };
  const server = createServer((req, res) => {
    // The one place the security headers are set: before any route, refusal or error can answer.
    applySecurityHeaders(res);
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Something went wrong in the app.\n");
    });
  });
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
  // The address from the command line starts the first run the way POST /api/check does.
  let firstRun: Promise<Run> | undefined;
  // The address, or the ads export, given on the command line: the first run.
  const first = !runner
    ? undefined
    : adsInput
      ? runner.startAds(adsInput)
      : opts.address !== undefined
        ? runner.start(opts.address)
        : undefined;
  if (first) {
    const { run, finished } = first;
    const print = (e: RunEvent) => {
      if (e.event === "step") opts.onFirstStep?.(e.data.text);
    };
    for (const e of run.events) print(e);
    run.listeners.add(print);
    firstRun = finished.then(() => {
      run.listeners.delete(print);
      return run;
    });
  }
  return {
    url: `http://localhost:${port}/?s=${key}`,
    port,
    host,
    close,
    accepted: () => accepted,
    received: () => received,
    store,
    ...(firstRun ? { firstRun } : {}),
  };
}
