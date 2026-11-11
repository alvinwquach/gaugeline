import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapters, resolveAdapters } from "../registry.js";
import {
  STRAPI_LIMITS,
  STRAPI_PAGE_SIZE,
  createStrapiAdapter,
  type StrapiAdapterOptions,
} from "../strapi.js";
import { AdapterCouldNotCheck } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  BRASS,
  BRASS_SETTLED,
  BRASS_URLS,
  CMS_URL,
  STRAPI_MARKERS,
  strapiTransport,
  type StrapiFixtureCollection,
  type StrapiFixtureOptions,
} from "./strapi-fixture.js";

const KEY = testKey("strapi-unit");
const ENV = { STRAPI_URL: CMS_URL, STRAPI_TOKEN: KEY };
const SETTINGS = { id: "strapi", urls: { ...BRASS_URLS, reviews: "/reviews/{slug}" } };

function over(
  options: {
    content?: readonly StrapiFixtureCollection[];
    fixture?: StrapiFixtureOptions;
    adapter?: Partial<StrapiAdapterOptions>;
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(
      options.transport ??
        strapiTransport(options.content ?? BRASS, { token: KEY, ...options.fixture }),
      seen,
    ),
    timeoutMs: 5000,
  });
  const adapter = createStrapiAdapter({
    env: ENV,
    fetcher,
    settings: SETTINGS,
    sleep: () => Promise.resolve(),
    ...options.adapter,
  });
  return { adapter, seen };
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

describe("Strapi on ContentAdapter: what it says about itself", () => {
  it("asks for a read-only API token, and says where to read how", () => {
    const { adapter } = over();
    expect(adapter.id).toBe("strapi");
    expect(adapter.describe()).toEqual({
      name: "Strapi",
      docsUrl: "https://gaugeline.dev/docs/integrations/strapi",
      keyKind: "read-only",
    });
    expect(adapterHeader(adapter.describe())).toBe(
      "Content system: Strapi, with a read-only key. Endpoints and how to make the key: https://gaugeline.dev/docs/integrations/strapi",
    );
  });

  it("is built, not planned, and a settings file can name it", async () => {
    expect(BUILT_ADAPTERS.has("strapi")).toBe(true);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "strapi")).toBe(false);
    const config = adaptersConfigSchema.parse({
      adapters: [{ id: "strapi", fingerprint: { events: ["title"] }, urls: BRASS_URLS }],
    });
    expect(resolveAdapters(config).map((b) => b.id)).toEqual(["strapi"]);
    const fetcher = createFetcher({ transport: strapiTransport() });
    const created = await createAdapters(config, { env: ENV, fetcher });
    expect(created.map((a) => a.id)).toEqual(["strapi"]);
  });

  it("names its collections from the settings, because Strapi lists none to a token", () => {
    expect(over().adapter.collections()).toEqual(["events", "menu-items", "reviews"]);
  });
});

describe("Strapi: the key and the site", () => {
  it("no address is could-not-check and no request is made", async () => {
    const { adapter, seen } = over({ adapter: { env: { STRAPI_TOKEN: KEY } } });
    expect(await reasonOf(adapter.types())).toMatch(/STRAPI_URL/);
    expect(seen).toEqual([]);
  });

  it("no token: unpublished work is could-not-check naming the variable, and nothing is asked", async () => {
    const { adapter, seen } = over({ adapter: { env: { STRAPI_URL: CMS_URL } } });
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/STRAPI_TOKEN/);
    expect(seen).toEqual([]);
  });

  it("no token: published entries are read as a visitor reads them, with no Authorization header", async () => {
    const { adapter, seen } = over({
      adapter: { env: { STRAPI_URL: CMS_URL } },
      fixture: { publicPublished: ["events"] },
    });
    const got = await collectPublished(adapter, { types: ["events"] });
    expect(got.docs.map((d) => d.id)).toEqual(["evt-harvest", "evt-quiz"]);
    for (const s of seen)
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("an http address never gets the token: could-not-check, nothing is sent", async () => {
    const { adapter, seen } = over({
      adapter: { env: { STRAPI_URL: "http://cms.brass-anchor.example", STRAPI_TOKEN: KEY } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/plain http/);
    expect(seen).toEqual([]);
  });

  it("an address with a user name or password in it is refused", async () => {
    const address = new URL(CMS_URL);
    address.username = "admin";
    address.password = ["hush", "puppy", "42"].join("");
    const { adapter } = over({ adapter: { env: { STRAPI_URL: address.href, STRAPI_TOKEN: KEY } } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/no user name or password/);
    expect(reason).not.toContain(address.password);
  });

  it("the token goes to the configured origin only, in a header, and a redirect to another origin drops it", async () => {
    const seen: Seen[] = [];
    const transport: Transport = (url, req) => {
      seen.push({ method: req.method, url: url.href, headers: req.headers });
      if (url.host === "cms.brass-anchor.example")
        return Promise.resolve({
          status: 302,
          headers: { location: "https://cdn.elsewhere.example/api/events" },
          body: Readable.from([]),
        });
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([
          Buffer.from(JSON.stringify({ data: [], meta: { pagination: { total: 0 } } })),
        ]),
      });
    };
    const fetcher = createFetcher({ transport, timeoutMs: 5000 });
    const adapter = createStrapiAdapter({
      env: ENV,
      fetcher,
      settings: { id: "strapi", urls: { events: "/e/{slug}" } },
    });
    await adapter.types();
    expect(seen.map((s) => new URL(s.url).host)).toEqual([
      "cms.brass-anchor.example",
      "cdn.elsewhere.example",
    ]);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[1]?.headers.authorization).toBeUndefined();
    for (const s of seen) expect(s.url).not.toContain(KEY);
  });

  it("a wrong token is could-not-check (HTTP 401) and never shows the token", async () => {
    const { adapter } = over({ fixture: { token: "some-other-token-value" } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/401|did not accept/);
    expect(reason).not.toContain(KEY);
  });

  it("a token that may not read one collection: that read is could-not-check, the others still read", async () => {
    const { adapter } = over({ fixture: { denied: ["events"] } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/find and findOne/);
    const got = await collectPublished(adapter, { types: ["menu-items", "reviews"] });
    expect(got.docs.map((d) => d.id)).toEqual(["mnu-stout", "mnu-pie", "rev-snug", "rev-first"]);
    expect(await reasonOf(collectPublished(adapter, { types: ["events"] }))).toMatch(
      /find and findOne/,
    );
  });

  it("no collections named: types() is empty and unpublished work is could-not-check, never false", async () => {
    const { adapter } = over({ adapter: { settings: { id: "strapi" } } });
    expect(await adapter.types()).toEqual([]);
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/No collection is named/);
  });

  it("a collection name that is not an API id never reaches an address", async () => {
    const { adapter, seen } = over({
      adapter: { settings: { id: "strapi", urls: { "a.b": "/x/{slug}" } } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/not a Strapi collection API ID/);
    expect(seen).toEqual([]);
  });
});

describe("Strapi: what it reads", () => {
  it("reads published entries only: counts, ids, slugs and times, never a draft", async () => {
    const { adapter } = over();
    expect(await adapter.types()).toEqual([
      { name: "events", count: 2 },
      { name: "menu-items", count: 2 },
      { name: "reviews", count: 2 },
    ]);
    const { docs } = await collectPublished(adapter, { types: ["events"] });
    expect(docs.map((d) => [d.id, d.slug, d.url])).toEqual([
      ["evt-harvest", "harvest-beer-night", "/events/harvest-beer-night"],
      ["evt-quiz", "pub-quiz", "/events/pub-quiz"],
    ]);
    expect(JSON.stringify(docs)).not.toContain(STRAPI_MARKERS.newYear);
  });

  it("drops a row that is marked as a draft, even if a plugin listed it", async () => {
    const leaky = strapiTransport(BRASS, { token: KEY });
    const asDraft: Transport = (url, req) =>
      leaky(new URL(`${url.href}${url.search ? "&" : "?"}status=draft`), req);
    const { adapter } = over({ transport: asDraft });
    const { docs } = await collectPublished(adapter, { types: ["events"] });
    expect(docs).toEqual([]);
  });

  it("pages through a collection a page at a time", async () => {
    const { adapter, seen } = over({ adapter: { pageSize: 1 } });
    const { docs } = await collectPublished(adapter, { types: ["events"] });
    expect(docs.map((d) => d.id)).toEqual(["evt-harvest", "evt-quiz"]);
    const pages = seen.map((s) => new URL(s.url).searchParams.get("pagination[page]"));
    expect(pages).toEqual(["1", "2"]);
  });

  it("reads Strapi 4's wrapped rows with the numeric id", async () => {
    const { adapter } = over({ fixture: { version: 4 } });
    const { docs } = await collectPublished(adapter, { types: ["events"] });
    expect(docs.map((d) => d.id)).toEqual(["1", "2"]);
    expect(docs[0]?.slug).toBe("harvest-beer-night");
    expect(await adapter.draftsReachable()).toBe(true);
  });

  it("unpublished work the token can reach: true when a draft list is longer, false when settled", async () => {
    expect(await over().adapter.draftsReachable()).toBe(true);
    expect(await over({ content: BRASS_SETTLED }).adapter.draftsReachable()).toBe(false);
  });

  it("a token refused the draft list, with the published list open, reaches no drafts", async () => {
    const base = strapiTransport(BRASS, { token: KEY });
    const refuseDrafts: Transport = (url, req) =>
      url.searchParams.has("status") || url.searchParams.has("publicationState")
        ? Promise.resolve({ status: 403, headers: {}, body: Readable.from([]) })
        : base(url, req);
    expect(await over({ transport: refuseDrafts }).adapter.draftsReachable()).toBe(false);
  });

  it("asks for field values only when fields are configured, and only hashes them", async () => {
    const { adapter } = over({
      adapter: { settings: { ...SETTINGS, fingerprint: { events: ["title"] } } },
    });
    const { docs } = await collectPublished(adapter, { types: ["events"] });
    expect(docs[0]?.fieldHashes.title).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(docs)).not.toContain(STRAPI_MARKERS.harvest);
  });

  it("builds only GET requests", async () => {
    const { adapter, seen } = over();
    await adapter.types();
    await adapter.draftsReachable();
    await collectPublished(adapter);
    await adapter.publicDrafts();
    expect(requestProblems(seen)).toEqual([]);
  });

  it("states its bounds", () => {
    expect(STRAPI_PAGE_SIZE).toBe(100);
    expect(STRAPI_LIMITS).toEqual({ itemsPerType: 10_000, publicIds: 500 });
  });

  it("a collection over the bound is could-not-check, never a count of part of it", async () => {
    const { adapter } = over({ adapter: { maxItemsPerType: 1 } });
    expect(await reasonOf(adapter.fieldCounts("events", ["title"]))).toMatch(/more than 1/);
  });
});

describe("Strapi: what a visitor with no token can list", () => {
  it("positive: a Public role that lists drafts gives the unpublished entries, as a count and ids", async () => {
    const { adapter, seen } = over({
      fixture: { publicPublished: ["events", "menu-items"], publicDrafts: ["events"] },
    });
    const got = await adapter.publicDrafts();
    expect(got).toEqual([
      { type: "events", state: "reachable", unpublished: 1, ids: ["evt-new-year"] },
      { type: "menu-items", state: "refused", unpublished: 0, ids: [] },
      { type: "reviews", state: "private", unpublished: 0, ids: [] },
    ]);
    // None of it carries the token.
    for (const s of seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.url).not.toContain(KEY);
    }
    expect(JSON.stringify(got)).not.toContain(STRAPI_MARKERS.newYear);
  });

  it("negative: a Public role that lists only published entries, or nothing, is safe", async () => {
    const { adapter } = over({ fixture: { publicPublished: ["events", "menu-items"] } });
    expect((await adapter.publicDrafts()).map((d) => d.state)).toEqual([
      "refused",
      "refused",
      "private",
    ]);
  });

  it("negative: nothing waiting is reported as nothing", async () => {
    const { adapter } = over({
      content: BRASS_SETTLED,
      fixture: { publicPublished: ["events"], publicDrafts: ["events"] },
    });
    expect((await adapter.publicDrafts({ types: ["events"] }))[0]).toMatchObject({
      state: "nothing",
      unpublished: 0,
    });
  });

  it("Strapi 4's spelling is asked after Strapi 5's is refused with 400", async () => {
    const { adapter, seen } = over({
      fixture: { version: 4, publicPublished: ["events"], publicDrafts: ["events"] },
    });
    const [events] = await adapter.publicDrafts({ types: ["events"] });
    expect(events).toMatchObject({ state: "reachable", unpublished: 1, ids: ["3"] });
    const params = seen.map((s) => [...new URL(s.url).searchParams.keys()]);
    expect(params.some((p) => p.includes("status"))).toBe(true);
    expect(params.some((p) => p.includes("publicationState"))).toBe(true);
  });
});
