import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import {
  DIRECTUS_LIMITS,
  DIRECTUS_PAGE_SIZE,
  createDirectusAdapter,
  type DirectusAdapterOptions,
} from "../directus.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapters, resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  CMS_URL,
  DIRECTUS_MARKERS,
  LARKSPUR,
  LARKSPUR_SETTLED,
  LARKSPUR_URLS,
  directusTransport,
  type DirectusFixtureCollection,
  type DirectusFixtureOptions,
} from "./directus-fixture.js";

const KEY = testKey("directus-unit");
const ENV = { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: KEY };
const SETTINGS = {
  id: "directus",
  urls: { ...LARKSPUR_URLS, notices: "/notices/{slug}" },
  privateCollections: ["appointments", "notices"],
};

function over(
  options: {
    content?: readonly DirectusFixtureCollection[];
    fixture?: DirectusFixtureOptions;
    adapter?: Partial<DirectusAdapterOptions>;
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(
      options.transport ??
        directusTransport(options.content ?? LARKSPUR, { token: KEY, ...options.fixture }),
      seen,
    ),
    timeoutMs: 5000,
  });
  const adapter = createDirectusAdapter({
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

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

describe("Directus on ContentAdapter: what it says about itself", () => {
  it("asks for a read-only token, and says where to read how", () => {
    const { adapter } = over();
    expect(adapter.id).toBe("directus");
    expect(adapter.describe()).toEqual({
      name: "Directus",
      docsUrl: "https://gaugeline.dev/docs/integrations/directus",
      keyKind: "read-only",
    });
    expect(adapterHeader(adapter.describe())).toBe(
      "Content system: Directus, with a read-only key. Endpoints and how to make the key: https://gaugeline.dev/docs/integrations/directus",
    );
  });

  it("is built, not planned, and a settings file can name it", async () => {
    expect(BUILT_ADAPTERS.has("directus")).toBe(true);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "directus")).toBe(false);
    const config = adaptersConfigSchema.parse({
      adapters: [{ id: "directus", urls: LARKSPUR_URLS, privateCollections: ["appointments"] }],
    });
    expect(resolveAdapters(config).map((b) => b.id)).toEqual(["directus"]);
    const fetcher = createFetcher({ transport: directusTransport() });
    const created = await createAdapters(config, { env: ENV, fetcher });
    expect(created.map((a) => a.id)).toEqual(["directus"]);
  });

  it("privateCollections belongs to Directus: another adapter's entry is refused, and a bad name is", () => {
    const refused = adaptersConfigSchema.safeParse({
      adapters: [{ id: "strapi", privateCollections: ["x"] }],
    });
    expect(refused.success).toBe(false);
    expect(
      adaptersConfigSchema.safeParse({
        adapters: [{ id: "directus", privateCollections: ["a/b"] }],
      }).success,
    ).toBe(false);
    expect(
      adaptersConfigSchema.safeParse({ adapters: [{ id: "directus", privateCollections: [] }] })
        .success,
    ).toBe(false);
  });

  it("names its collections from the settings, and the private ones apart", () => {
    const { adapter } = over();
    expect(adapter.collections()).toEqual(["classes", "notices", "teachers"]);
    expect(adapter.privateCollections()).toEqual(["appointments", "notices"]);
  });
});

describe("Directus: the key and the site", () => {
  it("no address is could-not-check and no request is made", async () => {
    const { adapter, seen } = over({ adapter: { env: { DIRECTUS_TOKEN: KEY } } });
    expect(await reasonOf(adapter.types())).toMatch(/DIRECTUS_URL/);
    expect(seen).toEqual([]);
  });

  it("no token: unpublished work is could-not-check naming the variable, and nothing is asked", async () => {
    const { adapter, seen } = over({ adapter: { env: { DIRECTUS_URL: CMS_URL } } });
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/DIRECTUS_TOKEN/);
    expect(seen).toEqual([]);
  });

  it("no token: published items are read as a visitor reads them, with no Authorization header", async () => {
    const { adapter, seen } = over({
      adapter: { env: { DIRECTUS_URL: CMS_URL } },
      fixture: { publicRead: ["classes"] },
    });
    const got = await collectPublished(adapter, { types: ["classes"] });
    expect(got.docs.map((d) => d.id)).toEqual(["1", "2"]);
    for (const s of seen)
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("an http address never gets the token: could-not-check, nothing is sent", async () => {
    const { adapter, seen } = over({
      adapter: { env: { DIRECTUS_URL: "http://cms.larkspur-yoga.example", DIRECTUS_TOKEN: KEY } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/plain http/);
    expect(seen).toEqual([]);
  });

  it("an address with a user name or password in it is refused", async () => {
    const address = new URL(CMS_URL);
    address.username = "admin";
    address.password = ["hush", "puppy", "42"].join("");
    const { adapter } = over({
      adapter: { env: { DIRECTUS_URL: address.href, DIRECTUS_TOKEN: KEY } },
    });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/no user name or password/);
    expect(reason).not.toContain(address.password);
  });

  it("the token goes in a header to the configured origin only, and a redirect to another origin drops it", async () => {
    const seen: Seen[] = [];
    const transport: Transport = (url, req) => {
      seen.push({ method: req.method, url: url.href, headers: req.headers });
      if (url.host === "cms.larkspur-yoga.example")
        return Promise.resolve({
          status: 302,
          headers: { location: "https://cdn.elsewhere.example/items/classes" },
          body: Readable.from([]),
        });
      return json(200, { data: [], meta: { filter_count: 0 } });
    };
    const adapter = createDirectusAdapter({
      env: ENV,
      fetcher: createFetcher({ transport, timeoutMs: 5000 }),
      settings: { id: "directus", urls: { classes: "/c/{slug}" } },
    });
    await adapter.types();
    expect(seen.map((s) => new URL(s.url).host)).toContain("cdn.elsewhere.example");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(
      seen.find((s) => new URL(s.url).host === "cdn.elsewhere.example")?.headers.authorization,
    ).toBeUndefined();
    for (const s of seen) expect(s.url).not.toContain(KEY);
  });

  it("a wrong token is could-not-check (HTTP 401) and never shows the token", async () => {
    const { adapter } = over({ fixture: { token: "some-other-token-value" } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/401/);
    expect(reason).not.toContain(KEY);
  });

  it("a collection the token may not read: that read is could-not-check, the others still read", async () => {
    const { adapter } = over({ fixture: { denied: ["classes"] } });
    expect(await reasonOf(adapter.types())).toMatch(/would not let/);
    const got = await collectPublished(adapter, { types: ["notices", "teachers"] });
    expect(got.docs.map((d) => d.id)).toEqual(["4", "t-ana", "t-ben"]);
    expect(await reasonOf(collectPublished(adapter, { types: ["classes"] }))).toMatch(
      /would not let/,
    );
  });

  it("a collection that does not exist is Directus's 403, said with the spelling hint", async () => {
    const { adapter } = over({
      adapter: { settings: { id: "directus", urls: { clases: "/x/{slug}" } } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/does not exist: check the spelling/);
  });

  it("no collections named: types() is empty and unpublished work is could-not-check, never false", async () => {
    const { adapter } = over({ adapter: { settings: { id: "directus" } } });
    expect(await adapter.types()).toEqual([]);
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/No collection is named/);
  });

  it("a collection name that is not a Directus name never reaches an address", async () => {
    const { adapter, seen } = over({
      adapter: { settings: { id: "directus", urls: { "a.b": "/x/{slug}" } } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/not a Directus collection name/);
    expect(seen).toEqual([]);
  });

  it("an answer that is not JSON, or not a list, is could-not-check", async () => {
    const html: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from("<html>login</html>")]),
      });
    expect(await reasonOf(over({ transport: html }).adapter.types())).toMatch(/not JSON/);
    const noList: Transport = () => json(200, { data: "nope" });
    expect(await reasonOf(over({ transport: noList }).adapter.types())).toMatch(/not a list/);
    const noId: Transport = () => json(200, { data: [{ slug: "x" }], meta: { filter_count: 1 } });
    expect(await reasonOf(collectPublished(over({ transport: noId }).adapter))).toMatch(/no id/);
  });
});

describe("Directus: what it reads", () => {
  it("reads published items only: counts, ids, slugs and times, never a draft", async () => {
    const { adapter } = over();
    expect(await adapter.types()).toEqual([
      { name: "classes", count: 2 },
      { name: "notices", count: 1 },
      { name: "teachers", count: 2 },
    ]);
    const { docs } = await collectPublished(adapter, { types: ["classes", "teachers"] });
    expect(docs.map((d) => [d.id, d.slug, d.url, d.updatedAt])).toEqual([
      ["1", "morning-flow", "/classes/morning-flow", "2026-10-20T08:30:00.000Z"],
      ["2", "evening-stretch", "/classes/evening-stretch", "2026-11-02T17:00:00.000Z"],
      ["t-ana", "ana", "/teachers/ana", "2026-09-01T09:00:00.000Z"],
      // No date_updated: the creation time stands in.
      ["t-ben", "ben", "/teachers/ben", "2026-10-10T09:00:00.000Z"],
    ]);
    expect(JSON.stringify(docs)).not.toContain(DIRECTUS_MARKERS.retreat);
  });

  it("a null status is not published, and a text id (a UUID) is kept as text", async () => {
    const content: DirectusFixtureCollection[] = [
      {
        name: "classes",
        items: [
          {
            id: "9f1c",
            status: "published",
            fields: { slug: "a" },
            created: "2026-10-01T09:00:00.000Z",
            updated: null,
          },
          {
            id: "2a7e",
            status: null,
            fields: { slug: "b" },
            created: "2026-10-01T09:00:00.000Z",
            updated: null,
          },
          {
            id: "3b8d",
            status: "archived",
            fields: { slug: "c" },
            created: "2026-10-01T09:00:00.000Z",
            updated: null,
          },
        ],
      },
    ];
    const { adapter } = over({
      content,
      adapter: { settings: { id: "directus", urls: { classes: "/c/{slug}" } } },
    });
    expect((await collectPublished(adapter, { types: ["classes"] })).docs.map((d) => d.id)).toEqual(
      ["9f1c"],
    );
    expect(await adapter.types()).toEqual([{ name: "classes", count: 1 }]);
    expect(await adapter.draftsReachable()).toBe(true);
  });

  it("a collection with no status field: every item is live, and it has no drafts", async () => {
    const content = LARKSPUR.map((c) =>
      c.name === "notices" ? { ...c, items: c.items.map(({ status: _s, ...i }) => i) } : c,
    );
    const { adapter } = over({ content, fixture: { noStatus: ["notices"] } });
    expect(await adapter.types()).toContainEqual({ name: "notices", count: 1 });
    expect((await collectPublished(adapter, { types: ["notices"] })).docs.map((d) => d.id)).toEqual(
      ["4"],
    );
    expect(await adapter.draftsReachable()).toBe(true);
    // Settled elsewhere: a collection with no status field alone does not make drafts reachable.
    const settled = LARKSPUR_SETTLED.map((c) =>
      c.name === "notices" ? { ...c, items: c.items.map(({ status: _s, ...i }) => i) } : c,
    );
    expect(
      await over({
        content: settled,
        fixture: { noStatus: ["notices"] },
      }).adapter.draftsReachable(),
    ).toBe(false);
  });

  it("a filter Directus refuses with 400 on a collection that does have a status is could-not-check, never 'no drafts'", async () => {
    const base = directusTransport(LARKSPUR_SETTLED, { token: KEY });
    const dislikes: Transport = (url, req) =>
      url.searchParams.has("filter")
        ? json(400, { errors: [{ message: "Invalid query." }] })
        : base(url, req);
    const { adapter } = over({ transport: dislikes });
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/HTTP 400/);
    expect(await reasonOf(adapter.types())).toMatch(/HTTP 400/);
  });

  it("pages through a collection, following a server that holds answers below the limit asked for", async () => {
    const { adapter, seen } = over({ adapter: { pageSize: 5 }, fixture: { maxLimit: 1 } });
    const { docs } = await collectPublished(adapter, { types: ["classes"] });
    expect(docs.map((d) => d.id)).toEqual(["1", "2"]);
    const offsets = seen
      .map((s) => new URL(s.url).searchParams)
      .filter((q) => q.get("sort") === "id")
      .map((q) => q.get("offset"));
    expect(offsets).toEqual(["0", "1", "2"]);
  });

  it("without meta.filter_count the end of a list is an empty page, and counts are made by reading", async () => {
    const { adapter } = over({ fixture: { noMeta: true }, adapter: { pageSize: 2 } });
    expect(await adapter.types()).toEqual([
      { name: "classes", count: 2 },
      { name: "notices", count: 1 },
      { name: "teachers", count: 2 },
    ]);
    expect((await collectPublished(adapter, { types: ["classes"] })).docs.map((d) => d.id)).toEqual(
      ["1", "2"],
    );
  });

  it("a list that stops before its reported count is could-not-check, not the end", async () => {
    const lying: Transport = (url) =>
      json(
        200,
        url.searchParams.get("offset") === "0"
          ? {
              data: [{ id: 1, status: "published", date_created: "2026-10-01T09:00:00Z" }],
              meta: { filter_count: 5 },
            }
          : { data: [], meta: { filter_count: 5 } },
      );
    const { adapter } = over({ transport: lying });
    expect(await reasonOf(collectPublished(adapter, { types: ["classes"] }))).toMatch(
      /stopped after 1 of 5/,
    );
  });

  it("a collection over the bound is could-not-check, whatever count the server reports", async () => {
    const { adapter } = over({ adapter: { maxItemsPerType: 1 } });
    expect(await reasonOf(adapter.fieldCounts("classes", ["name"]))).toMatch(/more than 1/);
    const noMeta = over({ adapter: { maxItemsPerType: 1 }, fixture: { noMeta: true } });
    expect(await reasonOf(noMeta.adapter.fieldCounts("classes", ["name"]))).toMatch(
      /more items than the 1/,
    );
  });

  it("a singleton answers one object, not a list", async () => {
    const single: Transport = () =>
      json(200, {
        data: { id: 1, status: "published", slug: "home", date_updated: "2026-10-01T09:00:00Z" },
      });
    const { adapter } = over({
      transport: single,
      adapter: { settings: { id: "directus", urls: { home: "/{slug}" } } },
    });
    const { docs } = await collectPublished(adapter, { types: ["home"] });
    expect(docs.map((d) => [d.id, d.url])).toEqual([["1", "/home"]]);
  });

  it("drops a field selection Directus refuses (400) once and reads whole items", async () => {
    const { adapter, seen } = over({ fixture: { strictFields: true } });
    const counts = await adapter.fieldCounts("classes", ["name", "seats"]);
    expect(counts).toEqual({ name: 2, seats: 0 });
    expect(seen.filter((s) => !new URL(s.url).searchParams.has("fields")).length).toBeGreaterThan(
      0,
    );
  });

  it("an answer over the size limit is asked again with a smaller page", async () => {
    const real = directusTransport(LARKSPUR, { token: KEY });
    const big: Transport = async (url, req) => {
      if (Number(url.searchParams.get("limit")) > 50)
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([Buffer.alloc(6 * 1024 * 1024, 32)]),
        };
      return real(url, req);
    };
    const { adapter, seen } = over({ transport: big });
    expect((await collectPublished(adapter, { types: ["classes"] })).docs.map((d) => d.id)).toEqual(
      ["1", "2"],
    );
    expect(seen.some((s) => new URL(s.url).searchParams.get("limit") === "50")).toBe(true);
  });

  it("fingerprints are hashes: no value of a field reaches the result", async () => {
    const { adapter } = over({
      adapter: { settings: { ...SETTINGS, fingerprint: { classes: ["name", "summary"] } } },
    });
    const { docs } = await collectPublished(adapter, { types: ["classes"] });
    expect(docs[0]?.fieldHashes.name).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(docs[1]?.fieldHashes ?? {})).toEqual(["name"]);
    expect(JSON.stringify(docs)).not.toContain(DIRECTUS_MARKERS.morning);
    expect(JSON.stringify(docs)).not.toContain(DIRECTUS_MARKERS.morningSummary);
  });

  it("a rate limit that stays carries what was read so far", async () => {
    const real = directusTransport(LARKSPUR, { token: KEY });
    let n = 0;
    const limited: Transport = (url, req) =>
      ++n > 1 ? json(429, {}, { "retry-after": "600" }) : real(url, req);
    const { adapter } = over({ transport: limited });
    const err: unknown = await collectPublished(adapter, { types: ["classes", "teachers"] }).then(
      (r) => r,
      (e: unknown) => e,
    );
    // collectPublished turns the limit into a partial read; either shape is a statement, never a pass.
    if (err instanceof AdapterRateLimitedError) expect(err.partial).toBeDefined();
    else expect((err as { partial?: unknown }).partial).toBeDefined();
  });

  it("builds only GET requests, and the token is never in an address", async () => {
    const { adapter, seen } = over();
    await adapter.types();
    await adapter.draftsReachable();
    await collectPublished(adapter);
    await adapter.publicCollections();
    expect(requestProblems(seen)).toEqual([]);
    for (const s of seen) expect(s.url).not.toContain(KEY);
  });

  it("states its bounds", () => {
    expect(DIRECTUS_PAGE_SIZE).toBe(100);
    expect(DIRECTUS_LIMITS).toEqual({ itemsPerType: 10_000 });
  });
});

describe("Directus: unpublished work the token can reach", () => {
  it("true when a collection holds an item that is not published, false when settled", async () => {
    expect(await over().adapter.draftsReachable()).toBe(true);
    expect(await over({ content: LARKSPUR_SETTLED }).adapter.draftsReachable()).toBe(false);
  });

  it("a collection that could not be asked, with no draft seen elsewhere, is could-not-check, not false", async () => {
    const { adapter } = over({ content: LARKSPUR_SETTLED, fixture: { denied: ["teachers"] } });
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/would not let/);
  });

  it("a draft seen elsewhere is true even when another collection could not be asked", async () => {
    const { adapter } = over({ fixture: { denied: ["teachers"] } });
    expect(await adapter.draftsReachable()).toBe(true);
  });
});

describe("Directus: what a visitor with no token can list of the collections marked private", () => {
  it("positive: a Public role that reads a private collection gives a count, and nothing else", async () => {
    const { adapter, seen } = over({ fixture: { publicRead: ["appointments"] } });
    const got = await adapter.publicCollections();
    expect(got).toEqual([
      { type: "appointments", state: "public", listed: 2, exact: true },
      { type: "notices", state: "closed", listed: 0, exact: true },
    ]);
    for (const s of seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.url).not.toContain(KEY);
      expect(new URL(s.url).searchParams.get("fields")).toBe("id");
      expect(new URL(s.url).searchParams.get("limit")).toBe("1");
    }
    expect(JSON.stringify(got)).not.toContain(DIRECTUS_MARKERS.booking);
  });

  it("negative: a Public role with no access is a closed collection", async () => {
    const got = await over().adapter.publicCollections();
    expect(got.map((c) => c.state)).toEqual(["closed", "closed"]);
  });

  it("without meta the count is 'at least' the items shown", async () => {
    const { adapter } = over({ fixture: { publicRead: ["appointments"], noMeta: true } });
    expect((await adapter.publicCollections())[0]).toEqual({
      type: "appointments",
      state: "public",
      listed: 1,
      exact: false,
    });
  });

  it("an empty answer is 'empty', never a pass; a missing route is unread with its reason", async () => {
    const { adapter } = over({
      content: LARKSPUR.map((c) => (c.name === "appointments" ? { ...c, items: [] } : c)),
      fixture: { publicRead: ["appointments"] },
    });
    expect((await adapter.publicCollections())[0]?.state).toBe("empty");
    const down: Transport = () => json(500, {});
    const got = await over({ transport: down }).adapter.publicCollections();
    expect(got[0]).toMatchObject({ state: "unread" });
    expect(got[0]?.reason).toMatch(/HTTP 500/);
  });

  it("a rate limit that stays is carried with what was read", async () => {
    const real = directusTransport(LARKSPUR, { publicRead: ["appointments"] });
    let n = 0;
    const limited: Transport = (url, req) =>
      ++n > 1 ? json(429, {}, { "retry-after": "600" }) : real(url, req);
    const { adapter } = over({ transport: limited });
    const err: unknown = await adapter.publicCollections().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
    expect((err as AdapterRateLimitedError).partial).toEqual([
      { type: "appointments", state: "public", listed: 2, exact: true },
    ]);
  });

  it("with nothing marked private nothing is asked", async () => {
    const { adapter, seen } = over({
      adapter: { settings: { id: "directus", urls: LARKSPUR_URLS } },
    });
    expect(await adapter.publicCollections()).toEqual([]);
    expect(seen).toEqual([]);
  });
});
