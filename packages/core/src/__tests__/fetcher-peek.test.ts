import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../fetcher.js";
import { startServer, type FixtureServer } from "./helpers/server.js";

/**
 * GetOptions.peek (read the first bytes of a body and close the connection), anonymous (no extra
 * headers) and maxRedirects (stop at a redirect). Built for the download route probe (G26a).
 */

let server: FixtureServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const label = (bytes: Uint8Array): string =>
  `${bytes.byteLength}:${Buffer.from(bytes).toString("latin1").slice(0, 4)}`;

describe("fetcher peek", () => {
  it("reads at most maxBytes, hands them to sniff and keeps only the label", async () => {
    server = await startServer({
      "/file": (_req, res) => {
        res.writeHead(200, { "content-type": "application/pdf" }).end(`%PDF${"x".repeat(5000)}`);
      },
    });
    const fetcher = createFetcher({ allowPrivate: true });
    const hops = await fetcher.get(`${server.origin}/file`, {
      peek: { maxBytes: 1024, sniff: label },
    });
    const hop = hops.at(-1);
    expect(hop?.peek).toBe("1024:%PDF");
    expect(hop?.bytes).toBe(1024);
    expect(hop?.body).toBeUndefined();
  });

  it("closes the connection after about maxBytes of a body that is still being sent", async () => {
    let written = 0;
    let closed = false;
    server = await startServer({
      "/big": (_req, res) => {
        res.writeHead(200, { "content-type": "application/zip" });
        res.on("close", () => {
          closed = true;
        });
        // 5 MB, 512 bytes every 20 ms: a client that read it all would take over three minutes.
        const chunk = Buffer.alloc(512, 0x50);
        const timer = setInterval(() => {
          if (closed || written >= 5 * 1024 * 1024) {
            clearInterval(timer);
            if (!closed) res.end();
            return;
          }
          written += chunk.byteLength;
          res.write(chunk);
        }, 20);
      },
    });
    const fetcher = createFetcher({ allowPrivate: true });
    const hops = await fetcher.get(`${server.origin}/big`, {
      peek: { maxBytes: 1024, sniff: label },
    });
    expect(hops.at(-1)?.bytes).toBe(1024);
    await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
    // 1,024 bytes were asked for; the server wrote a few more before it saw the close.
    expect(written).toBeLessThan(64 * 1024);
  });

  it("keeps what arrived when the body is shorter than maxBytes", async () => {
    server = await startServer({
      "/small": (_req, res) => {
        res.writeHead(200).end("hello");
      },
    });
    const fetcher = createFetcher({ allowPrivate: true });
    const hop = (
      await fetcher.get(`${server.origin}/small`, { peek: { maxBytes: 1024, sniff: label } })
    ).at(-1);
    expect(hop?.peek).toBe("5:hell");
    expect(hop?.bytes).toBe(5);
  });
});

describe("fetcher anonymous", () => {
  it("sends no per-address headers (a preview secret) and only the headers it is given", async () => {
    server = await startServer({
      "/a": (_req, res) => {
        res.writeHead(200).end("ok");
      },
    });
    const fetcher = createFetcher({
      allowPrivate: true,
      headersFor: () => ({ authorization: "Bearer preview-secret", cookie: "a=b" }),
    });
    await fetcher.get(`${server.origin}/a`, { anonymous: true });
    const sent = server.log[0]?.headers ?? {};
    expect(sent.authorization).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
    expect(sent.referer).toBeUndefined();
    expect(sent["user-agent"]).toMatch(/^Gaugeline\//);
  });

  it("is a different request from the same address asked with the preview headers", async () => {
    server = await startServer({
      "/a": (_req, res) => {
        res.writeHead(200).end("ok");
      },
    });
    const fetcher = createFetcher({
      allowPrivate: true,
      headersFor: () => ({ authorization: "Bearer preview-secret" }),
    });
    await fetcher.get(`${server.origin}/a`);
    await fetcher.get(`${server.origin}/a`, { anonymous: true });
    expect(server.log.map((r) => r.headers.authorization)).toEqual([
      "Bearer preview-secret",
      undefined,
    ]);
  });
});

describe("fetcher maxRedirects", () => {
  it("returns the redirect itself when maxRedirects is 0, without asking where it points", async () => {
    server = await startServer({
      "/go": (_req, res) => {
        res.writeHead(302, { location: "/login" }).end();
      },
      "/login": (_req, res) => {
        res.writeHead(200).end("sign in");
      },
    });
    const fetcher = createFetcher({ allowPrivate: true });
    const hops = await fetcher.get(`${server.origin}/go`, { maxRedirects: 0 });
    expect(hops).toHaveLength(1);
    expect(hops[0]?.status).toBe(302);
    expect(hops[0]?.headers.location).toBe("/login");
    expect(server.log.map((r) => r.path)).toEqual(["/go"]);
  });

  it("still follows redirects without it", async () => {
    server = await startServer({
      "/go": (_req, res) => {
        res.writeHead(302, { location: "/login" }).end();
      },
      "/login": (_req, res) => {
        res.writeHead(200).end("sign in");
      },
    });
    const fetcher = createFetcher({ allowPrivate: true });
    const hops = await fetcher.get(`${server.origin}/go`);
    expect(hops.map((h) => h.status)).toEqual([302, 200]);
  });
});
