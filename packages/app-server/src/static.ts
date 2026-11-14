import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

/** The built client's folder holds these two kinds of file: what is served, and the list that vouches for it. */
export const MANIFEST_FILE = "client-manifest.json";

/** One served file, read once at start. `etag` is the quoted sha256 of `body`. */
export interface Asset {
  body: Buffer;
  type: string;
  etag: string;
  immutable: boolean;
}

/** URL path (always starting with "/") to file. The only way a request finds a file: map.get(pathname). */
export type Client = Map<string, Asset>;

/** The folder is not there (the CLI was built alone, or a package was stripped): `gaugeline open` exits 2. */
export class ClientMissingError extends Error {
  constructor(dir: string) {
    super(
      `the app was not built into this package (no ${MANIFEST_FILE} in ${dir}). Reinstall gaugeline, or in a source checkout run pnpm build.`,
    );
    this.name = "ClientMissingError";
  }
}

/** The folder is there but does not match its manifest: nothing is served from it. */
export class ClientIntegrityError extends Error {
  constructor(reason: string) {
    super(`the app's files do not match ${MANIFEST_FILE}: ${reason}. Reinstall gaugeline.`);
    this.name = "ClientIntegrityError";
  }
}

/**
 * Content types by extension. scripts/embed-client.mjs writes the same table into the manifest's
 * `type` field; a test keeps the two in step. The server derives the type itself and never trusts
 * the manifest for it.
 */
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 || path.lastIndexOf("/") > dot ? "" : path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(TYPES, ext) ? (TYPES[ext] as string) : "application/octet-stream";
}

/** Vite's hashed names: assets/<name>-<hash>.<ext>. A new build means a new name, so these never go stale. */
const HASHED = /^assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** A manifest path is a plain relative path with "/" separators. Checked before it is joined to the folder. */
function plainPath(path: unknown): path is string {
  if (typeof path !== "string" || path === "") return false;
  if (/[\\\0:]/.test(path) || path.startsWith("/")) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

function readManifest(dir: string): ManifestEntry[] {
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file)) throw new ClientMissingError(dir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ClientIntegrityError("it is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new ClientIntegrityError("it is not a list");
  return parsed.map((e: unknown, i) => {
    const entry = (e ?? {}) as Partial<ManifestEntry>;
    if (!plainPath(entry.path))
      throw new ClientIntegrityError(`entry ${i} has a path that is not a plain relative path`);
    if (typeof entry.bytes !== "number" || !Number.isInteger(entry.bytes) || entry.bytes < 0)
      throw new ClientIntegrityError(`${entry.path} has no byte count`);
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256))
      throw new ClientIntegrityError(`${entry.path} has no sha256`);
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
  });
}

/**
 * Read the built client once. Every file in the manifest is read, measured and hashed; one that is
 * missing or differs throws, so a damaged install fails at start and not in the browser. Files in
 * the folder that the manifest does not list are never served.
 *
 * A Map, not a path join: a request is a key or a 404. Nothing a browser sends is ever turned into
 * a file name.
 */
export function loadClient(dir: string): Client {
  const entries = readManifest(dir);
  const client: Client = new Map();
  const seen = new Set<string>();
  for (const { path, bytes, sha256 } of entries) {
    if (seen.has(path)) throw new ClientIntegrityError(`${path} is listed twice`);
    seen.add(path);
    let body: Buffer;
    try {
      body = readFileSync(join(dir, path));
    } catch {
      throw new ClientIntegrityError(`${path} is listed but cannot be read`);
    }
    if (body.length !== bytes)
      throw new ClientIntegrityError(`${path} is ${body.length} bytes, the manifest says ${bytes}`);
    if (createHash("sha256").update(body).digest("hex") !== sha256)
      throw new ClientIntegrityError(`${path} has a different sha256 from the manifest`);
    client.set(`/${path}`, {
      body,
      type: contentTypeFor(path),
      etag: `"${sha256}"`,
      immutable: HASHED.test(path),
    });
  }
  const index = client.get("/index.html");
  if (!index) throw new ClientIntegrityError("there is no index.html");
  client.set("/", index);
  return client;
}

/**
 * No inline script, no inline style, no eval, nothing from another origin, and connect-src 'self'
 * means a mistake in escaping cannot send results anywhere. Proposed in G21c.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
});

/** The four headers every response carries, whatever its status. */
export function securityHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS };
}

/**
 * Called once, for every request, before anything can answer it. Headers set here are merged into
 * whatever writeHead is given later, so a 403, a 404, a 500 and an event stream all carry them.
 */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/** The page is never cached, so an upgrade takes effect on the next load; hashed files for a year. */
function cacheControl(path: string, asset: Asset): string {
  if (asset.immutable) return "public, max-age=31536000, immutable";
  return path === "/" || path === "/index.html" ? "no-store" : "no-cache";
}

/** Does If-None-Match name this tag? A list, weak tags and * count. */
function matches(header: string | string[] | undefined, etag: string): boolean {
  if (typeof header !== "string") return false;
  return header.split(",").some((t) => {
    const tag = t.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

const plain = (
  res: ServerResponse,
  status: number,
  text: string,
  extra: Record<string, string> = {},
) =>
  res
    .writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(text)),
      ...extra,
    })
    .end(text);

/**
 * Answer from the Map: GET and HEAD for a known path (304 for a matching If-None-Match), 405 for any
 * other method on a known path, 404 for the rest. There is no fallback to index.html.
 */
export function serveClient(
  client: Client,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  const asset = client.get(pathname);
  if (!asset) {
    plain(res, 404, "Not found.\n");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    plain(res, 405, "Use GET or HEAD here.\n", { allow: "GET, HEAD" });
    return;
  }
  const headers = { etag: asset.etag, "cache-control": cacheControl(pathname, asset) };
  if (matches(req.headers["if-none-match"], asset.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, {
    ...headers,
    "content-type": asset.type,
    "content-length": String(asset.body.length),
  });
  res.end(req.method === "HEAD" ? undefined : asset.body);
}
