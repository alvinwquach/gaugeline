import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchError } from "@gaugeline/core";
import { checkSite, createFetcher } from "@gaugeline/core";
import { safePath, startFixture, withFixture, type Fixture } from "../server.js";

const open: Fixture[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});
async function start(name: string) {
  const f = await startFixture(name);
  open.push(f);
  return f;
}
const get = (url: string) => createFetcher({ allowPrivate: true, timeoutMs: 1000 }).get(url);

/** A raw request, for paths fetch-style clients would normalise away (../). */
function rawGet(origin: string, path: string): Promise<number> {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("fixture server: unit", () => {
  it("routes.json: status and Location", async () => {
    const site = await start("redirect-chain");
    const hops = await get(`${site.origin}/`);
    expect(hops.map((h) => [new URL(h.url).pathname, h.status])).toEqual([
      ["/", 301],
      ["/step-two", 302],
      ["/home", 200],
    ]);
  });

  it("routes.json: custom headers", async () => {
    const site = await start("noindex-header");
    const [hop] = await get(`${site.origin}/`);
    expect(hop?.headers["x-robots-tag"]).toBe("noindex");
  });

  it("routes.json: hang and delay", async () => {
    const site = await start("slow");
    const err = (await get(`${site.origin}/`).catch((e: unknown) => e)) as FetchError;
    expect(err.reason).toBe("timeout");
  });

  it("routes.json: generated body size", async () => {
    const site = await start("big-body");
    const [hop] = await get(`${site.origin}/`);
    expect(hop?.truncated).toBe(true);
  });

  it("hits Map increments per path", async () => {
    const site = await start("clean");
    await get(`${site.origin}/`);
    await get(`${site.origin}/menu`);
    await createFetcher({ allowPrivate: true }).get(`${site.origin}/`);
    expect(site.hits.get("/")).toBe(2);
    expect(site.hits.get("/menu")).toBe(1);
    expect(site.total).toBe(3);
  });

  it("serves static files with a content type, and 404 for a missing one", async () => {
    const site = await start("clean");
    const [svg] = await get(`${site.origin}/loaf.svg`);
    expect(svg?.headers["content-type"]).toBe("image/svg+xml");
    expect((await get(`${site.origin}/nope`))[0]?.status).toBe(404);
  });
});

describe("fixture server: integration", () => {
  it("two fixtures run in parallel on different ports with no cross-talk", async () => {
    const [a, b] = await Promise.all([start("clean"), start("noindex-header")]);
    expect(a.origin).not.toBe(b.origin);
    await Promise.all([get(`${a.origin}/`), get(`${b.origin}/`)]);
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
    expect((await get(`${a.origin}/`))[0]?.headers["x-robots-tag"]).toBeUndefined();
  });

  it("close() releases the port: a second start succeeds immediately", async () => {
    const first = await startFixture("clean");
    await first.close();
    const second = await startFixture("clean");
    open.push(second);
    expect((await get(`${second.origin}/`))[0]?.status).toBe(200);
  });

  it("duplicate-host serves two origins and a hosts mapping for the fetcher", async () => {
    await withFixture("duplicate-host", async (site) => {
      expect(site.origin).toBe("http://duplicate.test");
      expect(Object.keys(site.hosts)).toEqual(["duplicate.test", "www.duplicate.test"]);
      const fetcher = createFetcher({ hosts: site.hosts });
      const { result } = await checkSite({ address: site.origin, fetcher });
      expect(result.findings.map((f) => f.checkId)).toEqual(["host-duplicate"]);
    });
  });

  it("withFixture closes the fixture even when the body throws", async () => {
    let origin = "";
    await expect(
      withFixture("clean", async (site) => {
        origin = site.origin;
        throw new Error("test body failed");
      }),
    ).rejects.toThrow("test body failed");
    const err = await get(`${origin}/`).catch((e: unknown) => e);
    expect((err as FetchError).reason).toBe("refused");
  });

  it("each fixture produces the finding it exists for", async () => {
    const expectations: Array<[string, string[]]> = [
      ["clean", []],
      ["redirect-chain", ["redirect-chain"]],
      ["thin-html", ["thin-html"]],
      ["noindex-header", ["noindex"]],
    ];
    for (const [name, ids] of expectations) {
      await withFixture(name, async (site) => {
        const { result } = await checkSite({
          address: `${site.origin}/`,
          fetcher: createFetcher({ allowPrivate: true }),
        });
        expect(
          result.findings.map((f) => f.checkId),
          name,
        ).toEqual(ids);
      });
    }
  });
});

describe("fixture server: edge cases", () => {
  it("path traversal in a request (../) is refused", async () => {
    const site = await start("clean");
    expect(await rawGet(site.origin, "/../../package.json")).toBe(400);
    expect(await rawGet(site.origin, "/%2e%2e/%2e%2e/package.json")).toBe(400);
    expect(safePath("/a/../b")).toBeUndefined();
    expect(safePath("/menu")).toBe("/menu");
  });

  it("a fixture folder that does not exist fails with the folder name in the message", async () => {
    await expect(startFixture("no-such-site")).rejects.toThrow(/no-such-site/);
    await expect(startFixture("../../etc")).rejects.toThrow(/does not exist/);
  });
});

describe("budget test (the published request budget)", () => {
  it('a full check of the "clean" fixture makes no more than 5 concurrent and 60 total requests', async () => {
    const site = await start("clean");
    await checkSite({ address: `${site.origin}/`, fetcher: createFetcher({ allowPrivate: true }) });
    expect(site.maxConcurrent).toBeLessThanOrEqual(5);
    expect(site.total).toBeLessThanOrEqual(60);
    expect(site.total).toBeGreaterThan(0);
  });
});

describe("fixture server: Windows edge cases", () => {
  it("a CRLF fixture parses like an LF one and passes every page check", async () => {
    const site = await start("crlf");
    const [hop] = await get(`${site.origin}/`);
    expect(hop?.body).toContain("\r\n");
    const { snapshot, result } = await checkSite({
      address: `${site.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
    });
    expect(snapshot.title).toBe("Fixture Bakery");
    expect(snapshot.headings[0]?.text).toBe("Fixture Bakery");
    expect(snapshot.canonical).toBe(`${site.origin}/`);
    expect(result.findings).toEqual([]);
  });
});
