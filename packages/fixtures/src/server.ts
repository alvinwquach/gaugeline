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
  /**
   * When the request carries this header with this value (names in lower case), answer with
   * `then` instead: the same address serving another format (a framework's RSC: 1 request).
   */
  ifHeader?: { name: string; value: string; then: RouteDef };
}

/** Optional fixture.json: extra hosts served by the same files, one origin each. */
export interface FixtureDef {
  hosts?: string[];
  /** Serve another fixture folder's files (and routes.json): the same pages behind a gate. */
  files?: string;
  /**
   * A protected preview: every path answers `status` (401) unless the request carries `header`
   * with exactly `value`. `challenge` is sent as WWW-Authenticate; `body` is the login page.
   */
  auth?: { header: string; value: string; status?: number; challenge?: string; body?: string };
}

/** One request as the fixture saw it, headers included: tests assert where a secret went. */
export interface LoggedRequest {
  method: string;
  path: string;
  host: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface Fixture {
  /** The first origin. For a multi-host fixture, the logical origin of the first host. */
  origin: string;
  /** Requests per path, across every origin of this fixture. */
  hits: Map<string, number>;
  /** Requests per HTTP method. */
  methods: Map<string, number>;
  /** Every request in order, with its headers. */
  requests: LoggedRequest[];
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

/** Files whose text may hold the {{origin}} and {{planted:<name>}} placeholders. */
const TEXT_EXTS: ReadonlySet<string> = new Set([".html", ".xml", ".txt", ".js"]);

/**
 * Invented key-shaped values for the leaked-key fixtures, put together here at serve time so no
 * key-shaped string is in the repository for a scanner to flag. None of them is a real key.
 */
export const PLANTED: Readonly<Record<string, string>> = Object.freeze({
  "stripe-secret": ["sk", "live", "GaugelineFixtureNotAKey00"].join("_"),
  "stripe-publishable": ["pk", "live", "GaugelineFixturePublic000"].join("_"),
  "stripe-restricted": ["rk", "live", "GaugelineFixtureRestricted0"].join("_"),
  "stripe-publishable-test": ["pk", "test", "GaugelineFixtureTestPublic00"].join("_"),
  "stripe-publishable-test-shop": ["pk", "test", "GaugelineFixtureTestShop0K7"].join("_"),
});

/** Replace {{planted:<name>}} with the invented value of that name. */
export function withPlanted(text: string): string {
  return text.replace(/\{\{planted:([a-z-]+)\}\}/g, (all, name: string) => PLANTED[name] ?? all);
}

/**
 * Replace {{origin}} with the origin the request was made to, so a sitemap or robots.txt can list
 * absolute addresses on a fixture whose port is chosen at start. On a multi-host fixture that is
 * the logical host the port serves (a hosts mapping connects to 127.0.0.1:port).
 */
export function withOrigin(
  text: string,
  req: IncomingMessage,
  logical: ReadonlyMap<number, string> = new Map(),
): string {
  if (!text.includes("{{origin}}")) return text;
  const host = logical.get(req.socket.localPort ?? 0) ?? req.headers.host ?? "127.0.0.1";
  return text.replaceAll("{{origin}}", `http://${host}`);
}

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
  const def: FixtureDef = existsSync(join(root, "fixture.json"))
    ? (JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as FixtureDef)
    : {};
  const files = def.files ? resolve(SITES_DIR, def.files) : root;
  if (!files.startsWith(resolve(SITES_DIR) + sep) || !existsSync(files))
    throw new Error(
      `Fixture site "${name}": its files folder "${def.files ?? ""}" does not exist.`,
    );
  const routes: Record<string, RouteDef> = existsSync(join(files, "routes.json"))
    ? (JSON.parse(readFileSync(join(files, "routes.json"), "utf8")) as Record<string, RouteDef>)
    : {};
  const ownRoutes = files !== root && existsSync(join(root, "routes.json"));
  if (ownRoutes)
    Object.assign(
      routes,
      JSON.parse(readFileSync(join(root, "routes.json"), "utf8")) as Record<string, RouteDef>,
    );
  const requests: LoggedRequest[] = [];
  const hits = new Map<string, number>();
  /** Port -> logical host, for {{origin}} on multi-host fixtures. */
  const portHosts = new Map<number, string>();
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
    requests.push({
      method: req.method ?? "",
      path,
      host: req.headers.host ?? "",
      headers: { ...req.headers },
    });
    const gate = def.auth;
    if (gate && req.headers[gate.header.toLowerCase()] !== gate.value) {
      res
        .writeHead(gate.status ?? 401, {
          "content-type": gate.body ? (TYPES[".html"] ?? "") : (TYPES[".txt"] ?? ""),
          ...(gate.challenge ? { "www-authenticate": gate.challenge } : {}),
        })
        .end(gate.body ?? "Authentication required");
      return;
    }
    const listed = routes[path];
    const variant = listed?.ifHeader;
    const route =
      variant && req.headers[variant.name.toLowerCase()] === variant.value ? variant.then : listed;
    const answer = () => {
      if (route?.hang) return;
      const headers: Record<string, string> = { ...(route?.headers ?? {}) };
      // {{port}}: the port this request came in on, for a redirect to another origin on it.
      if (route?.location)
        headers.location = route.location.replaceAll("{{port}}", String(req.socket.localPort ?? 0));
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
          .end(withOrigin(route.body ?? "", req, portHosts));
        return;
      }
      const file = fileFor(files, path);
      if (!file) {
        res
          .writeHead(route?.status ?? 404, { "content-type": TYPES[".txt"] ?? "", ...headers })
          .end("not found");
        return;
      }
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      const bytes = readFileSync(file);
      res
        .writeHead(route?.status ?? 200, { "content-type": type, ...headers })
        .end(
          TEXT_EXTS.has(extname(file))
            ? withPlanted(withOrigin(bytes.toString("utf8"), req, portHosts))
            : bytes,
        );
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
    if (host) {
      hosts[host] = `127.0.0.1:${port}`;
      portHosts.set(port, host);
    }
  }
  const firstPort = (servers[0]?.address() as AddressInfo).port;
  return {
    origin: def.hosts?.[0] ? `http://${def.hosts[0]}` : `http://127.0.0.1:${firstPort}`,
    hits,
    methods,
    requests,
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
