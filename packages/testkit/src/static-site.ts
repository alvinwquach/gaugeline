import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Transport, TransportResponse } from "@gaugeline/core";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function respond(status: number, type: string, body: Buffer): TransportResponse {
  return { status, headers: { "content-type": type }, body: Readable.from([body]) };
}

/**
 * Serve a folder of files as one logical host, in memory: no socket, no DNS. A request for any
 * other host goes to `others`. `/` is index.html; a path with no extension tries .html; a missing
 * file is a 404. For tests that need a site on a name that is not 127.0.0.1 (listings compare the
 * site's host with the host a listing links to). With `origin`, {{origin}} in a page or sitemap is
 * replaced by it, as the fixture server does.
 */
export function staticSite(
  host: string,
  dir: string,
  others: Transport,
  options: { origin?: string } = {},
): Transport {
  const root = resolve(dir);
  // A page or sitemap that holds the {{origin}} placeholder (as the fixture server's files do) gets the origin asked for.
  const filled = (type: string, body: Buffer): Buffer =>
    options.origin !== undefined && /^(text|application\/xml)/.test(type)
      ? Buffer.from(body.toString("utf8").replaceAll("{{origin}}", options.origin))
      : body;
  return (url, req) => {
    if (url.hostname !== host) return others(url, req);
    const path = decodeURIComponent(url.pathname);
    const rel = path.endsWith("/") ? `${path}index.html` : path;
    for (const candidate of extname(rel) ? [rel] : [rel, `${rel}.html`]) {
      const file = resolve(join(root, candidate));
      if (file !== root && !file.startsWith(root + sep)) continue;
      try {
        if (statSync(file).isFile())
          return Promise.resolve(
            (() => {
              const type = TYPES[extname(file)] ?? "application/octet-stream";
              return respond(200, type, filled(type, readFileSync(file)));
            })(),
          );
      } catch {
        // not there: try the next candidate
      }
    }
    return Promise.resolve(
      respond(404, "text/html", Buffer.from("<!doctype html><title>Not found</title>")),
    );
  };
}
