import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startApp, type RunningApp } from "../server.js";
import {
  applySecurityHeaders,
  ClientIntegrityError,
  ClientMissingError,
  CONTENT_SECURITY_POLICY,
  contentTypeFor,
  loadClient,
  securityHeaders,
} from "../static.js";
import { SAMPLE_FILES, scratchClientDir, testClientDir } from "./helpers/client.js";

const JS = "assets/app-aB3dE5gH.js";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** One raw HTTP/1.1 request, headers exactly as given. Returns the head lines (lowercased names) and the body. */
function raw(
  port: number,
  lines: string[],
): Promise<{ status: number; headers: Map<string, string>; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const c = connect({ host: "127.0.0.1", port }, () =>
      c.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`),
    );
    let data = "";
    c.on("data", (d) => (data += d.toString()));
    c.on("end", () => {
      const i = data.indexOf("\r\n\r\n");
      const head = data.slice(0, i);
      const headers = new Map<string, string>();
      for (const l of head.split("\r\n").slice(1)) {
        const k = l.indexOf(":");
        headers.set(l.slice(0, k).toLowerCase(), l.slice(k + 1).trim());
      }
      resolve({
        status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0),
        headers,
        head,
        body: data.slice(i + 4),
      });
    });
    c.on("error", reject);
  });
}

/** The app with its link opened: `get` and `send` carry the session cookie and the app's own Host. */
async function opened(port: number, clientDir = testClientDir()) {
  const app = await startApp({ port, clientDir });
  const host = `localhost:${app.port}`;
  const link = await raw(app.port, [
    `GET /${new URL(app.url).search} HTTP/1.1`,
    `Host: ${host}`,
    "Sec-Fetch-Site: none",
  ]);
  const cookie = /^set-cookie: ([^;]+)/im.exec(link.head)?.[1] ?? "";
  const send = (method: string, path: string, extra: string[] = []) =>
    raw(app.port, [
      `${method} ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Cookie: ${cookie}`,
      `Origin: http://${host}`,
      ...extra,
    ]);
  return {
    app,
    host,
    cookie,
    send,
    get: (path: string, extra: string[] = []) => send("GET", path, extra),
  };
}

const withApp = async (
  port: number,
  fn: (o: Awaited<ReturnType<typeof opened>>) => Promise<void>,
  clientDir?: string,
) => {
  const o = await opened(port, clientDir);
  try {
    await fn(o);
  } finally {
    await o.app.close();
  }
};

const WANT_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

describe("embedded client: unit", () => {
  it("loadClient: the right type for .html, .js, .css, .svg, .woff2 and .json", () => {
    const dir = scratchClientDir({
      "index.html": "<!doctype html>",
      "assets/a-12345678.js": "1",
      "assets/a-12345678.css": "2",
      "icon.svg": "<svg/>",
      "assets/f-12345678.woff2": "w",
      "data.json": "{}",
    });
    const client = loadClient(dir);
    const types = Object.fromEntries([...client].map(([k, v]) => [k, v.type]));
    expect(types).toEqual({
      "/": "text/html; charset=utf-8",
      "/index.html": "text/html; charset=utf-8",
      "/assets/a-12345678.js": "text/javascript; charset=utf-8",
      "/assets/a-12345678.css": "text/css; charset=utf-8",
      "/icon.svg": "image/svg+xml",
      "/assets/f-12345678.woff2": "font/woff2",
      "/data.json": "application/json; charset=utf-8",
    });
  });

  it("an extension that is not in the table is application/octet-stream, in any case", () => {
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("noextension")).toBe("application/octet-stream");
    expect(contentTypeFor("a/b.JS")).toBe("text/javascript; charset=utf-8");
  });

  it("keys: '/' and '/index.html' share one asset; hashed files under assets/ are immutable, the rest are not", () => {
    const client = loadClient(testClientDir());
    expect([...client.keys()].sort()).toEqual([
      "/",
      "/assets/app-aB3dE5gH.js",
      "/assets/app-kL7mN9pQ.css",
      "/index.html",
    ]);
    expect(client.get("/")).toBe(client.get("/index.html"));
    expect(client.get("/")?.immutable).toBe(false);
    expect(client.get(`/${JS}`)?.immutable).toBe(true);
    const odd = loadClient(
      scratchClientDir({ "index.html": "x", "assets/plain.js": "p", "favicon.ico": "f" }),
    );
    expect([odd.get("/assets/plain.js")?.immutable, odd.get("/favicon.ico")?.immutable]).toEqual([
      false,
      false,
    ]);
  });

  it("the ETag is the quoted sha256 of the bytes", () => {
    const asset = loadClient(testClientDir()).get(`/${JS}`);
    expect(asset?.etag).toBe(`"${sha(SAMPLE_FILES[JS] ?? "")}"`);
  });

  it("a file whose bytes do not match the manifest throws at start, naming the file", () => {
    const dir = scratchClientDir();
    writeFileSync(join(dir, JS), 'document.body.innerHTML = "changed";\n');
    expect(() => loadClient(dir)).toThrow(ClientIntegrityError);
    expect(() => loadClient(dir)).toThrow(JS);
  });

  it("a file the manifest lists but the folder lacks, a wrong size, and a wrong hash all throw", () => {
    const missing = scratchClientDir(SAMPLE_FILES, (e) => [
      ...e,
      { path: "assets/gone-12345678.js", type: "x", bytes: 1, gzipBytes: 1, sha256: sha("x") },
    ]);
    expect(() => loadClient(missing)).toThrow(ClientIntegrityError);
    const size = scratchClientDir(SAMPLE_FILES, (e) =>
      e.map((x) => ({ ...x, bytes: x.bytes + 1 })),
    );
    expect(() => loadClient(size)).toThrow(/bytes/);
    const hash = scratchClientDir(SAMPLE_FILES, (e) =>
      e.map((x) => ({ ...x, sha256: sha("other") })),
    );
    expect(() => loadClient(hash)).toThrow(/sha256/);
  });

  it("a manifest path that leaves the folder, or is not plain, is refused before any file is read", () => {
    for (const path of [
      "../outside.js",
      "/etc/passwd",
      "a\\b.js",
      "a//b.js",
      "./index.html",
      "a/../b.js",
      "",
    ]) {
      const dir = scratchClientDir(SAMPLE_FILES, (e) => [
        ...e,
        { path, type: "x", bytes: 1, gzipBytes: 1, sha256: sha("x") },
      ]);
      expect(() => loadClient(dir), JSON.stringify(path)).toThrow(ClientIntegrityError);
    }
  });

  it("a manifest without index.html, with a duplicate path, or that is not a list is refused", () => {
    expect(() => loadClient(scratchClientDir({ "assets/a-12345678.js": "1" }))).toThrow(
      /index\.html/,
    );
    expect(() =>
      loadClient(scratchClientDir(SAMPLE_FILES, (e) => [...e, ...e.slice(0, 1)])),
    ).toThrow(/twice/);
    const dir = scratchClientDir();
    writeFileSync(join(dir, "client-manifest.json"), '{"files":[]}');
    expect(() => loadClient(dir)).toThrow(ClientIntegrityError);
    writeFileSync(join(dir, "client-manifest.json"), "{nope");
    expect(() => loadClient(dir)).toThrow(ClientIntegrityError);
  });

  it("a missing folder, or a folder with no manifest, is ClientMissingError with the one-line message", () => {
    const empty = mkdtempSync(join(tmpdir(), "gaugeline-empty-"));
    try {
      for (const dir of [join(empty, "nope"), empty]) {
        expect(() => loadClient(dir)).toThrow(ClientMissingError);
        expect(() => loadClient(dir)).toThrow("the app was not built into this package");
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("the header function returns the same four headers for every status code", async () => {
    expect(securityHeaders()).toEqual(WANT_HEADERS);
    expect(CONTENT_SECURITY_POLICY).toBe(WANT_HEADERS["content-security-policy"]);
    // Applied to a real response before it is written, whatever the status.
    let status = 0;
    const server: Server = createServer((_req, res) => {
      applySecurityHeaders(res);
      res.writeHead(status, { "content-type": "text/plain" }).end(status === 304 ? undefined : "x");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      for (const s of [200, 202, 303, 304, 400, 403, 404, 405, 413, 429, 500]) {
        status = s;
        const r = await raw(port, ["GET / HTTP/1.1", "Host: 127.0.0.1"]);
        expect(r.status).toBe(s);
        expect(
          Object.fromEntries([...r.headers].filter(([k]) => k in WANT_HEADERS)),
          String(s),
        ).toEqual(WANT_HEADERS);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("the policy is the spec's: nothing allowed that the client does not need", () => {
    const directives = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]),
    );
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe|\*|https?:/);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
  });
});

describe("embedded client: integration (real sockets)", () => {
  it("GET /assets/<hashed>.js: 200 with the immutable cache header; a repeat with If-None-Match is 304 and empty", async () => {
    await withApp(
      5110,
      async ({ get }) => {
        const first = await get(`/${JS}`);
        expect(first.status).toBe(200);
        expect(first.body).toBe(SAMPLE_FILES[JS]);
        expect(first.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        const etag = first.headers.get("etag") ?? "";
        expect(etag).toBe(`"${sha(SAMPLE_FILES[JS] ?? "")}"`);
        const again = await get(`/${JS}`, [`If-None-Match: ${etag}`]);
        expect([again.status, again.body]).toEqual([304, ""]);
        expect(again.headers.get("etag")).toBe(etag);
        expect(again.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(again.headers.get("content-security-policy")).toBe(
          WANT_HEADERS["content-security-policy"],
        );
        // A list, a weak tag and a star match too; another tag does not.
        for (const header of [`"nope", ${etag}`, `W/${etag}`, "*"])
          expect((await get(`/${JS}`, [`If-None-Match: ${header}`])).status, header).toBe(304);
        expect((await get(`/${JS}`, ['If-None-Match: "nope"'])).status).toBe(200);
      },
      undefined,
    );
  });

  it("GET / and /index.html: no-store, and the HTML references only paths that are in the manifest", async () => {
    await withApp(5120, async ({ get }) => {
      const client = loadClient(testClientDir());
      for (const path of ["/", "/index.html"]) {
        const r = await get(path);
        expect(r.status).toBe(200);
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
        const refs = [...r.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? "");
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs)
          expect(client.has(new URL(ref, "http://x/").pathname), ref).toBe(true);
      }
      // The page can be answered with 304 too, but a browser told no-store does not ask.
      const etag = (await get("/")).headers.get("etag") ?? "";
      expect((await get("/", [`If-None-Match: ${etag}`])).status).toBe(304);
    });
  });

  it("403 (no cookie), 404, 405 and the event stream all carry the Content-Security-Policy and the other three headers", async () => {
    await withApp(5130, async ({ app, host, send, get }) => {
      const noCookie = await raw(app.port, ["GET / HTTP/1.1", `Host: ${host}`]);
      const run = app.store.add("https://a.example/");
      app.store.emit(run, { event: "failed", data: { reason: "stopped for the test" } });
      run.state = "failed";
      const answers = {
        403: noCookie,
        404: await get("/nothing-here"),
        405: await send("POST", "/api/runs"),
        stream: await get(`/api/runs/${run.id}/events`),
        asset: await get(`/${JS}`),
        page: await get("/"),
        api404: await get("/api/nope"),
      };
      expect(answers[403].status).toBe(403);
      expect(answers[404].status).toBe(404);
      expect(answers[405].status).toBe(405);
      expect(answers.stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(answers.stream.status).toBe(200);
      for (const [name, r] of Object.entries(answers))
        expect(Object.fromEntries([...r.headers].filter(([k]) => k in WANT_HEADERS)), name).toEqual(
          WANT_HEADERS,
        );
    });
  });

  it("the link's 303 and an unknown host's refusal carry them too", async () => {
    const app = await startApp({ port: 5135, clientDir: testClientDir() });
    try {
      const link = await raw(app.port, [
        `GET /${new URL(app.url).search} HTTP/1.1`,
        `Host: localhost:${app.port}`,
      ]);
      const other = await raw(app.port, ["GET / HTTP/1.1", "Host: evil.example"]);
      expect([link.status, other.status]).toEqual([303, 403]);
      for (const r of [link, other])
        expect(r.headers.get("content-security-policy")).toBe(
          WANT_HEADERS["content-security-policy"],
        );
    } finally {
      await app.close();
    }
  });

  it("GET /../package.json, /%2e%2e/package.json and /assets/..%2f..%2fpackage.json are 404", async () => {
    await withApp(5140, async ({ get }) => {
      for (const path of [
        "/../package.json",
        "/%2e%2e/package.json",
        "/assets/..%2f..%2fpackage.json",
        "/assets/../../package.json",
        "/assets/%2e%2e/%2e%2e/package.json",
        "/client-manifest.json",
        "/%2e/client-manifest.json",
        "//index.html",
        "/index.html/",
        "/assets/",
        "/%61ssets/app-aB3dE5gH.js",
      ]) {
        const r = await get(path);
        expect(r.status, path).toBe(404);
        expect(r.body, path).toBe("Not found.\n");
      }
    });
  });

  it("unknown paths are 404 and API paths never fall back to the page", async () => {
    await withApp(5150, async ({ get }) => {
      const missingAsset = await get("/assets/app-zzzzzzzz.js");
      expect([missingAsset.status, missingAsset.body]).toEqual([404, "Not found.\n"]);
      const route = await get("/some/client/route");
      expect(route.status).toBe(404);
      const api = await get("/api/nope");
      expect(api.status).toBe(404);
      expect(api.headers.get("content-type")).toContain("application/json");
      expect(api.body).not.toContain("<html");
    });
  });

  it("a HEAD request for an asset returns the headers and no body", async () => {
    await withApp(5160, async ({ send }) => {
      const head = await send("HEAD", `/${JS}`);
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers.get("content-length")).toBe(
        String(Buffer.byteLength(SAMPLE_FILES[JS] ?? "")),
      );
      expect(head.headers.get("etag")).toBe(`"${sha(SAMPLE_FILES[JS] ?? "")}"`);
      expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(head.headers.get("content-security-policy")).toBe(
        WANT_HEADERS["content-security-policy"],
      );
      const page = await send("HEAD", "/");
      expect([page.status, page.body, page.headers.get("cache-control")]).toEqual([
        200,
        "",
        "no-store",
      ]);
    });
  });

  it("other methods on a client path are 405 with Allow: GET, HEAD; on an unknown path they stay 404", async () => {
    await withApp(5170, async ({ send }) => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const r = await send(method, `/${JS}`);
        expect([r.status, r.headers.get("allow")], method).toEqual([405, "GET, HEAD"]);
      }
      expect((await send("POST", "/nothing-here")).status).toBe(404);
    });
  });

  it("a manifest entry with an unknown extension is served as application/octet-stream with nosniff", async () => {
    const dir = scratchClientDir({
      ...SAMPLE_FILES,
      "assets/blob-12345678.bin": "\u0000\u0001<script>alert(1)</script>",
    });
    await withApp(
      5180,
      async ({ get }) => {
        const r = await get("/assets/blob-12345678.bin");
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("application/octet-stream");
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      },
      dir,
    );
  });

  it("a folder that fails its checks stops startApp before it listens: the port stays free", async () => {
    const dir = scratchClientDir();
    writeFileSync(join(dir, JS), "tampered");
    await expect(startApp({ port: 5190, clientDir: dir })).rejects.toBeInstanceOf(
      ClientIntegrityError,
    );
    await expect(startApp({ port: 5190 })).rejects.toBeInstanceOf(ClientMissingError);
    const app: RunningApp = await startApp({ port: 5190, clientDir: testClientDir() });
    expect(app.port).toBe(5190);
    await app.close();
  });

  it("the client is read once at start: changing a file afterwards changes nothing that is served", async () => {
    const dir = scratchClientDir();
    await withApp(
      5200,
      async ({ get }) => {
        writeFileSync(join(dir, JS), "changed after start");
        expect((await get(`/${JS}`)).body).toBe(SAMPLE_FILES[JS]);
      },
      dir,
    );
  });
});
