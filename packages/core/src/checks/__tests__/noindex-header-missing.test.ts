import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { hiddenConfigSchema, type HiddenConfig } from "../../hidden.js";
import type { CheckContext } from "../../model.js";
import { PROBING_CHECKS } from "../../presets.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../index.js";
import { NOT_FOUND_PATH } from "../not-found-200.js";
import { NO_CONSENT_REASON, noindexHeaderMissing } from "../noindex-header-missing.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const reply =
  (
    code: number,
    headers: Record<string, string> = {},
    body = "<html><body>x</body></html>",
  ): Handler =>
  (_req, res) => {
    res.writeHead(code, { "content-type": "text/html", ...headers }).end(body);
  };
const ROBOTS = { "x-robots-tag": "noindex" };

const hidden = (over: Record<string, unknown> = {}): HiddenConfig =>
  hiddenConfigSchema.parse({ hidden: [{ match: "/*" }], noindexRoutes: ["/studio"], ...over });

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
    hidden: hidden(),
    ...extra,
  };
  const found = await noindexHeaderMissing.run(pageAt(server.origin), ctx);
  return { found, notes, server, ctx };
}
const asked = (s: FixtureServer) => s.log.map((r) => `${r.method} ${r.path}`);

describe("noindex-header-missing: the config", () => {
  it("is a registered probing check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("noindex-header-missing");
    expect(PROBING_CHECKS).toContain("noindex-header-missing");
    expect(noindexHeaderMissing.tech).toMatch(/^probing check/);
  });

  it("noindexRoutes are paths: no wildcard, query or hash, at most 8, and an unknown key is refused", () => {
    expect(() => hidden({ noindexRoutes: ["studio"] })).toThrow();
    expect(() => hidden({ noindexRoutes: ["/a*"] })).toThrow();
    expect(() => hidden({ noindexRoutes: ["/a?x=1"] })).toThrow();
    expect(() =>
      hidden({ noindexRoutes: Array.from({ length: 9 }, (_, i) => `/r${i}`) }),
    ).toThrow();
    expect(() => hidden({ routes: ["/studio"] })).toThrow();
    expect(hidden({ noindexRoutes: undefined }).noindexRoutes).toBeUndefined();
  });
});

describe("noindex-header-missing: when it asks", () => {
  it("asks nothing without consent, and says why", async () => {
    const { found, notes, server } = await run({}, { ownerConsent: false });
    expect(found).toEqual([]);
    expect(notes).toEqual([{ url: server.origin, reason: NO_CONSENT_REASON }]);
    expect(asked(server)).toEqual([]);
  });

  it("does not apply, and asks nothing, with no gaugeline.hidden.json or one that hides only a section", async () => {
    const a = await run({}, { hidden: undefined });
    expect(a.notes).toEqual([]);
    expect(asked(a.server)).toEqual([]);
    const b = await run(
      {},
      { hidden: hiddenConfigSchema.parse({ hidden: [{ match: "/beta/*" }] }) },
    );
    expect(b.notes).toEqual([]);
    expect(asked(b.server)).toEqual([]);
    expect(b.found).toEqual([]);
  });

  it("asks only the made-up address and the routes the owner named, once each, with no cookie or login", async () => {
    const { found, server } = await run({
      [NOT_FOUND_PATH]: reply(404),
      "/studio": reply(200, ROBOTS),
      "/studio/secret": reply(200),
    });
    expect(found).toEqual([]);
    expect(asked(server)).toEqual([`GET ${NOT_FOUND_PATH}`, "GET /studio"]);
    for (const r of server.log) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
  });

  it("never asks /studio on its own: without noindexRoutes only the made-up address is asked", async () => {
    const { server } = await run(
      { [NOT_FOUND_PATH]: reply(404) },
      { hidden: hidden({ noindexRoutes: undefined }) },
    );
    expect(asked(server)).toEqual([`GET ${NOT_FOUND_PATH}`]);
  });

  it("asks once per run: a second page of the same site asks nothing more", async () => {
    const server = await startServer({
      [NOT_FOUND_PATH]: reply(404),
      "/studio": reply(200, ROBOTS),
    });
    servers.push(server);
    const ctx: CheckContext = {
      warn: () => undefined,
      fetcher: createFetcher({ allowPrivate: true }),
      ownerConsent: true,
      hidden: hidden(),
    };
    await noindexHeaderMissing.run(pageAt(server.origin), ctx);
    await noindexHeaderMissing.run(pageAt(server.origin), ctx);
    expect(asked(server)).toHaveLength(2);
  });
});

describe("noindex-header-missing: what it finds", () => {
  it("fails: a listed route answers 200 with no noindex", async () => {
    const { found, server } = await run({ [NOT_FOUND_PATH]: reply(404), "/studio": reply(200) });
    expect(found).toEqual([
      {
        checkId: "noindex-header-missing",
        severity: "high",
        title: "A route the page metadata does not reach has no noindex header",
        evidence: "/studio answers 200 with no noindex in the X-Robots-Tag header or in the page",
        url: `${server.origin}/studio`,
      },
    ]);
  });

  it("passes: the header says noindex (also inside a longer value, and as none)", async () => {
    for (const value of ["noindex", "noindex, nofollow", "googlebot: noindex", "none"]) {
      const { found, notes } = await run({
        [NOT_FOUND_PATH]: reply(404),
        "/studio": reply(200, { "x-robots-tag": value }),
      });
      expect(found, value).toEqual([]);
      expect(notes, value).toEqual([]);
    }
  });

  it("passes an HTML answer that says noindex in its own robots meta tag", async () => {
    const page = '<html><head><meta name="robots" content="noindex"></head></html>';
    const { found } = await run({ [NOT_FOUND_PATH]: reply(404), "/studio": reply(200, {}, page) });
    expect(found).toEqual([]);
  });

  it("does not take a noindex meta tag on a non-HTML answer as the header", async () => {
    const { found } = await run({
      [NOT_FOUND_PATH]: reply(404),
      "/studio": (_q, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end('{"robots":"noindex"}');
      },
    });
    expect(found).toHaveLength(1);
  });

  it("a made-up address that answers 200 with no noindex is a finding; 404, 410, 401 and 403 are not", async () => {
    const bad = await run({ [NOT_FOUND_PATH]: reply(200), "/studio": reply(200, ROBOTS) });
    expect(bad.found.map((f) => f.evidence)).toEqual([
      `${NOT_FOUND_PATH} answers 200 with no noindex in the X-Robots-Tag header or in the page`,
    ]);
    for (const code of [404, 410, 401, 403]) {
      const ok = await run({ [NOT_FOUND_PATH]: reply(code), "/studio": reply(200, ROBOTS) });
      expect(ok.found, String(code)).toEqual([]);
      expect(ok.notes, String(code)).toEqual([]);
    }
  });

  it("a listed route behind a login (401, 403) is fine", async () => {
    for (const code of [401, 403]) {
      const { found, notes } = await run({ [NOT_FOUND_PATH]: reply(404), "/studio": reply(code) });
      expect(found).toEqual([]);
      expect(notes).toEqual([]);
    }
  });

  it.each([404, 429, 500, 503])(
    "a listed route that answers %i is could-not-check, never a pass or a finding",
    async (code) => {
      const { found, notes } = await run({ [NOT_FOUND_PATH]: reply(404), "/studio": reply(code) });
      expect(found).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.reason).toBe(`the address answered ${code}, which is not a clear answer`);
    },
  );

  it("the fetcher refuses a private address without --allow-private, which is could-not-check", async () => {
    const server = await startServer({ [NOT_FOUND_PATH]: reply(404), "/studio": reply(200) });
    servers.push(server);
    const notes: string[] = [];
    const found = await noindexHeaderMissing.run(pageAt(server.origin), {
      warn: () => undefined,
      couldNotCheck: (_u, r) => notes.push(r),
      fetcher: createFetcher({}),
      ownerConsent: true,
      hidden: hidden(),
    });
    expect(found).toEqual([]);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(asked(server)).toEqual([]);
  });
});
