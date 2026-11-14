// check-community: allow-email (invented addresses at reserved example domains, used by the test)
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  FetchError,
  assertReadOnly,
  createFetcher,
  normaliseUrl,
  DEFAULT_USER_AGENT,
} from "../fetcher.js";
import { Semaphore } from "../semaphore.js";
import {
  html,
  redirect,
  startRawServer,
  startServer,
  type FixtureServer,
} from "./helpers/server.js";

const servers: Array<{ close(): Promise<void> }> = [];
async function serve(...args: Parameters<typeof startServer>): Promise<FixtureServer> {
  const s = await startServer(...args);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("normaliseUrl: unit", () => {
  const pairs: Array<[string, string]> = [
    ["https://example.com", "https://example.com/"],
    ["HTTPS://EXAMPLE.COM/", "https://example.com/"],
    ["https://Example.COM/Path", "https://example.com/Path"],
    ["https://example.com:443/", "https://example.com/"],
    ["http://example.com:80/a", "http://example.com/a"],
    ["https://example.com:8443/a", "https://example.com:8443/a"],
    ["http://example.com:443/", "http://example.com:443/"],
    ["https://example.com/#top", "https://example.com/"],
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1"],
    ["https://example.com/a?b=2&a=1", "https://example.com/a?b=2&a=1"],
    ["https://example.com/a/", "https://example.com/a/"],
    ["https://example.com/a", "https://example.com/a"],
    ["https://b\u00FCcher.example/", "https://xn--bcher-kva.example/"],
    ["https://B\u00DCCHER.example/men\u00FC", "https://xn--bcher-kva.example/men%C3%BC"],
    ["https://example.com/a b", "https://example.com/a%20b"],
    ["  https://example.com/x \n", "https://example.com/x"],
    ["https://example.com/?", "https://example.com/?"],
    ["https://example.com/a/../b", "https://example.com/b"],
    ["https://user@example.com/", "https://user@example.com/"],
    ["https://example.com./", "https://example.com./"],
  ];
  it.each(pairs)("%s -> %s", (input, expected) => {
    expect(normaliseUrl(input)).toBe(expected);
  });
  it("has 20 pairs", () => expect(pairs).toHaveLength(20));
});

describe("semaphore and read-only: unit", () => {
  it("semaphore never exceeds 5 in flight over 50 queued tasks, and releases in FIFO order", async () => {
    const gate = new Semaphore(5);
    let current = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        gate.run(async () => {
          order.push(i);
          current += 1;
          max = Math.max(max, current);
          await new Promise((r) => setTimeout(r, 1 + (i % 3)));
          current -= 1;
        }),
      ),
    );
    expect(max).toBe(5);
    expect(gate.maxInFlight).toBe(5);
    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("the fetcher never has more than 5 requests in flight over 50 queued gets", async () => {
    const s = await serve({}, async (_req, res) => {
      await new Promise((r) => setTimeout(r, 15));
      res.writeHead(200).end("ok");
    });
    const f = createFetcher({ allowPrivate: true });
    await Promise.all(Array.from({ length: 50 }, (_, i) => f.get(`${s.origin}/p${i}`)));
    expect(f.stats.requests).toBe(50);
    expect(f.stats.maxInFlight).toBeLessThanOrEqual(5);
    expect(s.maxConcurrent).toBeLessThanOrEqual(5);
    expect(s.log).toHaveLength(50);
  });

  it("assertReadOnly throws for POST, PUT, PATCH, DELETE and allows GET and HEAD", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "OPTIONS"]) {
      expect(() => assertReadOnly(m), m).toThrow(/read-only/);
    }
    expect(() => assertReadOnly("GET")).not.toThrow();
    expect(() => assertReadOnly("HEAD")).not.toThrow();
  });

  it("get() refuses a non-read method even when the type is bypassed", () => {
    const f = createFetcher({ allowPrivate: true });
    expect(() => f.get("http://127.0.0.1:1/", { method: "POST" as "GET" })).toThrow(/read-only/);
  });
});

describe("fetcher: integration (real sockets)", () => {
  it("301 -> 302 -> 200 returns three hops with each status preserved", async () => {
    const s = await serve({
      "/a": redirect(301, "/b"),
      "/b": redirect(302, "/c"),
      "/c": html("<h1>done</h1>"),
    });
    const hops = await createFetcher({ allowPrivate: true }).get(`${s.origin}/a`);
    expect(hops.map((h) => [new URL(h.url).pathname, h.status])).toEqual([
      ["/a", 301],
      ["/b", 302],
      ["/c", 200],
    ]);
    expect(hops[2]?.body).toBe("<h1>done</h1>");
    expect(hops[0]?.headers.location).toBe("/b");
    expect(hops.every((h) => h.ms >= 0)).toBe(true);
  });

  it("sends the named user agent and only GET", async () => {
    const s = await serve({ "/": html("x") });
    await createFetcher({ allowPrivate: true }).get(s.origin);
    expect(s.log[0]?.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(s.log[0]?.method).toBe("GET");
  });

  it("HEAD requests are sent as HEAD and carry no body", async () => {
    const s = await serve({ "/": html("x") });
    const hops = await createFetcher({ allowPrivate: true }).get(s.origin, { method: "HEAD" });
    expect(s.log[0]?.method).toBe("HEAD");
    expect(hops[0]?.body).toBeUndefined();
  });

  it('redirect loop a -> b -> a stops with a "loop" error, not a hang', async () => {
    const s = await serve({ "/a": redirect(301, "/b"), "/b": redirect(301, "/a") });
    const err = await createFetcher({ allowPrivate: true })
      .get(`${s.origin}/a`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).reason).toBe("loop");
    expect((err as FetchError).hops).toHaveLength(2);
  });

  it('11 hops stops at 10 with "too many redirects"', async () => {
    const routes: Record<string, ReturnType<typeof redirect>> = {};
    for (let i = 0; i < 11; i++) routes[`/r${i}`] = redirect(302, `/r${i + 1}`);
    const s = await serve({ ...routes, "/r11": html("end") });
    const err = await createFetcher({ allowPrivate: true })
      .get(`${s.origin}/r0`)
      .catch((e: unknown) => e);
    expect((err as FetchError).reason).toBe("too-many-redirects");
    expect((err as FetchError).message).toContain("too many redirects");
    expect((err as FetchError).hops).toHaveLength(10);
    expect(s.log).toHaveLength(10);
  });

  it("a chain of 9 redirects and a 200 is followed in full", async () => {
    const routes: Record<string, ReturnType<typeof redirect>> = {};
    for (let i = 0; i < 9; i++) routes[`/r${i}`] = redirect(301, `/r${i + 1}`);
    const s = await serve({ ...routes, "/r9": html("end") });
    const hops = await createFetcher({ allowPrivate: true }).get(`${s.origin}/r0`);
    expect(hops).toHaveLength(10);
    expect(hops.at(-1)?.status).toBe(200);
  });

  it("the same URL requested twice hits the server once, even at the same moment", async () => {
    const s = await serve({ "/": html("x") });
    const f = createFetcher({ allowPrivate: true });
    const [a, b] = await Promise.all([f.get(`${s.origin}/`), f.get(`${s.origin}/#frag`)]);
    await f.get(s.origin.toUpperCase().replace("HTTP", "http"));
    expect(a).toBe(b);
    expect(s.log).toHaveLength(1);
  });

  it("fresh: true asks again and keeps the new answer, for a retry after a refusal it remembers", async () => {
    let calls = 0;
    const s = await serve({
      "/": (_req, res) => {
        calls++;
        res.writeHead(calls === 1 ? 429 : 200, { "content-type": "text/plain" }).end("x");
      },
    });
    const f = createFetcher({ allowPrivate: true });
    expect((await f.get(`${s.origin}/`)).at(-1)?.status).toBe(429);
    expect((await f.get(`${s.origin}/`)).at(-1)?.status).toBe(429);
    expect(calls).toBe(1);
    expect((await f.get(`${s.origin}/`, { fresh: true })).at(-1)?.status).toBe(200);
    expect((await f.get(`${s.origin}/`)).at(-1)?.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("https refused, http answers: fallback used and recorded", async () => {
    const s = await serve({ "/": html("plain") });
    const host = `127.0.0.1:${s.port}`;
    const hops = await createFetcher({ allowPrivate: true, timeoutMs: 2000 }).getSite(host);
    expect(hops[0]?.url).toBe(`http://${host}/`);
    expect(hops[0]?.fallbackFrom).toBe(`https://${host}/`);
    expect(hops[0]?.body).toBe("plain");
  });

  it("an explicit https address is never downgraded", async () => {
    const s = await serve({ "/": html("plain") });
    const err = await createFetcher({ allowPrivate: true, timeoutMs: 2000 })
      .getSite(`https://127.0.0.1:${s.port}/`)
      .catch((e: unknown) => e);
    expect((err as FetchError).reason).toBe("tls");
  });
});

describe("fetcher: edge cases", () => {
  it("relative Location header is resolved against the current address", async () => {
    const s = await serve({ "/shop/a": redirect(301, "b?x=1"), "/shop/b": html("b") });
    const hops = await createFetcher({ allowPrivate: true }).get(`${s.origin}/shop/a`);
    expect(hops[1]?.url).toBe(`${s.origin}/shop/b?x=1`);
  });

  it("Location with spaces is trimmed and encoded", async () => {
    const s = await serve({ "/a": redirect(301, "  /new page  "), "/new%20page": html("ok") });
    const hops = await createFetcher({ allowPrivate: true }).get(`${s.origin}/a`);
    expect(hops[1]?.url).toBe(`${s.origin}/new%20page`);
    expect(hops[1]?.status).toBe(200);
  });

  it("missing Location on a 301 ends the trail at the 301", async () => {
    const s = await serve({ "/a": (_q, r) => void r.writeHead(301).end() });
    const hops = await createFetcher({ allowPrivate: true }).get(`${s.origin}/a`);
    expect(hops).toHaveLength(1);
    expect(hops[0]?.status).toBe(301);
    expect(hops[0]?.headers.location).toBeUndefined();
  });

  it("a server that accepts the socket and never responds: timeout, typed error, run continues", async () => {
    const raw = await startRawServer(() => undefined);
    servers.push(raw);
    const ok = await serve({ "/": html("fine") });
    const f = createFetcher({ allowPrivate: true, timeoutMs: 300 });
    const started = Date.now();
    const [silent, fine] = await Promise.allSettled([f.get(raw.origin), f.get(ok.origin)]);
    expect(silent.status).toBe("rejected");
    const err = (silent as PromiseRejectedResult).reason as FetchError;
    expect(err).toBeInstanceOf(FetchError);
    expect(err.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(fine.status).toBe("fulfilled");
  });

  it("6 MB body: truncated at 5 MB and flagged", async () => {
    const big = "a".repeat(6 * 1024 * 1024);
    const s = await serve({ "/": html(big) });
    const hops = await createFetcher({ allowPrivate: true }).get(s.origin);
    expect(hops[0]?.body?.length).toBe(5 * 1024 * 1024);
    expect(hops[0]?.truncated).toBe(true);
  });

  it("maxBytes cuts a body short of the fetcher's own cap and flags it; it cannot raise the cap", async () => {
    const s = await serve({ "/": html("a".repeat(3000)) });
    const fetcher = createFetcher({ allowPrivate: true, maxBodyBytes: 2000 });
    const cut = await fetcher.get(s.origin, { maxBytes: 500 });
    expect(cut[0]?.body?.length).toBe(500);
    expect(cut[0]?.truncated).toBe(true);
    const higher = await fetcher.get(s.origin, { maxBytes: 100_000 });
    expect(higher[0]?.body?.length).toBe(2000);
    expect(higher[0]?.truncated).toBe(true);
  });

  it("a body under the cap is not flagged", async () => {
    const s = await serve({ "/": html("small") });
    expect(
      (await createFetcher({ allowPrivate: true }).get(s.origin))[0]?.truncated,
    ).toBeUndefined();
  });

  it("gzip body with a wrong Content-Length: what arrived is kept and flagged, no crash", async () => {
    const gz = gzipSync(Buffer.from("<html><body>" + "hello ".repeat(2000) + "</body></html>"));
    const raw = await startRawServer((socket) => {
      socket.once("data", () => {
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length + 500}\r\nConnection: close\r\n\r\n`,
        );
        socket.end(gz);
      });
    });
    servers.push(raw);
    const result = await createFetcher({ allowPrivate: true, timeoutMs: 2000 })
      .get(raw.origin)
      .then((hops) => ({ hops }))
      .catch((err: unknown) => ({ err }));
    if ("hops" in result) {
      expect(result.hops[0]?.status).toBe(200);
      expect(result.hops[0]?.truncated).toBe(true);
    } else {
      expect(result.err).toBeInstanceOf(FetchError);
    }
  });

  it("gzip body with a Content-Length shorter than the data is decoded from what was declared", async () => {
    const gz = gzipSync(Buffer.from("<p>" + "x".repeat(5000) + "</p>"));
    const raw = await startRawServer((socket) => {
      socket.once("data", () => {
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length - 10}\r\nConnection: close\r\n\r\n`,
        );
        socket.end(gz);
      });
    });
    servers.push(raw);
    const result = await createFetcher({ allowPrivate: true, timeoutMs: 2000 })
      .get(raw.origin)
      .then((hops) => ({ hops }))
      .catch((err: unknown) => ({ err }));
    if ("hops" in result) expect(result.hops[0]?.status).toBe(200);
    else expect(result.err).toBeInstanceOf(FetchError);
  });

  it("a refused connection is a typed network error with no hops", async () => {
    const s = await serve({});
    const origin = s.origin;
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    const err = (await createFetcher({ allowPrivate: true })
      .get(origin)
      .catch((e: unknown) => e)) as FetchError;
    expect(err.reason).toBe("refused");
    expect(err.hops).toEqual([]);
  });
});
