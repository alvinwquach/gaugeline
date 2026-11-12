import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { adaptersConfigSchema } from "../config.js";
import { collectPublished } from "../collect.js";
import {
  SITECORE_QUERY_ALLOW,
  SITECORE_ROUTES_QUERY,
  createSitecoreAdapter,
  type SitecoreAdapter,
} from "../sitecore.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError, type AdapterSettings } from "../types.js";
import { requestProblems, type Seen } from "./contract.js";
import { SITECORE_SETTINGS } from "./sitecore.contract.js";
import {
  EDGE_HOST,
  EDGE_URL,
  LARKSPUR_SITE,
  SITECORE_MARKERS,
  SITE_NAME,
  sitecoreTransport,
  type EdgeCall,
  type FixtureRoute,
  type SitecoreFixtureOptions,
} from "./sitecore-fixture.js";

/**
 * What is particular to the Sitecore XM Cloud adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but GET, HEAD or an allowlisted query, a refused key is could-not-check, a rate limit is
 * waited out once) are in the contract suite, which runs over this adapter's entry: nothing here repeats them.
 */
const KEY = testKey("sitecore-adapter");
const noWait = () => Promise.resolve();

interface World {
  adapter: SitecoreAdapter;
  seen: Seen[];
}

function make(
  options: {
    settings?: AdapterSettings;
    env?: Record<string, string>;
    fixture?: SitecoreFixtureOptions;
    content?: Readonly<Record<string, readonly FixtureRoute[]>>;
    maxBodyBytes?: number;
    pageSize?: number;
    maxItemsPerType?: number;
  } = {},
): World {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
    transport: sitecoreTransport(options.content, {
      token: KEY,
      onRequest: (method, url, headers, body) =>
        seen.push({
          method,
          url: url.href,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createSitecoreAdapter({
    env: options.env ?? { SITECORE_API_KEY: KEY },
    fetcher,
    settings: options.settings ?? SITECORE_SETTINGS,
    sleep: noWait,
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxItemsPerType !== undefined ? { maxItemsPerType: options.maxItemsPerType } : {}),
  });
  return { adapter, seen };
}

const failure = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await failure(p);
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const ids = async (w: World, types: string[]): Promise<string[]> =>
  (await collectPublished(w.adapter, { types })).docs.map((d) => d.id);

describe("the Sitecore adapter: the request", () => {
  it("is one POST to Experience Edge's Delivery endpoint, with the token in sc_apikey and nowhere else", async () => {
    const w = make();
    await ids(w, ["en"]);
    expect(w.seen).toHaveLength(1);
    const [r] = w.seen;
    expect(r?.method).toBe("POST");
    expect(r?.url).toBe(EDGE_URL);
    expect(r?.headers["sc_apikey"]).toBe(KEY);
    expect(r?.headers.authorization).toBeUndefined();
    expect(r?.headers.cookie).toBeUndefined();
    expect(r?.url).not.toContain(KEY);
    expect(r?.body).not.toContain(KEY);
  });

  it("the body is the documented query with every value a variable, and nothing else", async () => {
    const w = make({ pageSize: 50 });
    await ids(w, ["fr-CA"]);
    const body = JSON.parse(w.seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["query", "variables"]);
    expect(body.query).toBe(SITECORE_ROUTES_QUERY);
    expect(body.variables).toEqual({ site: SITE_NAME, language: "fr-CA", pageSize: 50, after: "" });
    // No value is ever written into the document: the site name and the language are not in it.
    expect(SITECORE_ROUTES_QUERY).not.toContain(SITE_NAME);
    expect(SITECORE_ROUTES_QUERY).not.toMatch(/mutation|subscription/i);
    expect(SITECORE_ROUTES_QUERY).toMatch(/^query /);
  });

  it("asks for the route path and nothing else, so no field of the client's content is requested", () => {
    const results = /results \{([^}]*)\}/.exec(SITECORE_ROUTES_QUERY)?.[1]?.trim();
    expect(results).toBe("routePath");
  });

  it("every request passes the contract's read-only check against the adapter's one allowlist entry", async () => {
    const w = make();
    await collectPublished(w.adapter);
    await w.adapter.types();
    expect(requestProblems(w.seen, [SITECORE_QUERY_ALLOW])).toEqual([]);
    expect(SITECORE_QUERY_ALLOW).toMatchObject({
      method: "POST",
      host: EDGE_HOST,
      path: "/api/graphql/v1",
      body: { kind: "graphql-query" },
    });
  });

  it("the entry says its page was not read, so a reviewer sees it", () => {
    expect(SITECORE_QUERY_ALLOW.docs.checked).toBeNull();
  });
});

describe("the Sitecore adapter: reading", () => {
  it("reads a list a page at a time and gives the same routes as one big page", async () => {
    const small = make({ pageSize: 2 });
    const big = make();
    expect(await ids(small, ["en"])).toEqual(await ids(big, ["en"]));
    expect(small.seen).toHaveLength(3);
    // The cursor Edge returned is sent back, and the first page asks with an empty one.
    const afters = small.seen.map(
      (s) => (JSON.parse(s.body ?? "{}") as { variables: { after: string } }).variables.after,
    );
    expect(afters[0]).toBe("");
    expect(afters[1]).not.toBe("");
  });

  it("types() reads the total of each language from a page of one route", async () => {
    const w = make();
    expect(await w.adapter.types()).toEqual([
      { name: "en", count: 6 },
      { name: "fr-CA", count: 3 },
    ]);
    for (const s of w.seen)
      expect(
        (JSON.parse(s.body ?? "{}") as { variables: { pageSize: number } }).variables.pageSize,
      ).toBe(1);
  });

  it("gives the first language's routes their own path, and another language the urls prefix", async () => {
    const w = make();
    const docs = (await collectPublished(w.adapter)).docs;
    expect(docs.find((d) => d.id === "en:/classes/morning-flow")?.url).toBe(
      "/classes/morning-flow",
    );
    expect(docs.find((d) => d.id === "fr-CA:/classes/morning-flow")?.url).toBe(
      "/fr-ca/classes/morning-flow",
    );
    for (const d of docs) {
      expect(d.fieldHashes).toEqual({});
      // A route list has no dates: none is made up.
      expect(d.updatedAt).toBeUndefined();
    }
  });

  it("a language with no urls prefix, that is not the first, has no address: it is not guessed", async () => {
    const w = make({ settings: { ...SITECORE_SETTINGS, urls: {} } });
    const docs = (await collectPublished(w.adapter)).docs;
    expect(docs.filter((d) => d.type === "fr-CA").every((d) => d.url === undefined)).toBe(true);
    expect(docs.filter((d) => d.type === "en").every((d) => d.url !== undefined)).toBe(true);
  });

  it("the default is one language, en", async () => {
    const w = make({ settings: { id: "sitecore", siteName: SITE_NAME } });
    expect(w.adapter.languages()).toEqual(["en"]);
    expect((await w.adapter.types()).map((t) => t.name)).toEqual(["en"]);
  });

  it("fieldCounts is not applicable and asks nothing; drafts are not applicable", async () => {
    const w = make();
    expect(await reasonOf(w.adapter.fieldCounts("en", ["title"]))).toMatch(/^Not applicable/);
    expect(await w.adapter.draftsReachable()).toBe("not-applicable");
    expect(w.seen).toEqual([]);
  });

  it("a text the content has is never in what comes back, even when the platform sends more than was asked", async () => {
    const w = make({
      fixture: {
        respond: (call: EdgeCall) =>
          call.language === "en"
            ? {
                data: {
                  site: {
                    siteInfo: {
                      routes: {
                        total: 1,
                        pageInfo: { endCursor: "", hasNext: false },
                        results: [{ routePath: "/classes", displayName: SITECORE_MARKERS.retreat }],
                      },
                    },
                  },
                },
              }
            : undefined,
      },
    });
    const text = JSON.stringify((await collectPublished(w.adapter, { types: ["en"] })).docs);
    expect(text).not.toContain(SITECORE_MARKERS.retreat);
    expect(text).toContain("/classes");
  });
});

const answer = (
  results: unknown[],
  over: { total?: unknown; hasNext?: unknown; endCursor?: unknown } = {},
): unknown => ({
  data: {
    site: {
      siteInfo: {
        routes: {
          total: "total" in over ? over.total : results.length,
          pageInfo: {
            ...("endCursor" in over ? { endCursor: over.endCursor } : { endCursor: "" }),
            ...("hasNext" in over ? { hasNext: over.hasNext } : { hasNext: false }),
          },
          results,
        },
      },
    },
  },
});
const route = (routePath: unknown) => ({ routePath });

const readWith = async (respond: SitecoreFixtureOptions["respond"], extra = {}): Promise<string> =>
  reasonOf(collectPublished(make({ fixture: { respond }, ...extra }).adapter, { types: ["en"] }));

describe("the Sitecore adapter: answers that cannot be trusted are could-not-check, never the end of the list", () => {
  it("a page that says there is more and gives no cursor", async () => {
    const reason = await readWith(() =>
      answer([route("/a")], { total: 9, hasNext: true, endCursor: "" }),
    );
    expect(reason).toMatch(/did not come to an end/);
  });

  it("a page that does not say whether there is more", async () => {
    const reason = await readWith(() => ({
      data: { site: { siteInfo: { routes: { total: 1, results: [route("/a")], pageInfo: {} } } } },
    }));
    expect(reason).toMatch(/did not say whether there is more/);
  });

  it("a cursor that comes back twice", async () => {
    let n = 0;
    const reason = await readWith(() =>
      answer([route(`/p${n++}`)], { total: 9, hasNext: true, endCursor: "AAAA" }),
    );
    expect(reason).toMatch(/did not come to an end/);
  });

  it("a cursor that is not a token is never sent back", async () => {
    const w = make({
      fixture: {
        respond: () => answer([route("/a")], { total: 9, hasNext: true, endCursor: "x y\n{" }),
      },
    });
    const reason = await reasonOf(collectPublished(w.adapter, { types: ["en"] }));
    expect(reason).toMatch(/did not come to an end/);
    expect(w.seen).toHaveLength(1);
  });

  it("an empty page that is not the end", async () => {
    const reason = await readWith(() => answer([], { total: 3, hasNext: true, endCursor: "BBBB" }));
    expect(reason).toMatch(/did not come to an end/);
  });

  it("the same route twice", async () => {
    const reason = await readWith(() => answer([route("/a"), route("/a")]));
    expect(reason).toMatch(/same en route twice/);
  });

  it("fewer routes than the total, at the end", async () => {
    const reason = await readWith(() => answer([route("/a")], { total: 4 }));
    expect(reason).toMatch(/said the en list has 4 routes and gave 1/);
  });

  it("more routes than asked for", async () => {
    const reason = await readWith(() => answer([route("/a"), route("/b"), route("/c")]), {
      pageSize: 2,
    });
    expect(reason).toMatch(/more routes than the 2 asked for/);
  });

  it("more routes than the bound, whatever total is claimed", async () => {
    let n = 0;
    const reason = await readWith(
      () =>
        answer([route(`/p${n++}`), route(`/p${n++}`)], {
          total: 1,
          hasNext: true,
          endCursor: `C${n}`,
        }),
      { maxItemsPerType: 3 },
    );
    expect(reason).toMatch(/more than 3/);
  });

  it("a total over the bound is could-not-check, never a count of part of it", async () => {
    const w = make({ maxItemsPerType: 2 });
    expect(await reasonOf(w.adapter.types())).toMatch(/has 6 routes, more than 2/);
  });

  it("a total that is not a count", async () => {
    for (const total of [-1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 2])
      expect(await readWith(() => answer([route("/a")], { total }))).toMatch(/not a count/);
  });

  it("a route path that is not a plain path on the site", async () => {
    for (const bad of [
      "//evil.example/x",
      "https://evil.example/x",
      "/a/../b",
      "/a/%2e%2e/b",
      "/a\\b",
      "/a\nb",
      "/a?b=1",
      "/a#frag",
      "/a%0d%0ab",
      "/a%0Ab",
      "/a%09b",
      "no-slash",
      "",
      42,
      null,
    ])
      expect(await readWith(() => answer([route(bad)]))).toMatch(/no usable path/);
  });

  it("GraphQL errors: how many, never what they say (the messages may quote content)", async () => {
    const reason = await readWith(() => ({
      errors: [{ message: SITECORE_MARKERS.retreat }, { message: "second" }],
    }));
    expect(reason).toMatch(/2 GraphQL errors/);
    expect(reason).not.toContain(SITECORE_MARKERS.retreat);
  });

  it("a site Edge does not know, a missing data object and an answer that is not JSON", async () => {
    expect(await readWith(() => ({ data: { site: { siteInfo: null } } }))).toMatch(
      /no site named "larkspur"/,
    );
    expect(await readWith(() => ({ data: null }))).toMatch(/no data/);
    expect(await readWith(() => ({ data: { site: { siteInfo: { routes: "x" } } } }))).toMatch(
      /not a list/,
    );
    expect(await readWith(() => "not an object")).toMatch(/not an object/);
  });

  it("an HTTP error from Edge, a refused token, and a redirect (a body is never sent anywhere else)", async () => {
    expect(await readWith(() => ({ status: 500, body: {} }))).toMatch(/HTTP 500/);
    const refused = await readWith(() => ({ status: 401, body: {} }));
    expect(refused).toMatch(/did not accept SITECORE_API_KEY \(HTTP 401\)/);
    expect(refused).not.toContain(KEY);
    expect(await readWith(() => ({ status: 403, body: {} }))).toMatch(/HTTP 403/);
    const redirect = await readWith(() => ({
      status: 302,
      body: {},
      headers: { location: "https://evil.example/graphql" },
    }));
    expect(redirect).toMatch(/could not be reached/);
  });

  it("a wrong token on a real fixture is refused without the token in the message", async () => {
    const w = make({ env: { SITECORE_API_KEY: "another-token-0123456789" } });
    const reason = await reasonOf(w.adapter.types());
    expect(reason).toMatch(/HTTP 401/);
    expect(reason).not.toContain("another-token-0123456789");
  });

  it("a rate limit that stays carries what was read", async () => {
    const w = make({
      fixture: {
        respond: (_c, n) =>
          n >= 1 ? { status: 429, body: {}, headers: { "retry-after": "3600" } } : undefined,
      },
    });
    const err = await failure(w.adapter.types());
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
    expect((err as AdapterRateLimitedError<unknown[]>).partial).toEqual([{ name: "en", count: 6 }]);
  });
});

describe("the Sitecore adapter: nothing is asked until the settings are usable", () => {
  const cases: {
    why: string;
    env?: Record<string, string>;
    settings?: AdapterSettings;
    says: RegExp;
  }[] = [
    { why: "no token", env: {}, says: /SITECORE_API_KEY is not set/ },
    {
      why: "a token with a space",
      env: { SITECORE_API_KEY: "has a space in it" },
      says: /characters an API token does not have/,
    },
    {
      why: "a token that is too short",
      env: { SITECORE_API_KEY: "abc" },
      says: /characters an API token does not have/,
    },
    { why: "no site name", settings: { id: "sitecore" }, says: /No Sitecore site name/ },
    {
      why: "a site name that is a query",
      settings: { id: "sitecore", siteName: "x) { mutation" },
      says: /No Sitecore site name/,
    },
    {
      why: "a language that is not one",
      settings: { id: "sitecore", siteName: "a", languages: ["en US"] },
      says: /is not a language/,
    },
    {
      why: "too many languages",
      settings: { id: "sitecore", siteName: "a", languages: ["en", "fr", "de", "es", "it", "pt"] },
      says: /At most 5 languages/,
    },
    {
      why: "a urls prefix with a query string",
      settings: { id: "sitecore", siteName: "a", urls: { en: "/x?y=1" } },
      says: /start of the address/,
    },
    {
      why: "a urls prefix on another scheme",
      settings: { id: "sitecore", siteName: "a", urls: { en: "http://x.example" } },
      says: /start of the address/,
    },
  ];
  for (const c of cases)
    it(`${c.why}: could-not-check, and no request`, async () => {
      const w = make({
        ...(c.env ? { env: c.env } : {}),
        ...(c.settings ? { settings: c.settings } : {}),
      });
      for (const read of [() => w.adapter.types(), () => collectPublished(w.adapter)]) {
        const reason = await reasonOf(read());
        expect(reason).toMatch(c.says);
        if (c.env?.SITECORE_API_KEY) expect(reason).not.toContain(c.env.SITECORE_API_KEY);
      }
      expect(w.seen).toEqual([]);
    });

  it("a fetcher with no query method cannot read, and says so", async () => {
    const adapter = createSitecoreAdapter({
      env: { SITECORE_API_KEY: KEY },
      fetcher: { get: () => Promise.resolve([]) } as never,
      settings: SITECORE_SETTINGS,
    });
    expect(await reasonOf(adapter.types())).toMatch(/cannot send a read-only query/);
  });

  it("a plain Experience Edge host in a setting changes nothing: the endpoint is fixed", async () => {
    const w = make({
      settings: { ...SITECORE_SETTINGS, site: "https://evil.example" } as AdapterSettings,
    });
    await w.adapter.types();
    for (const s of w.seen) expect(new URL(s.url).host).toBe(EDGE_HOST);
  });
});

describe("the Sitecore adapter: the settings file", () => {
  it("takes siteName, languages and urls for sitecore, and refuses them for another adapter", () => {
    const ok = adaptersConfigSchema.safeParse({ adapters: [SITECORE_SETTINGS] });
    expect(ok.success).toBe(true);
    for (const key of [{ siteName: "larkspur" }, { languages: ["en"] }]) {
      const bad = adaptersConfigSchema.safeParse({ adapters: [{ id: "sanity", ...key }] });
      expect(bad.success).toBe(false);
    }
  });

  it("refuses a site name or a language that is not one, and more than five languages", () => {
    for (const entry of [
      { siteName: "a b" },
      { siteName: "a;b" },
      { siteName: "" },
      { languages: ["english-us-extra-long-x"] },
      { languages: [] },
      { languages: ["en", "fr", "de", "es", "it", "pt"] },
    ])
      expect(
        adaptersConfigSchema.safeParse({ adapters: [{ id: "sitecore", ...entry }] }).success,
      ).toBe(false);
  });

  it("takes expectPrivate for sitecore", () => {
    expect(
      adaptersConfigSchema.safeParse({
        adapters: [{ id: "sitecore", siteName: "a", expectPrivate: true }],
      }).success,
    ).toBe(true);
  });
});

describe("the Sitecore adapter: the preview endpoint's path", () => {
  const state = async (preview: SitecoreFixtureOptions["preview"]) => {
    const w = make({ fixture: { preview } });
    return { got: await w.adapter.previewEndpoint(LARKSPUR_SITE), w };
  };

  it("asks one GET of the path on the public host, with no key, no cookie and no redirect followed", async () => {
    const { w } = await state("absent");
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]?.method).toBe("GET");
    expect(w.seen[0]?.url).toBe(`${LARKSPUR_SITE}/sitecore/api/graph/edge`);
    expect(w.seen[0]?.headers["sc_apikey"]).toBeUndefined();
    expect(w.seen[0]?.headers.authorization).toBeUndefined();
    expect(w.seen[0]?.headers.cookie).toBeUndefined();
  });

  it("a GraphQL answer (200 or 400) is an endpoint that answers", async () => {
    expect((await state("graphql")).got).toEqual({ state: "answers", status: 200 });
    expect((await state("graphql-bad-request")).got).toEqual({ state: "answers", status: 400 });
  });

  it("404 is absent and 401 is protected", async () => {
    expect((await state("absent")).got).toEqual({ state: "absent", status: 404 });
    expect((await state("protected")).got).toEqual({ state: "protected", status: 401 });
  });

  it("a page that answers every path, and a server error, are not read as an answer", async () => {
    const soft = (await state("soft-200")).got;
    expect(soft.state).toBe("unread");
    expect(soft.reason).toMatch(/not like a GraphQL endpoint/);
    expect((await state("error")).got).toMatchObject({ state: "unread", status: 503 });
  });

  it("an address that is not an address is not read", async () => {
    const w = make();
    expect((await w.adapter.previewEndpoint("not a url")).state).toBe("unread");
    expect(w.seen).toEqual([]);
  });

  it("the settings' expectPrivate is what privacyExpected says; a token does not say it", () => {
    expect(make().adapter.privacyExpected()).toBe(false);
    expect(
      make({ settings: { ...SITECORE_SETTINGS, expectPrivate: true } }).adapter.privacyExpected(),
    ).toBe(true);
  });
});

describe("the Sitecore adapter: a list that changes while it is read", () => {
  it("a total that differs from page to page is could-not-check, never a list with a hole in it", async () => {
    // 25 routes, pages of 10. After page 1, /p3 is unpublished: page 2 says 24 and the offsets shift, so /p10 is never read.
    const page = (from: number, to: number, total: number, hasNext: boolean) =>
      answer(
        Array.from({ length: to - from }, (_, i) => route(`/p${from + i}`)),
        { total, hasNext, endCursor: hasNext ? `C${to}` : "" },
      );
    const w = make({
      pageSize: 10,
      fixture: {
        respond: (_c, n) =>
          n === 0
            ? page(0, 10, 25, true)
            : n === 1
              ? page(11, 21, 24, true)
              : page(21, 25, 24, false),
      },
    });
    const reason = await reasonOf(collectPublished(w.adapter, { types: ["en"] }));
    expect(reason).toMatch(/changed while it was read/);
  });

  it("a total that stays the same is not a change", async () => {
    const w = make({ pageSize: 10 });
    expect(await ids(w, ["en"])).toHaveLength(6);
  });
});

describe("the Sitecore adapter: the urls prefix", () => {
  it("a prefix with a . or .. segment is refused before anything is asked", async () => {
    for (const prefix of ["/..", "/.", "/a/../b", "/a/./b", "/fr/.."]) {
      const w = make({ settings: { ...SITECORE_SETTINGS, urls: { "fr-CA": prefix } } });
      expect(await reasonOf(w.adapter.types())).toMatch(/start of the address/);
      expect(w.seen).toEqual([]);
    }
  });

  it("a prefix with ordinary segments is accepted", async () => {
    const w = make({ settings: { ...SITECORE_SETTINGS, urls: { "fr-CA": "/fr.ca/v1" } } });
    expect(await w.adapter.types()).toHaveLength(2);
  });
});

describe("the Sitecore adapter: sizes", () => {
  const many: Record<string, FixtureRoute[]> = {
    en: Array.from({ length: 60 }, (_, i) => ({
      routePath: `/section/page-${String(i).padStart(4, "0")}`,
      displayName: "x",
    })),
  };
  const sizesAsked = (w: World): number[] =>
    w.seen.map(
      (s) => (JSON.parse(s.body ?? "{}") as { variables: { pageSize: number } }).variables.pageSize,
    );

  it("an answer over the size limit is asked again with half as many routes, and every route is still read once", async () => {
    const w = make({ content: many, maxBodyBytes: 1500 });
    const got = await ids(w, ["en"]);
    expect(got).toHaveLength(60);
    expect(new Set(got).size).toBe(60);
    const sizes = sizesAsked(w);
    expect(sizes.slice(0, 3)).toEqual([100, 50, 25]);
  });

  it("an answer too big even at ten routes is could-not-check", async () => {
    const w = make({ content: many, maxBodyBytes: 200 });
    expect(sizesAsked(w)).toEqual([]);
    const reason = await reasonOf(collectPublished(w.adapter, { types: ["en"] }));
    expect(reason).toMatch(/larger than one page should be|did not come|not JSON/);
    expect(Math.min(...sizesAsked(w))).toBe(10);
  });
});
