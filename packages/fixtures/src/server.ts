import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** One entry in a fixture's routes.json, keyed by path. */
export interface RouteDef {
  status?: number;
  location?: string;
  headers?: Record<string, string>;
  /** Wait this long before answering. */
  delayMs?: number;
  /** Accept the request and never answer. */
  hang?: boolean;
  /** Answer with this many bytes of generated HTML. */
  bodyBytes?: number;
  /** Answer with this text instead of a file. */
  body?: string;
}

/** Optional fixture.json: extra hosts served by the same files, one origin each. */
export interface FixtureDef {
  hosts?: string[];
}

export interface Fixture {
  /** The first origin. For a multi-host fixture, the logical origin of the first host. */
  origin: string;
  /** Requests per path, across every origin of this fixture. */
  hits: Map<string, number>;
  /** Requests per HTTP method. */
  methods: Map<string, number>;
  /** For multi-host fixtures: logical host -> "127.0.0.1:port", to pass to createFetcher({ hosts }). */
  hosts: Record<string, string>;
  /** The highest number of requests in flight at once. */
  readonly maxConcurrent: number;
  /** Total requests received. */
  readonly total: number;
  close(): Promise<void>;
}

export const SITES_DIR = fileURLToPath(new URL("../sites/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ics": "text/calendar",
};

function fileFor(root: string, path: string): string | undefined {
  const candidates = path.endsWith("/")
    ? [`${path}index.html`]
    : [path, `${path}.html`, `${path}/index.html`];
  for (const c of candidates) {
    const full = join(root, c);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return undefined;
}

/** Decoded, normalised path, or undefined when it tries to leave the fixture folder. */
export function safePath(rawUrl: string): string | undefined {
  // Look at the raw path before any URL parsing: new URL() would resolve "../" away.
  const raw = rawUrl.split(/[?#]/)[0] ?? "";
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (!path.startsWith("/") || path.includes("\0") || path.split(/[\\/]/).includes(".."))
    return undefined;
  return normalize(path).replace(/\\/g, "/");
}

/** Serve the named fixture folder on 127.0.0.1, one port per host. */
export async function startFixture(name: string): Promise<Fixture> {
  const root = resolve(SITES_DIR, name);
  if (!root.startsWith(resolve(SITES_DIR) + sep) || !existsSync(root)) {
    throw new Error(
      `Fixture site "${name}" does not exist: no folder ${join("packages/fixtures/sites", name)}.`,
    );
  }
  const routes: Record<string, RouteDef> = existsSync(join(root, "routes.json"))
    ? (JSON.parse(readFileSync(join(root, "routes.json"), "utf8")) as Record<string, RouteDef>)
    : {};
  const def: FixtureDef = existsSync(join(root, "fixture.json"))
    ? (JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as FixtureDef)
    : {};
  const hits = new Map<string, number>();
  const methods = new Map<string, number>();
  const state = { inFlight: 0, maxConcurrent: 0, total: 0 };
  const sockets = new Set<Socket>();

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    state.total += 1;
    methods.set(req.method ?? "", (methods.get(req.method ?? "") ?? 0) + 1);
    state.inFlight += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
    res.on("close", () => {
      state.inFlight -= 1;
    });
    const path = safePath(req.url ?? "/");
    if (path === undefined) {
      res.writeHead(400, { "content-type": "text/plain" }).end("bad path");
      return;
    }
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const route = routes[path];
    const answer = () => {
      if (route?.hang) return;
      const headers: Record<string, string> = { ...(route?.headers ?? {}) };
      if (route?.location) headers.location = route.location;
      if (route?.bodyBytes !== undefined) {
        const filler = "<p>" + "x".repeat(Math.max(0, route.bodyBytes - 7)) + "</p>";
        res
          .writeHead(route.status ?? 200, { "content-type": TYPES[".html"] ?? "", ...headers })
          .end(filler.slice(0, route.bodyBytes));
        return;
      }
      if (
        route?.body !== undefined ||
        (route?.status && route.status >= 300 && route.status < 400)
      ) {
        res
          .writeHead(route.status ?? 200, { "content-type": TYPES[".txt"] ?? "", ...headers })
          .end(route.body ?? "");
        return;
      }
      const file = fileFor(root, path);
      if (!file) {
        res
          .writeHead(route?.status ?? 404, { "content-type": TYPES[".txt"] ?? "", ...headers })
          .end("not found");
        return;
      }
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      res
        .writeHead(route?.status ?? 200, { "content-type": type, ...headers })
        .end(readFileSync(file));
    };
    if (route?.delayMs) setTimeout(answer, route.delayMs);
    else answer();
  };

  const hostNames = def.hosts && def.hosts.length > 0 ? def.hosts : [undefined];
  const servers: Server[] = [];
  const hosts: Record<string, string> = {};
  for (const host of hostNames) {
    const server = createServer(handle);
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    servers.push(server);
    if (host) hosts[host] = `127.0.0.1:${port}`;
  }
  const firstPort = (servers[0]?.address() as AddressInfo).port;
  return {
    origin: def.hosts?.[0] ? `http://${def.hosts[0]}` : `http://127.0.0.1:${firstPort}`,
    hits,
    methods,
    hosts,
    get maxConcurrent() {
      return state.maxConcurrent;
    },
    get total() {
      return state.total;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
    },
  };
}

/** Run a test body against a fixture and always close it, even when the body throws. */
export async function withFixture<T>(
  name: string,
  body: (site: Fixture) => Promise<T>,
): Promise<T> {
  const site = await startFixture(name);
  try {
    return await body(site);
  } finally {
    await site.close();
  }
}
