import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { PROBING_CHECKS } from "../../presets.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../index.js";
import { NOT_FOUND_PATH, NO_CONSENT_REASON, notFound200 } from "../not-found-200.js";

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

function pageAt(origin: string): PageSnapshot {
  return buildSnapshot([
    {
      url: `${origin}/`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><head><title>Harbour Lane Books</title></head></html>",
      ms: 1,
    },
  ]);
}

async function run(routes: Record<string, Handler>, extra: Partial<CheckContext> = {}) {
  const server = await startServer(routes);
  servers.push(server);
  const notes: { url: string; reason: string }[] = [];
  const found = await notFound200.run(pageAt(server.origin), {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    fetcher: createFetcher({ allowPrivate: true }),
    ownerConsent: true,
    ...extra,
  });
  return { found, notes, server };
}

describe("not-found-200: unit and integration", () => {
  it("is a registered probing check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("not-found-200");
    expect(PROBING_CHECKS).toContain("not-found-200");
  });

  it("a made-up address that answers 200 is a finding, after one GET and nothing else", async () => {
    const { found, server } = await run({ [NOT_FOUND_PATH]: reply(200) });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "not-found-200",
      severity: "medium",
      url: `${server.origin}${NOT_FOUND_PATH}`,
    });
    expect(found[0]?.evidence).toBe(`${NOT_FOUND_PATH} answers 200, not 404`);
    expect(server.log.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${NOT_FOUND_PATH}`]);
    expect(server.log[0]?.headers.cookie).toBeUndefined();
    expect(server.log[0]?.headers.authorization).toBeUndefined();
  });

  it("404 and 410 pass", async () => {
    expect((await run({ [NOT_FOUND_PATH]: reply(404) })).found).toEqual([]);
    expect((await run({ [NOT_FOUND_PATH]: reply(410) })).found).toEqual([]);
  });

  it("a redirect to the home page that answers 200 is the same soft 404", async () => {
    const { found } = await run({
      [NOT_FOUND_PATH]: reply(302, { location: "/" }),
      "/": reply(200),
    });
    expect(found[0]?.evidence).toBe(`${NOT_FOUND_PATH} redirects, then answers 200 at /, not 404`);
  });

  it("a redirect to a page that answers 404 passes", async () => {
    const { found } = await run({
      [NOT_FOUND_PATH]: reply(301, { location: "/missing" }),
      "/missing": reply(404),
    });
    expect(found).toEqual([]);
  });

  it.each([401, 403, 429, 500, 503])(
    "%i is could not check, never a pass or a finding",
    async (code) => {
      const { found, notes } = await run({ [NOT_FOUND_PATH]: reply(code) });
      expect(found).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.reason).toContain(String(code));
    },
  );

  it("asks nothing without owner consent and says why", async () => {
    const { found, notes, server } = await run(
      { [NOT_FOUND_PATH]: reply(200) },
      { ownerConsent: false },
    );
    expect(found).toEqual([]);
    expect(notes[0]?.reason).toBe(NO_CONSENT_REASON);
    expect(server.log).toEqual([]);
  });

  it("the address is built from the site's origin and carries no query", async () => {
    const { server } = await run({ [NOT_FOUND_PATH]: reply(404) });
    expect(server.log[0]?.path).toBe(NOT_FOUND_PATH);
  });

  it("does nothing when the checked page is not HTML", async () => {
    const server = await startServer({ [NOT_FOUND_PATH]: reply(200) });
    servers.push(server);
    const pdf = buildSnapshot([
      {
        url: `${server.origin}/a.pdf`,
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF",
        ms: 1,
      },
    ]);
    const found = await notFound200.run(pdf, {
      warn: () => undefined,
      fetcher: createFetcher({ allowPrivate: true }),
      ownerConsent: true,
    });
    expect(found).toEqual([]);
    expect(server.log).toEqual([]);
  });

  it("refuses a private address unless allowed: the fetcher's rule holds", async () => {
    const server = await startServer({ [NOT_FOUND_PATH]: reply(200) });
    servers.push(server);
    const notes: string[] = [];
    const found = await notFound200.run(pageAt(server.origin), {
      warn: () => undefined,
      couldNotCheck: (_u, r) => notes.push(r),
      fetcher: createFetcher(),
      ownerConsent: true,
    });
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(server.log).toEqual([]);
  });
});
