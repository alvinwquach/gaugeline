import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../fetcher.js";
import { inKind, requestRows } from "../request-log.js";
import { startServer, type FixtureServer } from "./helpers/server.js";

const servers: FixtureServer[] = [];
async function serve(...args: Parameters<typeof startServer>): Promise<FixtureServer> {
  const s = await startServer(...args);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const send =
  (status: number, headers: Record<string, string> = {}, body = "ok") =>
  (_req: unknown, res: ServerResponse) => {
    res.writeHead(status, { "content-type": "text/plain", ...headers }).end(body);
  };

describe("the fetcher's request history: unit", () => {
  it("records every hop of a redirect chain, each with its status and where it pointed", async () => {
    const s = await serve({
      "/a": send(301, { location: "/b" }),
      "/b": send(302, { location: "/c" }),
      "/c": send(200),
    });
    const fetcher = createFetcher({ allowPrivate: true });
    await fetcher.get(`${s.origin}/a`);
    const records = fetcher.history?.() ?? [];
    expect(records.map((r) => [r.url, r.status, r.location ?? null, r.method])).toEqual([
      [`${s.origin}/a`, 301, `${s.origin}/b`, "GET"],
      [`${s.origin}/b`, 302, `${s.origin}/c`, "GET"],
      [`${s.origin}/c`, 200, null, "GET"],
    ]);
    expect(records.map((r) => r.hop)).toEqual([0, 1, 2]);
    expect(new Set(records.map((r) => r.chain)).size).toBe(1);
    expect(s.log).toHaveLength(3);
  });

  it("the number of records equals the number of requests the server saw, HEAD included", async () => {
    const s = await serve({ "/x": send(200), "/y": send(404) });
    const fetcher = createFetcher({ allowPrivate: true });
    await fetcher.get(`${s.origin}/x`);
    await fetcher.get(`${s.origin}/x`, { method: "HEAD" });
    await fetcher.get(`${s.origin}/y`);
    expect(fetcher.history?.().map((r) => r.method)).toEqual(["GET", "HEAD", "GET"]);
    expect(fetcher.history?.()).toHaveLength(s.log.length);
  });

  it("an address asked for twice is one request and one record", async () => {
    const s = await serve({ "/x": send(200) });
    const fetcher = createFetcher({ allowPrivate: true });
    await Promise.all([fetcher.get(`${s.origin}/x`), fetcher.get(`${s.origin}/x`)]);
    expect(fetcher.history?.()).toHaveLength(1);
    expect(s.log).toHaveLength(1);
  });

  it("takes the kind from the nearest inKind, and is 'other' outside one", async () => {
    const s = await serve({ "/p": send(200), "/i": send(200), "/o": send(200) });
    const fetcher = createFetcher({ allowPrivate: true });
    await inKind("page", () => fetcher.get(`${s.origin}/p`));
    await inKind("link", () => inKind("image", () => fetcher.get(`${s.origin}/i`)));
    await fetcher.get(`${s.origin}/o`);
    expect(fetcher.history?.().map((r) => r.kind)).toEqual(["page", "image", "other"]);
  });

  it("a kind set before an await still applies after it", async () => {
    const s = await serve({ "/p": send(200), "/q": send(200) });
    const fetcher = createFetcher({ allowPrivate: true });
    await inKind("script", async () => {
      await new Promise((r) => setTimeout(r, 5));
      await fetcher.get(`${s.origin}/p`);
      await fetcher.get(`${s.origin}/q`);
    });
    expect(fetcher.history?.().map((r) => r.kind)).toEqual(["script", "script"]);
  });

  it("an address that cannot be reached is a record with no status", async () => {
    const s = await serve({});
    const origin = s.origin;
    await s.close();
    servers.length = 0;
    const fetcher = createFetcher({ allowPrivate: true });
    await expect(fetcher.get(`${origin}/gone`)).rejects.toThrow();
    const [r] = fetcher.history?.() ?? [];
    expect(r).toMatchObject({ url: `${origin}/gone`, status: null, error: "no-answer" });
  });

  it("a timeout is recorded as a timeout", async () => {
    const s = await serve({
      "/slow": () => {
        // never answers
      },
    });
    const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 150 });
    await expect(fetcher.get(`${s.origin}/slow`)).rejects.toThrow();
    expect(fetcher.history?.()[0]).toMatchObject({ status: null, error: "timeout" });
  });

  it("a private address that is refused is recorded as refused, with no request sent", async () => {
    const fetcher = createFetcher({
      target: "https://shop.example/",
      resolver: async (host) => [
        { address: host === "shop.example" ? "93.184.216.34" : "10.0.0.5", family: 4 },
      ],
    });
    await expect(fetcher.get("http://intranet.example/x")).rejects.toThrow();
    expect(fetcher.history?.()[0]).toMatchObject({
      url: "http://intranet.example/x",
      status: null,
      error: "private-address-refused",
    });
  });
});

describe("requestRows: unit", () => {
  const rec = (over: Record<string, unknown>) => ({
    url: "https://shop.example/",
    kind: "page" as const,
    method: "GET" as const,
    status: 200,
    ms: 5,
    chain: 0,
    hop: 0,
    ...over,
  });

  it("orders by kind, then by the order requested, and drops the ordering fields", () => {
    const rows = requestRows([
      rec({ url: "https://shop.example/s.js", kind: "script", chain: 1 }),
      rec({ url: "https://shop.example/l2", kind: "link", chain: 5 }),
      rec({ url: "https://shop.example/", kind: "page", chain: 0 }),
      rec({ url: "https://shop.example/l1", kind: "link", chain: 2 }),
      rec({ url: "https://shop.example/robots.txt", kind: "other", chain: 3 }),
      rec({ url: "https://shop.example/l1", kind: "link", chain: 2, hop: 1, status: 404 }),
    ]);
    expect(rows.map((r) => r.url)).toEqual([
      "https://shop.example/",
      "https://shop.example/l1",
      "https://shop.example/l1",
      "https://shop.example/l2",
      "https://shop.example/s.js",
      "https://shop.example/robots.txt",
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["kind", "method", "ms", "status", "url"]);
  });

  it("keeps secret-looking text out of an address", () => {
    const [row] = requestRows([rec({ url: "https://shop.example/a?token=abcdef123456&x=1" })]);
    expect(row?.url).toBe("https://shop.example/a?token=[redacted]&x=1");
  });
});
