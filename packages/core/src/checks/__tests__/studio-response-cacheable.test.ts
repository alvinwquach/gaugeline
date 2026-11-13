import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { PROBING_CHECKS } from "../../presets.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { studioConfigSchema, type StudioConfig } from "../../studio.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../index.js";
import { NO_CONSENT_REASON, studioResponseCacheable } from "../studio-response-cacheable.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const reply =
  (code: number, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res
      .writeHead(code, { "content-type": "text/html", ...headers })
      .end("<html><body>Sign in</body></html>");
  };

const studio = (over: Record<string, unknown> = {}): StudioConfig =>
  studioConfigSchema.parse({ studioRoutes: ["/studio"], ...over });

const pageAt = (origin: string): PageSnapshot =>
  buildSnapshot([
    {
      url: `${origin}/`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><head><title>Cafe</title></head></html>",
      ms: 1,
    },
  ]);

async function run(routes: Record<string, Handler>, extra: Partial<CheckContext> = {}) {
  const server = await startServer(routes);
  servers.push(server);
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    fetcher: createFetcher({ allowPrivate: true }),
    ownerConsent: true,
    studio: studio(),
    ...extra,
  };
  const found = await studioResponseCacheable.run(pageAt(server.origin), ctx);
  return { found, notes, server };
}
const asked = (s: FixtureServer) => s.log.map((r) => `${r.method} ${r.path}`);

describe("studio-response-cacheable: the config", () => {
  it("is a registered probing check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("studio-response-cacheable");
    expect(PROBING_CHECKS).toContain("studio-response-cacheable");
    expect(studioResponseCacheable.tech).toMatch(/^probing check/);
    expect(studioResponseCacheable.severity).toBe("low");
  });

  it("studioRoutes are paths: at least one, at most 4, no wildcard, query or hash, no unknown key", () => {
    expect(() => studio({ studioRoutes: [] })).toThrow();
    expect(() => studio({ studioRoutes: ["studio"] })).toThrow();
    expect(() => studio({ studioRoutes: ["/a*"] })).toThrow();
    expect(() => studio({ studioRoutes: ["/a?x=1"] })).toThrow();
    expect(() => studio({ studioRoutes: ["/a#x"] })).toThrow();
    expect(() => studio({ studioRoutes: ["/a", "/b", "/c", "/d", "/e"] })).toThrow();
    expect(() => studio({ routes: ["/studio"] })).toThrow();
    expect(studio({ studioRoutes: ["/studio", "/cms"] }).studioRoutes).toEqual(["/studio", "/cms"]);
  });
});

describe("studio-response-cacheable: when it asks", () => {
  it("asks nothing without consent, and says why", async () => {
    const { found, notes, server } = await run({}, { ownerConsent: false });
    expect(found).toEqual([]);
    expect(notes).toEqual([{ url: server.origin, reason: NO_CONSENT_REASON }]);
    expect(asked(server)).toEqual([]);
  });

  it("does not apply, and asks nothing, with no studio config: it never picks /studio itself", async () => {
    const { found, notes, server } = await run({ "/studio": reply(200) }, { studio: undefined });
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
    expect(asked(server)).toEqual([]);
  });

  it("asks only the routes named, once each, by GET, with no cookie or login", async () => {
    const { server } = await run(
      { "/studio": reply(200, { "cache-control": "no-store" }), "/studio/x": reply(200) },
      { studio: studio({ studioRoutes: ["/studio"] }) },
    );
    expect(asked(server)).toEqual(["GET /studio"]);
    for (const r of server.log) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
  });

  it("asks once per run: a second page of the same site asks nothing more", async () => {
    const server = await startServer({ "/studio": reply(200, { "cache-control": "no-store" }) });
    servers.push(server);
    const ctx: CheckContext = {
      warn: () => undefined,
      fetcher: createFetcher({ allowPrivate: true }),
      ownerConsent: true,
      studio: studio(),
    };
    await studioResponseCacheable.run(pageAt(server.origin), ctx);
    await studioResponseCacheable.run(pageAt(server.origin), ctx);
    expect(asked(server)).toEqual(["GET /studio"]);
  });
});

describe("studio-response-cacheable: what it finds", () => {
  it("fails: the studio answers 200 with no Cache-Control header", async () => {
    const { found, server } = await run({ "/studio": reply(200) });
    expect(found).toEqual([
      {
        checkId: "studio-response-cacheable",
        severity: "low",
        title: "The editor studio can be cached",
        evidence:
          "/studio answers 200 with no Cache-Control header, so nothing says it must not be stored",
        url: `${server.origin}/studio`,
      },
    ]);
  });

  it.each([
    "public, max-age=3600",
    "max-age=0, must-revalidate",
    "private",
    "no-cache",
    "s-maxage=60",
  ])("fails: a Cache-Control of %s has no no-store", async (value) => {
    const { found } = await run({ "/studio": reply(200, { "cache-control": value }) });
    expect(found.map((f) => f.evidence)).toEqual([
      "/studio answers 200 with a Cache-Control header that has no no-store",
    ]);
  });

  it.each([
    "no-store",
    "No-Store",
    "no-store, max-age=0",
    "private, no-cache, no-store, must-revalidate",
  ])("passes: a Cache-Control of %s", async (value) => {
    const { found, notes } = await run({ "/studio": reply(200, { "cache-control": value }) });
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("does not take no-store inside another word as the directive", async () => {
    const { found } = await run({ "/studio": reply(200, { "cache-control": "x-no-store-ish" }) });
    expect(found).toHaveLength(1);
  });

  it("reads the answer after a redirect, the way a person's browser would", async () => {
    const { found, server } = await run({
      "/studio": (_q, res) => {
        res.writeHead(302, { location: "/studio/structure" }).end();
      },
      "/studio/structure": reply(200),
    });
    expect(found.map((f) => f.evidence)).toEqual([
      "/studio answers 200 with no Cache-Control header, so nothing says it must not be stored",
    ]);
    expect(asked(server)).toEqual(["GET /studio", "GET /studio/structure"]);
  });

  it("checks each route named", async () => {
    const { found } = await run(
      { "/studio": reply(200, { "cache-control": "no-store" }), "/cms": reply(200) },
      { studio: studio({ studioRoutes: ["/studio", "/cms"] }) },
    );
    expect(found.map((f) => f.url.replace(/^.*\/\/[^/]+/, ""))).toEqual(["/cms"]);
  });

  it("a studio behind a login (401, 403) is fine", async () => {
    for (const code of [401, 403]) {
      const { found, notes } = await run({ "/studio": reply(code) });
      expect(found).toEqual([]);
      expect(notes).toEqual([]);
    }
  });

  it.each([404, 410, 429, 500, 503])(
    "a route that answers %i is could-not-check, never a pass or a finding",
    async (code) => {
      const { found, notes } = await run({ "/studio": reply(code) });
      expect(found).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.reason).toBe(`the address answered ${code}, which is not a clear answer`);
    },
  );

  it("the fetcher refuses a private address without --allow-private, which is could-not-check", async () => {
    const server = await startServer({ "/studio": reply(200) });
    servers.push(server);
    const notes: string[] = [];
    const found = await studioResponseCacheable.run(pageAt(server.origin), {
      warn: () => undefined,
      couldNotCheck: (_u, r) => notes.push(r),
      fetcher: createFetcher({}),
      ownerConsent: true,
      studio: studio(),
    });
    expect(found).toEqual([]);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(asked(server)).toEqual([]);
  });

  it("never prints a header value or a word from the page", async () => {
    const { found } = await run({
      "/studio": reply(200, { "cache-control": "public, max-age=99173", "x-secret": "sentinel-9" }),
    });
    const printed = JSON.stringify(found);
    for (const leak of ["99173", "public", "sentinel-9", "Sign in"])
      expect(printed).not.toContain(leak);
  });
});
