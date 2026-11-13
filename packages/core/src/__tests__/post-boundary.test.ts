import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, type Category, type Finding } from "./post-scan.js";

/**
 * Where a request that changes something can be built, and where a connection can be opened as a
 * client. Gaugeline reads: a new file here is a reviewed decision (an ADR), not a line in a feature
 * branch. This list is a safeguard; do not add a file to make a branch pass.
 *
 * - `core/src/transport.ts`: the one module that opens a connection (ADR-0001). The method it
 *   sends is whatever the fetcher gives it, typed "GET" | "HEAD" | "POST" (checked below).
 * - `core/src/fetcher.ts`: `fetcher.query()`, a POST to a registered, documented read-only query
 *   endpoint, with a body checked to be a query (ADR-0006, the owner's decision of 11 Nov 2026).
 *   It is the second and last place a request to a vendor's API is POSTed.
 * - `core/src/notify/post.ts`: notifications to the person's own channels (ADR-0005).
 * - `app/src/api.ts`: the app's page calling its own local server with relative /api/* addresses
 *   (never a checked site): one POST to start a run, and the event stream.
 * - `writer/src/github/endpoints.ts`: ADR-0010 (accepted 12 Nov 2026). The writer's fixed registry of
 *   GitHub requests, run only in the customer's own worker after a recorded approval: create one
 *   `gaugeline/<id>` ref, put contents on that branch, open a draft pull request. Not in the CLI.
 * - `writer/src/github/send.ts`: ADR-0010. The writer's one connection: a `fetch` to api.github.com
 *   whose method is the registered endpoint's, after `checkRequest` has accepted the request. Named here
 *   so the scan reads it (it is a tightening: the file used to be invisible to this list). Any other
 *   file in the writer that opens a connection fails this test and the lint rule on packages/writer.
 * - `writer/src/gmail/endpoints.ts` and `writer/src/gmail/send.ts`: ADR-0010 (X75, Gmail drafts), named the
 *   same way as the two above. The registry has one request, `users.drafts.create` (a POST to
 *   gmail.googleapis.com/gmail/v1/users/me/drafts) and no send; the sender is a `fetch` with the method
 *   the registry gives, after `checkGmailRequest` has accepted the request. The only addition to this
 *   list for X75; for the independent reviewer.
 * - `writer/src/sanity/endpoints.ts` and `writer/src/sanity/send.ts`: ADR-0010, X71. The same two roles
 *   for the content system: a registry of one read and one mutation request that can only create a
 *   `drafts.<id>` copy and set plain fields on it (no live id, no replace, no removal, no action), and the
 *   one `fetch` to `<project>.api.sanity.io`. Named by the same rule as the GitHub pair; nothing is loosened.
 */
const ALLOWED: Readonly<Record<string, readonly Category[]>> = {
  "core/src/transport.ts": ["method", "network"],
  "core/src/fetcher.ts": ["verb"],
  "core/src/notify/post.ts": ["verb", "network"],
  "app/src/api.ts": ["verb", "network"],
  "writer/src/github/endpoints.ts": ["verb"], // ADR-0010
  "writer/src/github/send.ts": ["network", "method"], // ADR-0010
  "writer/src/gmail/endpoints.ts": ["verb"], // ADR-0010, X75
  "writer/src/gmail/send.ts": ["network", "method"], // ADR-0010, X75
  "writer/src/sanity/endpoints.ts": ["verb"], // ADR-0010, X71
  "writer/src/sanity/send.ts": ["network", "method"], // ADR-0010, X71
};

const packagesDir = fileURLToPath(new URL("../../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (["__tests__", "node_modules", "dist"].includes(n)) return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(n) && !/\.(test|spec)\.tsx?$/.test(n) && !n.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

/** Every non-test source file under packages/*\/src, as { path under packages/, text }. */
function allSources(): { file: string; text: string }[] {
  return readdirSync(packagesDir).flatMap((pkg) => {
    const src = join(packagesDir, pkg, "src");
    try {
      if (!statSync(src).isDirectory()) return [];
    } catch {
      return [];
    }
    return sources(src).map((full) => ({
      file: relative(packagesDir, full).split(sep).join("/"),
      text: readFileSync(full, "utf8"),
    }));
  });
}

const isAdapterFile = (file: string) => /^core\/src\/adapters\/[^/]+\.ts$/.test(file);
const isQueryFile = (file: string) => file === "core/src/fetch/query-registry.ts";

function findings(): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const { file, text } of allSources()) {
    const found = scan(file, text, {
      adapterFile: isAdapterFile(file),
      queryFile: isQueryFile(file),
    });
    if (found.length > 0) out.set(file, found);
  }
  return out;
}

describe("ADR-0005 and ADR-0006: where a request that changes something can be built (AST scan)", () => {
  const all = findings();

  it("only the files above build one, open a connection as a client, or register a query endpoint", () => {
    const unexpected: string[] = [];
    for (const [file, found] of all)
      for (const f of found)
        if (!(ALLOWED[file] ?? []).includes(f.category))
          unexpected.push(`${file}:${f.line} [${f.category}] ${f.what}`);
    expect(unexpected).toEqual([]);
  });

  it("each allowed file still does what it is allowed for (a stale entry is removed, not kept)", () => {
    for (const [file, categories] of Object.entries(ALLOWED))
      for (const c of categories)
        expect(
          (all.get(file) ?? []).some((f) => f.category === c),
          `${file} [${c}]`,
        ).toBe(true);
  });

  it("the fetcher builds a POST in one place only, and never PUT, PATCH or DELETE", () => {
    const text = readFileSync(join(packagesDir, "core/src/fetcher.ts"), "utf8");
    const verbs = (all.get("core/src/fetcher.ts") ?? []).filter((f) => f.category === "verb");
    expect(verbs.map((v) => v.what)).toEqual(["the method POST passed to requestOnce()"]);
    expect(text).not.toMatch(/["'`](PUT|PATCH|DELETE)["'`]/);
  });

  it("the transport can send GET, HEAD and POST and no other method", () => {
    const text = readFileSync(join(packagesDir, "core/src/transport.ts"), "utf8");
    expect(text).toMatch(/method: "GET" \| "HEAD" \| "POST";/);
    expect(text).not.toMatch(/"(PUT|PATCH|DELETE)"/);
  });

  it("only an adapter's file registers a query endpoint or calls fetcher.query() with one", () => {
    const where = [...all].flatMap(([file, found]) =>
      found.filter((f) => f.category === "query").map((f) => `${file}:${f.line}`),
    );
    expect(where).toEqual([]);
  });

  describe("the scan catches each way of building a write", () => {
    const hit = (text: string, opts?: Parameters<typeof scan>[2]) =>
      scan("x.ts", text, opts).map((f) => f.category);
    const caught: Array<[string, string, Category]> = [
      ["method: 'POST' in fetch options", 'fetch(u, { method: "POST" })', "verb"],
      ["a lower-case verb", "fetch(u, { method: 'delete' })", "verb"],
      ["a computed key", 'fetch(u, { ["method"]: "PUT" })', "verb"],
      ["a concatenated verb", 'fetch(u, { method: "PO" + "ST" })', "verb"],
      ["a template verb", 'fetch(u, { method: `${"PO"}ST` })', "verb"],
      ["a verb in a variable", 'const method = "PATCH"; send(method);', "verb"],
      ["a verb as an argument", 'client.request("PUT", u)', "verb"],
      ["a verb passed on", 'requestOnce(u, "POST", {})', "verb"],
      ["a method held in a variable", "fetch(u, { method: m })", "method"],
      ["a method that is not a literal", "https.request(u, { method: opts.method })", "method"],
      ["a method-override header", 'headers["X-HTTP-Method-Override"] = "DELETE"', "method"],
      ["an override header in an object", 'x = { "x-original-method": "DELETE" }', "method"],
      ["an override header set by call", 'h.set("X-Method-Override", "PUT")', "method"],
      ["the _method field", 'fetch(u, { _method: "DELETE" })', "verb"],
      ["axios.post", "axios.post(u, body)", "call"],
      ["client.put", "client.put(u, body)", "call"],
      ["a .patch call", "api.patch(u, body)", "call"],
      [".delete in an HTTP client file", 'import got from "got"; got.delete(u);', "call"],
      ["fetch", "fetch(u)", "network"],
      ["new Request", "new Request(u, { method: 'POST' })", "network"],
      ["XMLHttpRequest", "const x = new XMLHttpRequest();", "network"],
      ["a WebSocket", "new WebSocket(u)", "network"],
      ["sendBeacon", "navigator.sendBeacon(u, d)", "network"],
      ["http.request", "http.request(u)", "network"],
      ["https.get", "https.get(u)", "network"],
      ["net.connect", "net.connect(80, h)", "network"],
      ["new net.Socket", "new net.Socket()", "network"],
      ["import of a request function", 'import { request } from "node:https";', "network"],
      ["import of a whole module", 'import * as h from "node:http";', "network"],
      ["a default import", 'import http from "http";', "network"],
      ["a client library", 'import axios from "axios";', "network"],
      ["a dynamic import", 'await import("undici");', "network"],
      ["a require", 'const h = require("node:http");', "network"],
      ["registering a query endpoint", "registerQueryAllow({ id: 'x' });", "query"],
      ["naming the registration", "const r = registerQueryAllow;", "query"],
      ["a query with an allow key", "fetcher.query(u, { allow: 'x', body: {} });", "query"],
    ];
    for (const [name, text, category] of caught)
      it(name, () => {
        expect(hit(text), text).toContain(category);
      });

    it("lets an adapter's file register and call query()", () => {
      const opts = { adapterFile: true };
      expect(hit("registerQueryAllow({ id: 'x' });", opts)).toEqual([]);
      expect(hit("fetcher.query(u, { allow: 'x', body: {} });", opts)).toEqual([]);
    });

    it("leaves a server reading a method, a Map and a type alone", () => {
      expect(hit('if (req.method !== "POST") return;')).toEqual([]);
      expect(hit('switch (m) { case "POST": break; }')).toEqual([]);
      expect(hit('["POST"].includes(m)')).toEqual([]);
      expect(hit("runs.delete(id); map.set(a, b);")).toEqual([]);
      expect(hit('type M = "GET" | "HEAD" | "POST";')).toEqual([]);
      expect(hit('import { createServer, type IncomingMessage } from "node:http";')).toEqual([]);
      expect(hit('import type { Server } from "node:http";')).toEqual([]);
      expect(hit('import { isIP } from "node:net";')).toEqual([]);
      expect(hit('fetch(u, { method: "GET" })')).toEqual(["network"]);
      expect(hit('checkRequest({ method: req.method ?? "GET" })')).toEqual([]);
    });
  });
});
