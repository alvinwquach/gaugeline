import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { adaptersConfigSchema } from "../config.js";
import { collectPublished } from "../collect.js";
import { createJoomlaAdapter, joomlaBase } from "../joomla.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import {
  JOOMLA_MARKERS,
  JOOMLA_NOW,
  JOOMLA_SITE,
  joomlaTransport,
  type JoomlaFixtureOptions,
} from "./joomla-fixture.js";

/**
 * What is particular to the Joomla adapter. The rules every adapter shares (counts and fingerprints but never a
 * value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out once) are in the
 * contract suite: no test here repeats them.
 */
const KEY = testKey("joomla-unit");
const noWait = () => Promise.resolve();
const SETTINGS = { id: "joomla", urls: { articles: "/studio/{slug}" } } as const;

interface Seen {
  url: URL;
  headers: Record<string, string>;
}

function make(
  over: {
    fixture?: JoomlaFixtureOptions;
    env?: Record<string, string>;
    pageSize?: number;
    maxItemsPerType?: number;
    maxRequestsPerList?: number;
    settings?: Parameters<typeof createJoomlaAdapter>[0]["settings"];
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const base = over.transport ?? joomlaTransport(undefined, { token: KEY, ...over.fixture });
  const transport: Transport = (url, req) => {
    seen.push({ url, headers: req.headers });
    return base(url, req);
  };
  const adapter = createJoomlaAdapter({
    env: over.env ?? { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: KEY },
    fetcher: createFetcher({ transport, timeoutMs: 5000 }),
    settings: over.settings ?? SETTINGS,
    sleep: noWait,
    now: () => JOOMLA_NOW,
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

const json = (body: unknown, status = 200) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/vnd.api+json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });
const article = (id: number, extra: Record<string, unknown> = {}) => ({
  type: "articles",
  id: String(id),
  attributes: {
    alias: `a-${id}`,
    state: 1,
    access: 1,
    language: "*",
    publish_up: "2026-10-01 09:00:00",
    modified: "2026-10-02 09:00:00",
    ...extra,
  },
});
/** A hostile or broken list: it answers `list` for the published read and the counts alike. */
const hostile = (list: (q: { offset: number; limit: number }) => unknown): Transport =>
  joomlaTransport(undefined, { token: KEY, list: (q) => list(q) });

describe("the Joomla adapter: reading a list", () => {
  it("steps by the articles that came back, so small windows give the same articles as one big page", async () => {
    const small = (await collectPublished(make({ pageSize: 1 }).adapter)).docs;
    const big = (await collectPublished(make().adapter)).docs;
    expect(small.map((d) => d.id)).toEqual(["1", "2", "4"]);
    expect(small).toEqual(big);
  });

  it("a window the server clamps still gives every article once (Joomla moves the last window)", async () => {
    const got = (await collectPublished(make({ fixture: { maxLimit: 3 }, pageSize: 5 }).adapter))
      .docs;
    expect(got.map((d) => d.id)).toEqual(["1", "2", "4"]);
  });

  it("counts published articles with a window of one and checks it with a window of two", async () => {
    const { adapter, seen } = make();
    expect(await adapter.types()).toEqual([{ name: "articles", count: 7 }]);
    expect(seen.map((s) => s.url.searchParams.get("page[limit]"))).toEqual(["1", "2"]);
  });

  it("page counts that do not agree are could-not-check, never a wrong count", async () => {
    // A server that always answers 4 pages: one article a page and two a page cannot both be.
    const reason = await reasonOf(
      make({
        transport: hostile(() => ({ data: [], meta: { "total-pages": 4 } })),
      }).adapter.types(),
    );
    expect(reason).toMatch(/do not agree/);
  });

  it("an answer with no page count, or data that is not a list, is could-not-check", async () => {
    expect(
      await reasonOf(make({ transport: hostile(() => ({ data: [] })) }).adapter.types()),
    ).toMatch(/meta total-pages/);
    expect(
      await reasonOf(
        make({
          transport: hostile(() => ({ data: {}, meta: { "total-pages": 1 } })),
        }).adapter.types(),
      ),
    ).toMatch(/not a list of articles/);
  });

  it("a page that comes back empty before the count is could-not-check", async () => {
    const t = hostile(({ limit }) =>
      limit <= 2
        ? { data: [], meta: { "total-pages": limit === 1 ? 4 : 2 } }
        : { data: [], meta: { "total-pages": 1 } },
    );
    expect(await reasonOf(collectPublished(make({ transport: t }).adapter))).toMatch(
      /stopped after 0 of 4/,
    );
  });

  it("the same page forever is could-not-check, not an endless read or a complete list", async () => {
    const t = hostile(({ limit }) => ({
      data: limit === 1 ? [article(1)] : [article(1), article(2)],
      meta: { "total-pages": limit === 1 ? 6 : 3 },
    }));
    expect(await reasonOf(collectPublished(make({ transport: t, pageSize: 3 }).adapter))).toMatch(
      /same articles again/,
    );
  });

  it("a list that changed while it was read is could-not-check", async () => {
    const t = hostile(({ limit, offset }) => ({
      // Counted 3, but the windows hold two distinct articles: one was unpublished meanwhile.
      data: limit <= 2 ? [article(1)] : offset === 0 ? [article(1), article(2)] : [article(2)],
      meta: { "total-pages": limit === 1 ? 3 : 2 },
    }));
    expect(await reasonOf(collectPublished(make({ transport: t, pageSize: 2 }).adapter))).toMatch(
      /changed while it was read|same articles again/,
    );
  });

  it("a huge total is could-not-check, never a count of part of it", async () => {
    expect(
      await reasonOf(make({ maxItemsPerType: 3 }).adapter.fieldCounts("articles", ["title"])),
    ).toMatch(/more than 3 articles/);
  });

  it("a list that needs more requests than the budget is could-not-check", async () => {
    expect(
      await reasonOf(collectPublished(make({ pageSize: 1, maxRequestsPerList: 2 }).adapter)),
    ).toMatch(/more than 2 requests/);
  });

  it("an article that is not published to a request for published ones is could-not-check", async () => {
    const t = hostile(({ limit }) => ({
      data: [article(1, { state: 0 })].slice(0, limit),
      meta: { "total-pages": 1 },
    }));
    expect(await reasonOf(collectPublished(make({ transport: t }).adapter))).toMatch(
      /not published/,
    );
  });

  it("an article with no id, no time or no view level is could-not-check", async () => {
    const bad = (item: unknown) =>
      hostile(({ limit }) => ({ data: [item].slice(0, limit), meta: { "total-pages": 1 } }));
    expect(
      await reasonOf(
        collectPublished(make({ transport: bad({ id: "x1", attributes: {} }) }).adapter),
      ),
    ).toMatch(/no usable id/);
    expect(
      await reasonOf(
        collectPublished(
          make({ transport: bad({ id: "1", attributes: { state: 1, language: "*" } }) }).adapter,
        ),
      ),
    ).toMatch(/no usable id/);
    expect(
      await reasonOf(
        collectPublished(
          make({
            transport: bad({ id: "1", attributes: { state: 1, modified: "2026-10-02 09:00:00" } }),
          }).adapter,
        ),
      ),
    ).toMatch(/view level/);
  });

  it("a rate limit that stays during a list keeps the articles already read and says it is partial", async () => {
    const base = joomlaTransport(undefined, { token: KEY });
    let n = 0;
    const t: Transport = (url, req) =>
      n++ < 3
        ? base(url, req)
        : (json({ errors: [] }, 429).then((r) => ({
            ...r,
            headers: { "retry-after": "3600" },
          })) as ReturnType<Transport>);
    const got = await collectPublished(make({ transport: t, pageSize: 1 }).adapter);
    expect(got.partial?.reason).toBe("rate-limited");
    expect(got.docs.map((d) => d.id)).toEqual(["1", "2"]);
    expect(got.partial?.delivered).toBe(2);
  });
});

describe("the Joomla adapter: what it asks for", () => {
  it("asks with the JSON:API type, the Published filter, a stable order and escaped brackets", async () => {
    const { adapter, seen } = make({ pageSize: 2 });
    await collectPublished(adapter);
    // The window of two that checks the count is the first page too, and is not asked twice.
    const read = seen[1];
    expect(read?.headers.accept).toBe("application/vnd.api+json");
    expect(read?.url.pathname).toBe("/api/index.php/v1/content/articles");
    expect(read?.url.search).toBe(
      "?filter%5Bstate%5D=1&list%5Bordering%5D=a.id&list%5Bdirection%5D=ASC&page%5Blimit%5D=2&page%5Boffset%5D=0",
    );
  });

  it("gives published articles for the public: not Registered ones, not scheduled, not expired, not another language", async () => {
    const { adapter } = make();
    const got = (await collectPublished(adapter)).docs;
    expect(got.map((d) => d.id)).toEqual(["1", "2", "4"]);
    expect(adapter.skipped()).toEqual({ notPublic: 1, scheduled: 1, expired: 1, otherLanguage: 1 });
  });

  it("gives each article the address the settings' pattern makes, and none without a pattern", async () => {
    const withPattern = (await collectPublished(make().adapter)).docs;
    expect(withPattern.map((d) => d.url)).toEqual([
      "/studio/morning-flow",
      "/studio/evening-stretch",
      "/studio/closed-last-friday",
    ]);
    const without = (await collectPublished(make({ settings: { id: "joomla" } }).adapter)).docs;
    expect(without.every((d) => d.url === undefined)).toBe(true);
  });

  it("reads Joomla's database times as UTC, and gives publish_up as publishedAt", async () => {
    const [first] = (await collectPublished(make().adapter)).docs;
    expect(first?.publishedAt).toBe("2026-10-01T09:00:00.000Z");
    expect(first?.updatedAt).toBe("2026-10-20T08:30:00.000Z");
  });

  it("only articles changed since a date are given", async () => {
    const got = await collectPublished(make().adapter, { since: "2026-11-01T00:00:00Z" });
    expect(got.docs.map((d) => d.id)).toEqual(["2", "4"]);
  });

  it("fingerprints hash a field and leave an empty one out, and a name that is not a field name is not asked", async () => {
    const got = await collectPublished(make().adapter, {
      fields: { articles: ["metadesc", "bad name!"] },
    });
    expect(Object.keys(got.docs[0]?.fieldHashes ?? {})).toEqual(["metadesc"]);
    expect(got.docs[1]?.fieldHashes).toEqual({});
  });

  it("reads one type only: any other name is could-not-check for fieldCounts and listed as unknown", async () => {
    const { adapter } = make({
      settings: { id: "joomla", urls: { categories: "/c/{slug}", articles: "/studio/{slug}" } },
    });
    expect(adapter.unknownTypes()).toEqual(["categories"]);
    expect(await reasonOf(adapter.fieldCounts("categories", ["title"]))).toMatch(
      /reads articles only/,
    );
    expect(await collectPublished(adapter, { types: ["categories"] })).toEqual({ docs: [] });
  });

  it("draftsReachable is true when the default list holds an unpublished article", async () => {
    expect(await make().adapter.draftsReachable()).toBe(true);
  });

  it("no unpublished article listed is could-not-check, not false", async () => {
    const only = joomlaTransport(
      [
        {
          id: 1,
          alias: "a",
          title: "x",
          state: 1,
          publish_up: "2026-10-01 09:00:00",
          modified: "2026-10-01 09:00:00",
        },
      ],
      { token: KEY },
    );
    expect(await reasonOf(make({ transport: only }).adapter.draftsReachable())).toMatch(
      /does not show whether unpublished work is reachable/,
    );
  });
});

describe("the Joomla adapter: the settings and the address", () => {
  it("joomlaBase accepts only an https address, with at most a folder", () => {
    expect(joomlaBase("https://example.com")).toBe("https://example.com");
    expect(joomlaBase("https://example.com/")).toBe("https://example.com");
    expect(joomlaBase(" https://example.com/cms/ ")).toBe("https://example.com/cms");
    for (const bad of [
      "http://example.com",
      "https://user:pw@example.com",
      "https://example.com/?a=1",
      "https://example.com/#x",
      "https://example.com/../x",
      "https://example.com/a b",
      "https://example.com/%2e%2e",
      "https://example.com/a/b/c/d/e/f/g/h/i",
      "not a url",
      "",
    ])
      expect(joomlaBase(bad), bad).toBeUndefined();
  });

  it("a site in a folder is asked under that folder", async () => {
    const { adapter, seen } = make({
      env: { JOOMLA_URL: `${JOOMLA_SITE}/cms`, JOOMLA_TOKEN: KEY },
      transport: joomlaTransport(undefined, { token: KEY }),
    });
    await failure(adapter.types());
    expect(seen[0]?.url.pathname).toBe("/cms/api/index.php/v1/content/articles");
  });

  it("with no address set, or a bad one, it says which variable and asks nothing", async () => {
    const none = make({ env: { JOOMLA_TOKEN: KEY } });
    expect(await reasonOf(none.adapter.types())).toContain("JOOMLA_URL is not set");
    const bad = make({ env: { JOOMLA_URL: "http://larkspur-yoga.example", JOOMLA_TOKEN: KEY } });
    expect(await reasonOf(bad.adapter.types())).toContain("JOOMLA_URL must be");
    expect(none.seen.length + bad.seen.length).toBe(0);
  });

  it("expectPrivate is accepted in the settings for joomla and refused for another adapter", () => {
    expect(
      adaptersConfigSchema.safeParse({
        adapters: [{ id: "joomla", urls: { articles: "/x/{slug}" }, expectPrivate: true }],
      }).success,
    ).toBe(true);
    expect(
      adaptersConfigSchema.safeParse({
        adapters: [{ id: "strapi", urls: { events: "/x/{slug}" }, expectPrivate: true }],
      }).success,
    ).toBe(false);
  });
});

describe("the Joomla adapter: the token", () => {
  it("is sent in X-Joomla-Token to the site's origin and nowhere else, and never in an address", async () => {
    const { adapter, seen } = make();
    await collectPublished(adapter);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.url.host).toBe(new URL(JOOMLA_SITE).host);
      expect(s.url.href).not.toContain(KEY);
      expect(s.headers["x-joomla-token"]).toBe(KEY);
      expect(s.headers.authorization).toBeUndefined();
    }
  });

  it("is dropped when the site redirects to another origin", async () => {
    const seen: Seen[] = [];
    const base = joomlaTransport(undefined, { token: KEY, protectedApi: false });
    const transport: Transport = (url, req) => {
      seen.push({ url, headers: req.headers });
      if (url.host === new URL(JOOMLA_SITE).host && url.pathname.startsWith("/api"))
        return Promise.resolve({
          status: 302,
          headers: {
            location:
              "https://elsewhere.example/api/index.php/v1/content/articles?page%5Blimit%5D=1",
          },
          body: Readable.from([]),
        }) as ReturnType<Transport>;
      return base(url, req);
    };
    const adapter = createJoomlaAdapter({
      env: { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: KEY },
      fetcher: createFetcher({ transport, timeoutMs: 5000 }),
      sleep: noWait,
    });
    await failure(adapter.types());
    expect(
      seen
        .filter((s) => s.url.host === "elsewhere.example")
        .map((s) => s.headers["x-joomla-token"]),
    ).toEqual(seen.filter((s) => s.url.host === "elsewhere.example").map(() => undefined));
  });

  it("with no token set it says which variable and asks nothing; one with spaces or lines is refused unsent", async () => {
    const none = make({ env: { JOOMLA_URL: JOOMLA_SITE } });
    expect(await reasonOf(none.adapter.types())).toContain("JOOMLA_TOKEN is not set");
    const odd = make({ env: { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: `${KEY}\nx-evil: 1` } });
    const reason = await reasonOf(odd.adapter.types());
    expect(reason).toContain("does not look like a Joomla API token");
    expect(reason).not.toContain(KEY);
    expect(none.seen.length + odd.seen.length).toBe(0);
  });

  it("a token Joomla refuses says which part to check, and leaks nothing", async () => {
    const r401 = await reasonOf(
      make({ fixture: { token: "other-token-0123456789abcd" } }).adapter.types(),
    );
    expect(r401).toMatch(/HTTP 401/);
    expect(r401).not.toContain(KEY);
    const r403 = await reasonOf(make({ fixture: { denied: true } }).adapter.types());
    expect(r403).toMatch(/Access API/);
  });

  it("an API that is switched off (404) says so", async () => {
    expect(await reasonOf(make({ fixture: { off: true } }).adapter.types())).toMatch(
      /not at this address/,
    );
  });
});

describe("the Joomla adapter: a visitor's view (the probing read)", () => {
  it("is one anonymous GET with no token and no authorization, and names only a count", async () => {
    const { adapter, seen } = make({ fixture: { protectedApi: false } });
    const got = await adapter.publicApi();
    expect(got).toEqual({ state: "public", total: 7 + 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.pathname).toBe("/api/index.php/v1/content/articles");
    expect(seen[0]?.url.search).toBe("?page%5Blimit%5D=1");
    expect(Object.keys(seen[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toEqual(
      expect.arrayContaining(["x-joomla-token"]),
    );
    expect(JSON.stringify(got)).not.toContain(JOOMLA_MARKERS.morning);
  });

  it("a route that needs a token (401) is protected, a switched-off one (404) is closed", async () => {
    expect((await make().adapter.publicApi()).state).toBe("protected");
    expect((await make({ fixture: { off: true } }).adapter.publicApi()).state).toBe("closed");
  });

  it("a page that answers every path with 200 is unread, not a public API", async () => {
    expect((await make({ fixture: { catchAll: true } }).adapter.publicApi()).state).toBe("unread");
  });

  it("an answer with a count that is not a number is unread", async () => {
    const got = await make({
      transport: joomlaTransport(undefined, {
        protectedApi: false,
        list: () => ({ data: [], meta: { "total-pages": -3 } }),
      }),
    }).adapter.publicApi();
    expect(got.state).toBe("unread");
  });

  it("a 500 is unread with the status", async () => {
    const five = make({ transport: () => json({}, 500) }).adapter;
    expect(await five.publicApi()).toEqual({
      state: "unread",
      reason: "the route answered HTTP 500",
    });
  });

  it("a 429 that stays is a rate limit", async () => {
    const limited = make({
      transport: () => json({}, 429).then((r) => ({ ...r, headers: { "retry-after": "3600" } })),
    }).adapter;
    expect(await failure(limited.publicApi())).toBeInstanceOf(AdapterRateLimitedError);
  });
});
