import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import { createUmbracoAdapter, safeRoutePath, umbracoOrigin } from "../umbraco.js";
import {
  UMBRACO_CONTENT,
  UMBRACO_MARKERS,
  UMBRACO_SITE,
  umbracoTransport,
  type UmbracoFixtureOptions,
} from "./umbraco-fixture.js";

/**
 * What is particular to the Umbraco adapter. The rules every adapter shares (counts and fingerprints but never a
 * value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out once) are in the
 * contract suite: no test here repeats them.
 */
const KEY = testKey("umbraco-unit");
const noWait = () => Promise.resolve();
const SETTINGS = {
  id: "umbraco",
  urls: { show: "/whats-on/{slug}", castMember: "/company/{slug}" },
} as const;

interface Seen {
  url: URL;
  headers: Record<string, string>;
}

function make(
  over: {
    fixture?: UmbracoFixtureOptions;
    env?: Record<string, string>;
    pageSize?: number;
    maxItemsPerType?: number;
    maxRequestsPerList?: number;
    settings?: Parameters<typeof createUmbracoAdapter>[0]["settings"];
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const base =
    over.transport ??
    umbracoTransport(undefined, { apiKey: KEY, protectedApi: true, ...over.fixture });
  const transport: Transport = (url, req) => {
    seen.push({ url, headers: req.headers });
    return base(url, req);
  };
  const adapter = createUmbracoAdapter({
    env: over.env ?? { UMBRACO_URL: UMBRACO_SITE, UMBRACO_API_KEY: KEY },
    fetcher: createFetcher({ transport, timeoutMs: 5000 }),
    settings: over.settings ?? SETTINGS,
    sleep: noWait,
    ...(over.pageSize !== undefined ? { pageSize: over.pageSize } : {}),
    ...(over.maxItemsPerType !== undefined ? { maxItemsPerType: over.maxItemsPerType } : {}),
    ...(over.maxRequestsPerList !== undefined
      ? { maxRequestsPerList: over.maxRequestsPerList }
      : {}),
  });
  return { adapter, seen };
}

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await failure(p);
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const json = (body: unknown) =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });
const node = (id: string, type = "show") => ({
  id,
  contentType: type,
  name: "x",
  createDate: "2026-01-01T00:00:00Z",
  updateDate: "2026-01-02T00:00:00Z",
  route: { path: `/${id}/` },
  properties: {},
});
const hostile = (list: (q: { skip: number; take: number }) => unknown): Transport =>
  umbracoTransport(undefined, { apiKey: KEY, list: (q) => list(q) });

describe("the Umbraco adapter: reading a list", () => {
  it("steps by the nodes that came back, so a clamped page gives the same nodes as one big page", async () => {
    const small = (
      await collectPublished(make({ fixture: { maxTake: 1 } }).adapter, { types: ["show"] })
    ).docs;
    const big = (await collectPublished(make().adapter, { types: ["show"] })).docs;
    expect(small).toHaveLength(2);
    expect(small).toEqual(big);
  });

  it("a page that comes back short is not the end: an empty one before the total is could-not-check", async () => {
    const { adapter } = make({
      transport: hostile(({ skip }) => ({
        total: 5,
        items: skip === 0 ? [node("a1"), node("a2")] : [],
      })),
    });
    expect(await reasonOf(collectPublished(adapter, { types: ["show"] }))).toMatch(
      /stopped after 2 of 5 nodes/,
    );
  });

  it("the same page forever is could-not-check, not an endless read or a complete list", async () => {
    const { adapter, seen } = make({
      transport: hostile(() => ({ total: 9_000, items: [node("same1"), node("same2")] })),
    });
    expect(await reasonOf(collectPublished(adapter, { types: ["show"] }))).toMatch(
      /same nodes again/,
    );
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it("a huge total is could-not-check, never a count of part of it", async () => {
    const { adapter, seen } = make({
      transport: hostile(() => ({ total: 4_000_000_000, items: [node("a1")] })),
    });
    expect(await reasonOf(adapter.fieldCounts("show", ["title"]))).toMatch(/more than 10000 nodes/);
    expect(seen).toHaveLength(1);
  });

  it("a list that needs more requests than the budget is could-not-check", async () => {
    let n = 0;
    const { adapter } = make({
      transport: hostile(() => ({ total: 5_000, items: [node(`n${n++}`)] })),
      maxRequestsPerList: 5,
    });
    expect(await reasonOf(collectPublished(adapter, { types: ["show"] }))).toMatch(
      /more than 5 requests/,
    );
  });

  it.each([
    ["no total", { items: [] }],
    ["a total that is text", { total: "2", items: [] }],
    ["a negative total", { total: -1, items: [] }],
    ["a fractional total", { total: 1.5, items: [] }],
    ["items that are not a list", { total: 1, items: {} }],
  ])("%s is could-not-check, never a pass", async (_name, body) => {
    const { adapter } = make({ transport: hostile(() => body) });
    expect(await reasonOf(adapter.types())).toMatch(/not a (count|list)/);
  });

  it.each([
    ["an id with a slash", { ...node("a"), id: "a/b" }],
    ["an id that is empty", { ...node("a"), id: "" }],
    ["no update time", { ...node("a"), updateDate: undefined }],
    ["no content type", { ...node("a"), contentType: undefined }],
  ])("a node with %s is could-not-check with a fixed reason", async (_name, bad) => {
    const { adapter } = make({ transport: hostile(() => ({ total: 1, items: [bad] })) });
    expect(await reasonOf(collectPublished(adapter, { types: ["show"] }))).toMatch(
      /no usable id|no content type/,
    );
  });

  it("a node of another type than the one asked for is could-not-check", async () => {
    const { adapter } = make({
      transport: hostile(() => ({ total: 1, items: [node("a1", "notice")] })),
    });
    expect(await reasonOf(collectPublished(adapter, { types: ["show"] }))).toMatch(
      /another content type/,
    );
  });

  it("a rate limit during a list carries the count of nodes already delivered", async () => {
    let calls = 0;
    const transport: Transport = (url, req) => {
      if (calls++ >= 1)
        return Promise.resolve({
          status: 429,
          headers: { "retry-after": "3600" },
          body: Readable.from([Buffer.from("{}")]),
        });
      return umbracoTransport(undefined, { apiKey: KEY, protectedApi: true, maxTake: 1 })(url, req);
    };
    const err = await failure(collectPublished(make({ transport }).adapter, { types: ["show"] }));
    expect(err).toBeUndefined(); // collectPublished turns it into a partial read
    const direct = make({ transport: transportAfter(1) }).adapter.published({ types: ["show"] });
    const taken: string[] = [];
    const thrown = await failure(
      (async () => {
        for await (const d of direct) taken.push(d.id);
      })(),
    );
    expect(thrown).toBeInstanceOf(AdapterRateLimitedError);
    expect((thrown as AdapterRateLimitedError<number>).partial).toBe(taken.length);
  });
});

function transportAfter(good: number): Transport {
  let calls = 0;
  return (url, req) => {
    if (calls++ >= good)
      return Promise.resolve({
        status: 429,
        headers: { "retry-after": "3600" },
        body: Readable.from([Buffer.from("{}")]),
      });
    return umbracoTransport(undefined, { apiKey: KEY, protectedApi: true, maxTake: 1 })(url, req);
  };
}

describe("the Umbraco adapter: what it asks for", () => {
  it("asks for only the properties the settings name, and expands nothing", async () => {
    const { adapter, seen } = make();
    await collectPublished(adapter, { types: ["show"], fields: { show: ["title", "blurb"] } });
    const q = seen[0]?.url.searchParams;
    expect(q?.get("fields")).toBe("properties[blurb,title]");
    expect(q?.get("expand")).toBe("none");
    expect(q?.get("filter")).toBe("contentType:show");
  });

  it("asks for no property at all when none is named", async () => {
    const { adapter, seen } = make();
    await collectPublished(adapter, { types: ["show"] });
    expect(seen.every((s) => s.url.searchParams.get("fields") === "properties[]")).toBe(true);
  });

  it("asks only the named types, and never a type with an odd alias", async () => {
    const { adapter, seen } = make();
    expect(await reasonOf(adapter.fieldCounts("show&take=9999", ["title"]))).toMatch(
      /not a content type alias/,
    );
    expect(await reasonOf(collectPublished(adapter, { types: ["a b"] }))).toMatch(/alias/);
    expect(seen).toEqual([]);
  });

  it("a dotted field name asks for its first part and hashes the inner value", async () => {
    const content = structuredClone(UMBRACO_CONTENT);
    const first = content[0]?.nodes[0];
    if (first) first.properties = { seo: { title: "x" } };
    const t = umbracoTransport(content, { apiKey: KEY, protectedApi: true });
    const { adapter, seen } = make({ transport: t });
    const docs = (
      await collectPublished(adapter, { types: ["show"], fields: { show: ["seo.title"] } })
    ).docs;
    expect(seen[0]?.url.searchParams.get("fields")).toBe("properties[seo]");
    expect(Object.keys(docs[0]?.fieldHashes ?? {})).toEqual(["seo.title"]);
  });

  it("gives each node its route as the address, and the settings' pattern wins over it", async () => {
    const withPattern = (await collectPublished(make().adapter, { types: ["show"] })).docs;
    expect(withPattern.map((d) => d.url)).toEqual([
      "/whats-on/the-lantern-keeper",
      "/whats-on/winter-panto",
    ]);
    const noPattern = make({ settings: { id: "umbraco", fingerprint: { show: ["title"] } } });
    const docs = (await collectPublished(noPattern.adapter, { types: ["show"] })).docs;
    expect(docs.map((d) => d.url)).toEqual([
      "/whats-on/the-lantern-keeper/",
      "/whats-on/winter-panto/",
    ]);
    expect(docs.map((d) => d.slug)).toEqual(["the-lantern-keeper", "winter-panto"]);
  });

  it("a node with no route has no address, and says nothing made up", async () => {
    const content = structuredClone(UMBRACO_CONTENT);
    const first = content[0]?.nodes[0];
    if (first) first.routePath = undefined;
    const t = umbracoTransport(content, { apiKey: KEY, protectedApi: true });
    const docs = (
      await collectPublished(
        make({
          transport: t,
          settings: { id: "umbraco", fingerprint: { show: ["title"] } },
        }).adapter,
        { types: ["show"] },
      )
    ).docs;
    expect(docs[0]?.url).toBeUndefined();
    expect(docs[0]?.slug).toBeUndefined();
    expect(docs[1]?.url).toBe("/whats-on/winter-panto/");
  });

  it("only items changed since a date are given", async () => {
    const docs = (
      await collectPublished(make().adapter, { types: ["show"], since: "2026-11-01T00:00:00Z" })
    ).docs;
    expect(docs.map((d) => d.slug)).toEqual(["winter-panto"]);
  });
});

describe("the Umbraco adapter: the settings and the address", () => {
  it("with no content type named, it is could-not-check and asks nothing", async () => {
    const { adapter, seen } = make({ settings: { id: "umbraco" } });
    expect(await reasonOf(adapter.types())).toMatch(/No content type is named/);
    expect(await reasonOf(collectPublished(adapter))).toMatch(/No content type is named/);
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/No content type is named/);
    expect(seen).toEqual([]);
  });

  it.each([
    ["not set", {}],
    ["http", { UMBRACO_URL: "http://marigold-lane.example" }],
    ["with a path", { UMBRACO_URL: "https://marigold-lane.example/cms" }],
    ["with sign-in details", { UMBRACO_URL: "https://user:pw@marigold-lane.example" }],
    ["with a query", { UMBRACO_URL: "https://marigold-lane.example/?a=1" }],
    ["not an address", { UMBRACO_URL: "marigold-lane.example" }],
  ])("UMBRACO_URL %s is could-not-check, names the variable, and asks nothing", async (_n, env) => {
    const { adapter, seen } = make({ env: { UMBRACO_API_KEY: KEY, ...env } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("UMBRACO_URL");
    expect(reason).not.toContain("user:pw");
    expect(reason).not.toContain(KEY);
    expect(seen).toEqual([]);
  });

  it("umbracoOrigin accepts only an https origin", () => {
    expect(umbracoOrigin("https://marigold-lane.example/")).toBe("https://marigold-lane.example");
    expect(umbracoOrigin(" https://Marigold-Lane.example:8443 ")).toBe(
      "https://marigold-lane.example:8443",
    );
    for (const bad of ["", "ftp://a.example", "https://", "https://a.example/x", "//a.example"])
      expect(umbracoOrigin(bad)).toBeUndefined();
  });
});

describe("the Umbraco adapter: the key", () => {
  it("is sent in Api-Key to the site's origin and nowhere else, and never in an address", async () => {
    const { adapter, seen } = make();
    await adapter.types();
    await adapter.draftsReachable();
    for (const s of seen) {
      expect(s.url.origin).toBe(UMBRACO_SITE);
      expect(s.url.href).not.toContain(KEY);
      expect(s.headers["api-key"]).toBe(KEY);
      expect(Object.keys(s.headers)).not.toContain("cookie");
    }
  });

  it("is dropped when the site redirects to another origin or to http", async () => {
    for (const target of ["https://other.example/umbraco", "http://marigold-lane.example/x"]) {
      const seen: Seen[] = [];
      const transport: Transport = (url, req) => {
        seen.push({ url, headers: req.headers });
        if (url.href.startsWith(UMBRACO_SITE))
          return Promise.resolve({
            status: 302,
            headers: { location: target },
            body: Readable.from([Buffer.from("")]),
          });
        return json({ total: 0, items: [] });
      };
      const { adapter } = make({ transport });
      await adapter.types().catch(() => undefined);
      const followed = seen.filter((s) => !s.url.href.startsWith(UMBRACO_SITE));
      for (const s of followed) expect(s.headers["api-key"]).toBeUndefined();
    }
  });

  it("with no key set, public reads carry no key, and unpublished work is could-not-check without a request", async () => {
    const { adapter, seen } = make({
      env: { UMBRACO_URL: UMBRACO_SITE },
      fixture: { protectedApi: false },
    });
    const docs = (await collectPublished(adapter, { types: ["show"] })).docs;
    expect(docs).toHaveLength(2);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.headers["api-key"]).toBeUndefined();
    const before = seen.length;
    expect(await reasonOf(adapter.draftsReachable())).toContain("UMBRACO_API_KEY");
    expect(seen).toHaveLength(before);
  });

  it("a protected API with no key is could-not-check and says which variable to set", async () => {
    const { adapter } = make({ env: { UMBRACO_URL: UMBRACO_SITE } });
    expect(await reasonOf(adapter.types())).toContain("UMBRACO_API_KEY");
  });

  it("preview is asked with the key and the Preview header, and only by draftsReachable", async () => {
    const { adapter, seen } = make();
    await collectPublished(adapter, { types: ["show"] });
    expect(seen.every((s) => s.headers.preview === undefined)).toBe(true);
    expect(await adapter.draftsReachable()).toBe(true);
    expect(seen.some((s) => s.headers.preview === "true" && s.headers["api-key"] === KEY)).toBe(
      true,
    );
  });

  it("a key refused for preview only is could-not-check for that part: the published reads still work", async () => {
    const t = umbracoTransport(undefined, { apiKey: KEY });
    const transport: Transport = (url, req) =>
      req.headers.preview === "true"
        ? json({ title: "x" }).then((r) => ({ ...r, status: 403 }))
        : t(url, req);
    const { adapter } = make({ transport });
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/HTTP 403/);
    expect((await adapter.types()).map((x) => x.count)).toEqual([2, 2]);
  });

  it("says nothing of the key in what it throws", async () => {
    const { adapter } = make({ fixture: { apiKey: "a-different-key-0123456789" } });
    const reason = await reasonOf(adapter.types());
    expect(reason).not.toContain(KEY);
    expect(reason).toMatch(/HTTP 401/);
  });
});

describe("the Umbraco adapter: a visitor's view (the probing read)", () => {
  it("is one anonymous GET with no key, no cookie and no preview, and names only a count", async () => {
    const { adapter, seen } = make({ fixture: { protectedApi: false } });
    const got = await adapter.publicApi();
    expect(got).toEqual({ state: "public", total: 5 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.pathname).toBe("/umbraco/delivery/api/v2/content");
    expect(Object.keys(seen[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toEqual(
      expect.arrayContaining(["api-key"]),
    );
    expect(JSON.stringify(got)).not.toContain(UMBRACO_MARKERS.lantern);
  });

  it("a protected API (401) is protected, a switched-off one (404) is closed", async () => {
    expect((await make().adapter.publicApi()).state).toBe("protected");
    expect((await make({ fixture: { off: true } }).adapter.publicApi()).state).toBe("closed");
  });

  it("a page that answers every path with 200 is unread, not a public API", async () => {
    const got = await make({ fixture: { catchAll: true } }).adapter.publicApi();
    expect(got.state).toBe("unread");
  });

  it("an answer with a count that is not a number of nodes is unread", async () => {
    const got = await make({
      transport: hostile(() => ({ total: -3, items: [] })),
    }).adapter.publicApi();
    expect(got.state).toBe("unread");
  });

  it("a 500 is unread with the status; a 429 that stays is a rate limit", async () => {
    const five = make({
      transport: () => json({}).then((r) => ({ ...r, status: 500 })),
    }).adapter;
    expect(await five.publicApi()).toEqual({
      state: "unread",
      reason: "the route answered HTTP 500",
    });
    const limited = make({ transport: transportAfter(0) }).adapter;
    expect(await failure(limited.publicApi())).toBeInstanceOf(AdapterRateLimitedError);
  });
});

describe("safeRoutePath", () => {
  it.each(["/", "/about/", "/whats-on/the-lantern-keeper", "/a-b_c.d~e/f%20g", "/caf%C3%A9/"])(
    "keeps %s",
    (p) => expect(safeRoutePath(p)).toBe(p),
  );

  it.each([
    "//evil.example/x",
    "https://evil.example/",
    "/\\evil",
    "/a/../b",
    "/a/./b",
    "/..",
    "/%2e%2e/x",
    "/%2E%2E/",
    "/a%2fb",
    "/a%5cb",
    "/a?x=1",
    "/a#b",
    "about",
    "",
    "/a b",
    "/a\nb",
    "/%zz",
    "/café",
    "/\ud800",
    "/x".repeat(300),
  ])("refuses %j and never throws", (p) => {
    expect(safeRoutePath(p)).toBeUndefined();
  });

  it("refuses what is not text", () => {
    for (const v of [undefined, null, 5, {}, []]) expect(safeRoutePath(v)).toBeUndefined();
  });

  it("is linear on a long run of percent signs", () => {
    const start = Date.now();
    safeRoutePath(`/${"%".repeat(100_000)}`);
    safeRoutePath(`/${"%2".repeat(100_000)}`);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
