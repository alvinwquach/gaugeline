import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import {
  PAYLOAD_LIMITS,
  PAYLOAD_PAGE_SIZE,
  createPayloadAdapter,
  type PayloadAdapterOptions,
} from "../payload.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapters, resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  API_URL,
  FORBIDDEN_MESSAGE,
  PAYLOAD_MARKERS,
  QUILLON,
  QUILLON_SETTLED,
  QUILLON_URLS,
  forbidden,
  payloadTransport,
  type PayloadFixtureCollection,
  type PayloadFixtureOptions,
} from "./payload-fixture.js";

const KEY = testKey("payload-unit");
const ENV = { PAYLOAD_URL: API_URL, PAYLOAD_API_KEY: KEY };
const SETTINGS = {
  id: "payload",
  urls: { ...QUILLON_URLS },
  privateCollections: ["wholesale-orders", "events"],
};

function over(
  options: {
    content?: readonly PayloadFixtureCollection[];
    fixture?: PayloadFixtureOptions;
    adapter?: Partial<PayloadAdapterOptions>;
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(
      options.transport ??
        payloadTransport(options.content ?? QUILLON, { key: KEY, ...options.fixture }),
      seen,
    ),
    timeoutMs: 5000,
  });
  const adapter = createPayloadAdapter({
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

/** A list answer in Payload's shape, with the paging fields filled in. */
const listing = (docs: unknown[], extra: Record<string, unknown> = {}) => ({
  docs,
  totalDocs: docs.length,
  limit: 100,
  totalPages: 1,
  page: 1,
  pagingCounter: 1,
  hasPrevPage: false,
  hasNextPage: false,
  prevPage: null,
  nextPage: null,
  ...extra,
});

const path = (s: Seen): string => new URL(s.url).pathname;
const param = (s: Seen, name: string): string | null => new URL(s.url).searchParams.get(name);

describe("Payload on ContentAdapter: what it says about itself", () => {
  it("asks for a read-only key, and says where to read how", () => {
    const { adapter } = over();
    expect(adapter.id).toBe("payload");
    expect(adapter.describe()).toEqual({
      name: "Payload",
      docsUrl: "https://gaugeline.dev/docs/integrations/payload",
      keyKind: "read-only",
    });
    expect(adapterHeader(adapter.describe())).toBe(
      "Content system: Payload, with a read-only key. Endpoints and how to make the key: https://gaugeline.dev/docs/integrations/payload",
    );
  });

  it("is built, not planned, and a settings file can name it", async () => {
    expect(BUILT_ADAPTERS.has("payload")).toBe(true);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "payload")).toBe(false);
    const config = adaptersConfigSchema.parse({
      adapters: [
        {
          id: "payload",
          urls: QUILLON_URLS,
          privateCollections: ["wholesale-orders"],
          authCollection: "staff",
        },
      ],
    });
    expect(resolveAdapters(config).map((b) => b.id)).toEqual(["payload"]);
    const fetcher = createFetcher({ transport: payloadTransport() });
    const created = await createAdapters(config, { env: ENV, fetcher });
    expect(created.map((a) => a.id)).toEqual(["payload"]);
  });

  it("privateCollections and authCollection: another adapter's entry is refused, and a bad value is", () => {
    for (const key of ["privateCollections", "authCollection"] as const) {
      const value = key === "authCollection" ? "staff" : ["x"];
      expect(
        adaptersConfigSchema.safeParse({ adapters: [{ id: "strapi", [key]: value }] }).success,
      ).toBe(false);
    }
    const bad = (extra: Record<string, unknown>) =>
      adaptersConfigSchema.safeParse({ adapters: [{ id: "payload", ...extra }] }).success;
    expect(bad({ authCollection: "Staff" })).toBe(false);
    expect(bad({ authCollection: "staff members" })).toBe(false);
    expect(bad({ authCollection: "staff\r\nx-evil: 1" })).toBe(false);
    expect(bad({ authCollection: "staff-members" })).toBe(true);
    expect(bad({ privateCollections: [] })).toBe(false);
    expect(bad({ privateCollections: ["a/b"] })).toBe(false);
  });

  it("names its collections from the settings, and the private ones apart", () => {
    const { adapter } = over();
    expect(adapter.collections()).toEqual(["events", "posts"]);
    expect(adapter.privateCollections()).toEqual(["wholesale-orders", "events"]);
  });
});

describe("Payload: the key and the site", () => {
  it("no address is could-not-check and no request is made", async () => {
    const { adapter, seen } = over({ adapter: { env: { PAYLOAD_API_KEY: KEY } } });
    expect(await reasonOf(adapter.types())).toMatch(/PAYLOAD_URL/);
    expect(seen).toEqual([]);
  });

  it("no key: unpublished work is could-not-check naming the variable, and nothing is asked", async () => {
    const { adapter, seen } = over({ adapter: { env: { PAYLOAD_URL: API_URL } } });
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/PAYLOAD_API_KEY/);
    expect(seen).toEqual([]);
  });

  it("no key: published documents are read as a visitor reads them, with no Authorization header", async () => {
    const { adapter, seen } = over({
      adapter: { env: { PAYLOAD_URL: API_URL } },
      fixture: { publicRead: ["events"] },
    });
    const got = await collectPublished(adapter, { types: ["events"] });
    expect(got.docs.map((d) => d.id)).toEqual(["1", "2"]);
    for (const s of seen)
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("an http address never gets the key: could-not-check, nothing is sent", async () => {
    const { adapter, seen } = over({
      adapter: {
        env: { PAYLOAD_URL: "http://studio.quillon-coffee.example/api", PAYLOAD_API_KEY: KEY },
      },
    });
    expect(await reasonOf(adapter.types())).toMatch(/plain http/);
    expect(seen).toEqual([]);
  });

  it("an address with a user name or password in it is refused", async () => {
    const address = new URL(API_URL);
    address.username = "admin";
    address.password = ["hush", "puppy", "42"].join("");
    const { adapter } = over({
      adapter: { env: { PAYLOAD_URL: address.href, PAYLOAD_API_KEY: KEY } },
    });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/no user name or password/);
    expect(reason).not.toContain(address.password);
  });

  it("the key goes in the `<auth collection> API-Key <key>` header, never in an address", async () => {
    const { adapter, seen } = over();
    await adapter.types();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.headers.authorization).toBe(`users API-Key ${KEY}`);
      expect(s.url).not.toContain(KEY);
    }
  });

  it("authCollection changes the slug in the header, and a slug that is not kebab-case never reaches it", async () => {
    const custom = over({
      adapter: { settings: { ...SETTINGS, authCollection: "staff-members" } },
      fixture: { authCollection: "staff-members" },
    });
    await custom.adapter.types();
    expect(custom.seen[0]?.headers.authorization).toBe(`staff-members API-Key ${KEY}`);
    const bad = over({
      adapter: { settings: { ...SETTINGS, authCollection: "staff\r\nx-evil: 1" } },
    });
    expect(await reasonOf(bad.adapter.types())).toMatch(/authCollection/);
    expect(bad.seen).toEqual([]);
  });

  it("a key with a space, a line break or a non-ASCII character is refused naming the variable, and nothing is sent", async () => {
    for (const bad of [`${KEY} x`, `${KEY}\nx-evil: 1`, `${KEY}é`]) {
      const { adapter, seen } = over({
        adapter: { env: { PAYLOAD_URL: API_URL, PAYLOAD_API_KEY: bad } },
      });
      expect(await reasonOf(adapter.types())).toMatch(/PAYLOAD_API_KEY/);
      expect(seen).toEqual([]);
    }
  });

  it("the key goes to the configured origin only, and a redirect to another origin drops it", async () => {
    const seen: Seen[] = [];
    const transport: Transport = (url, req) => {
      seen.push({ method: req.method, url: url.href, headers: req.headers });
      if (url.host === "studio.quillon-coffee.example")
        return Promise.resolve({
          status: 302,
          headers: { location: "https://cdn.elsewhere.example/api/events" },
          body: Readable.from([]),
        });
      return json(200, listing([]));
    };
    const adapter = createPayloadAdapter({
      env: ENV,
      fetcher: createFetcher({ transport, timeoutMs: 5000 }),
      settings: { id: "payload", urls: { events: "/e/{slug}" } },
    });
    await adapter.types();
    expect(seen.map((s) => new URL(s.url).host)).toContain("cdn.elsewhere.example");
    expect(seen[0]?.headers.authorization).toBe(`users API-Key ${KEY}`);
    expect(
      seen.find((s) => new URL(s.url).host === "cdn.elsewhere.example")?.headers.authorization,
    ).toBeUndefined();
    for (const s of seen) expect(s.url).not.toContain(KEY);
  });

  it("a wrong key is no user, so Payload answers 403: could-not-check naming the key and the setting, never showing it", async () => {
    const { adapter } = over({ fixture: { key: "some-other-key-value" } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/403/);
    expect(reason).toMatch(/PAYLOAD_API_KEY/);
    expect(reason).toMatch(/authCollection/);
    expect(reason).not.toContain(KEY);
  });

  it("a collection the user may not read: that read is could-not-check, the others still read", async () => {
    const { adapter } = over({ fixture: { denied: ["events"] } });
    expect(await reasonOf(adapter.types())).toMatch(/would not let/);
    const got = await collectPublished(adapter, { types: ["posts"] });
    expect(got.docs.map((d) => d.id)).toEqual(["6650a1c0", "6650a1c1"]);
    expect(await reasonOf(collectPublished(adapter, { types: ["events"] }))).toMatch(
      /would not let/,
    );
  });

  it("a collection that does not exist is Payload's 404, said with the spelling and address hint", async () => {
    const { adapter } = over({
      adapter: { settings: { id: "payload", urls: { evnts: "/x/{slug}" } } },
    });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/HTTP 404/);
    expect(reason).toMatch(/API route/);
  });

  it("no collections named: types() is empty and unpublished work is could-not-check, never false", async () => {
    const { adapter } = over({ adapter: { settings: { id: "payload" } } });
    expect(await adapter.types()).toEqual([]);
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/No collection is named/);
  });

  it("a collection name that is not a Payload slug never reaches an address", async () => {
    for (const name of ["a.b", "Events", "a_b", "../x", "a/b", "events?x=1"]) {
      const { adapter, seen } = over({
        adapter: { settings: { id: "payload", urls: { [name]: "/x/{slug}" } } },
      });
      expect(await reasonOf(adapter.types())).toMatch(/not a Payload collection slug/);
      expect(seen).toEqual([]);
    }
  });

  it("an answer that is not JSON, not a list or has no id is could-not-check", async () => {
    const html: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from("<html>login</html>")]),
      });
    expect(await reasonOf(over({ transport: html }).adapter.types())).toMatch(/not JSON/);
    const noList: Transport = () => json(200, listing([], { docs: "nope", totalDocs: 1 }));
    expect(await reasonOf(over({ transport: noList }).adapter.types())).toMatch(/not a list/);
    const noId: Transport = () => json(200, listing([{ slug: "x" }]));
    expect(await reasonOf(collectPublished(over({ transport: noId }).adapter))).toMatch(/no id/);
  });
});

describe("Payload: what it reads", () => {
  it("reads published documents only: counts, ids, slugs and times, never a draft", async () => {
    const { adapter } = over();
    expect(await adapter.types()).toEqual([
      { name: "events", count: 2 },
      { name: "posts", count: 2 },
    ]);
    const { docs } = await collectPublished(adapter);
    expect(docs.map((d) => `${d.type}:${d.id}`)).toEqual([
      "events:1",
      "events:2",
      "posts:6650a1c0",
      "posts:6650a1c1",
    ]);
    expect(docs[2]).toEqual({
      id: "6650a1c0",
      type: "posts",
      url: "/journal/harvest-blend",
      slug: "harvest-blend",
      publishedAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-20T08:30:00.000Z",
      fieldHashes: {},
    });
    expect(JSON.stringify(docs)).not.toContain(PAYLOAD_MARKERS.secret);
    expect(JSON.stringify(docs)).not.toContain("winter-cupping");
  });

  it("a status that is not the word published is not published, whatever its type", async () => {
    const rows =
      (status: unknown): Transport =>
      () =>
        json(200, listing([{ id: "a", _status: status, createdAt: "2026-11-01T00:00:00.000Z" }]));
    for (const status of ["draft", "archived", "", null, 0, false, { x: 1 }, ["published"]]) {
      const { adapter } = over({
        transport: rows(status),
        adapter: { settings: { id: "payload", urls: { posts: "/p/{id}" } } },
      });
      expect(await adapter.types(), JSON.stringify(status)).toEqual([{ name: "posts", count: 0 }]);
      expect((await collectPublished(adapter)).docs).toEqual([]);
    }
    const { adapter } = over({
      transport: rows("published"),
      adapter: { settings: { id: "payload", urls: { posts: "/p/{id}" } } },
    });
    expect(await adapter.types()).toEqual([{ name: "posts", count: 1 }]);
  });

  it("only a missing _status means the collection has no drafts: its documents are all live", async () => {
    const { adapter } = over();
    const events = (await collectPublished(adapter, { types: ["events"] })).docs;
    expect(events.map((d) => d.id)).toEqual(["1", "2"]);
    // A numeric id is kept as text.
    expect(events[0]?.id).toBe("1");
  });

  it("publishedAt is createdAt, and a document with no updatedAt takes its createdAt; neither is could-not-check", async () => {
    const one =
      (d: Record<string, unknown>): Transport =>
      () =>
        json(200, listing([d]));
    const settings = { id: "payload", urls: { posts: "/p/{id}" } };
    const a = await collectPublished(
      over({
        transport: one({ id: "a", createdAt: "2026-10-01T09:00:00Z" }),
        adapter: { settings },
      }).adapter,
    );
    expect(a.docs[0]).toMatchObject({
      publishedAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
    });
    const b = over({ transport: one({ id: "a" }), adapter: { settings } }).adapter;
    expect(await reasonOf(collectPublished(b))).toMatch(/neither updatedAt nor createdAt/);
    const c = over({
      transport: one({ id: "a", updatedAt: "not a date" }),
      adapter: { settings },
    }).adapter;
    expect(await reasonOf(collectPublished(c))).toMatch(/neither updatedAt nor createdAt/);
  });

  it("since keeps only documents changed at or after it", async () => {
    const { adapter } = over();
    const got = await collectPublished(adapter, {
      types: ["posts"],
      since: "2026-11-01T00:00:00Z",
    });
    expect(got.docs.map((d) => d.id)).toEqual(["6650a1c1"]);
    await expect(async () => {
      for await (const d of adapter.published({ since: "yesterday" })) void d;
    }).rejects.toThrow(TypeError);
  });

  it("limit stops after that many documents", async () => {
    const { adapter } = over();
    expect((await collectPublished(adapter, { limit: 3 })).docs).toHaveLength(3);
  });

  it("pages in a fixed order with an exact page number, and the end is the reported totalDocs", async () => {
    const many: PayloadFixtureCollection[] = [
      {
        slug: "posts",
        docs: Array.from({ length: 11 }, (_v, i) => ({
          id: i + 1,
          fields: { slug: `p${i + 1}` },
          created: "2026-10-01T00:00:00.000Z",
          updated: "2026-10-02T00:00:00.000Z",
        })),
      },
    ];
    const { adapter, seen } = over({ content: many, adapter: { pageSize: 4 } });
    const { docs } = await collectPublished(adapter, { types: ["posts"] });
    expect(docs).toHaveLength(11);
    expect(new Set(docs.map((d) => d.id)).size).toBe(11);
    expect(seen.map((s) => param(s, "page"))).toEqual(["1", "2", "3"]);
    for (const s of seen) {
      expect(param(s, "limit")).toBe("4");
      expect(param(s, "sort")).toBe("id");
      expect(param(s, "depth")).toBe("0");
    }
  });

  it("a list with no totalDocs, no page number or no hasNextPage is could-not-check, never the end", async () => {
    const bad =
      (body: Record<string, unknown>): Transport =>
      () =>
        json(200, { ...listing([{ id: "a", createdAt: "2026-10-01T00:00:00Z" }]), ...body });
    expect(
      await reasonOf(over({ transport: bad({ totalDocs: undefined }) }).adapter.types()),
    ).toMatch(/totalDocs/);
    expect(await reasonOf(over({ transport: bad({ totalDocs: "1" }) }).adapter.types())).toMatch(
      /totalDocs/,
    );
    expect(await reasonOf(over({ transport: bad({ totalDocs: -1 }) }).adapter.types())).toMatch(
      /totalDocs/,
    );
    expect(await reasonOf(over({ transport: bad({ page: 2 }) }).adapter.types())).toMatch(/page 2/);
    expect(
      await reasonOf(over({ transport: bad({ hasNextPage: undefined }) }).adapter.types()),
    ).toMatch(/another page/);
    expect(await reasonOf(over({ transport: bad({ hasNextPage: true }) }).adapter.types())).toMatch(
      /another page after all/,
    );
  });

  it("a list that stops before its count is could-not-check, not the end", async () => {
    const real = payloadTransport(QUILLON, { key: KEY });
    const stops: Transport = (url, req) =>
      url.searchParams.get("page") === "2"
        ? json(200, listing([], { totalDocs: 3, page: 2, hasNextPage: true }))
        : real(url, req);
    const { adapter } = over({ transport: stops, adapter: { pageSize: 2 } });
    expect(await reasonOf(collectPublished(adapter, { types: ["posts"] }))).toMatch(
      /stopped after 2 of 3/,
    );
    const noMore: Transport = () =>
      json(200, listing([{ id: "a" }, { id: "b" }], { totalDocs: 5, hasNextPage: false }));
    expect(await reasonOf(over({ transport: noMore }).adapter.types())).toMatch(
      /stopped after 2 of 5/,
    );
  });

  it("a short page while Payload says there is more, or more rows than asked for, is could-not-check", async () => {
    const short: Transport = () =>
      json(200, listing([{ id: "a" }], { totalDocs: 9, hasNextPage: true }));
    expect(
      await reasonOf(over({ transport: short, adapter: { pageSize: 4 } }).adapter.types()),
    ).toMatch(/1 documents when 4 were asked/);
    const rows = Array.from({ length: 5 }, (_v, i) => ({ id: `r${i}` }));
    const long: Transport = () => json(200, listing(rows));
    expect(
      await reasonOf(over({ transport: long, adapter: { pageSize: 4 } }).adapter.types()),
    ).toMatch(/5 documents when 4 were asked/);
  });

  it("a refusal or a failure after the first page is could-not-check, never the end of the list", async () => {
    const real = payloadTransport(QUILLON, { key: KEY });
    for (const status of [403, 500, 404]) {
      const after: Transport = (url, req) =>
        url.searchParams.get("page") === "2"
          ? json(status, { errors: [{ message: FORBIDDEN_MESSAGE }] })
          : real(url, req);
      const { adapter } = over({ transport: after, adapter: { pageSize: 2 } });
      const reason = await reasonOf(collectPublished(adapter, { types: ["posts"] }));
      expect(reason, String(status)).toMatch(new RegExp(`${status}`));
    }
  });

  it("a server that ignores the page repeats an id: could-not-check; one that answers another page is too", async () => {
    const same: Transport = (url) =>
      json(
        200,
        listing([{ id: "a" }, { id: "b" }], {
          totalDocs: 4,
          hasNextPage: true,
          page: Number(url.searchParams.get("page")),
        }),
      );
    const reason = await reasonOf(
      over({ transport: same, adapter: { pageSize: 2 } }).adapter.types(),
    );
    expect(reason).toMatch(/same document twice \(id a\)/);
    const stuck: Transport = () =>
      json(200, listing([{ id: "a" }, { id: "b" }], { totalDocs: 4, hasNextPage: true, page: 1 }));
    expect(
      await reasonOf(over({ transport: stuck, adapter: { pageSize: 2 } }).adapter.types()),
    ).toMatch(/page 1 when page 2/);
  });

  it("more documents than the count, or a count that moved between pages, is 'the list changed'", async () => {
    const more: Transport = () => json(200, listing([{ id: "a" }, { id: "b" }], { totalDocs: 1 }));
    expect(await reasonOf(over({ transport: more }).adapter.types())).toMatch(/list changed/);
    let n = 0;
    const moves: Transport = (url) => {
      n++;
      const page = Number(url.searchParams.get("page"));
      return json(
        200,
        listing([{ id: `p${page}a` }, { id: `p${page}b` }], {
          totalDocs: n === 1 ? 4 : 5,
          page,
          hasNextPage: true,
        }),
      );
    };
    expect(
      await reasonOf(over({ transport: moves, adapter: { pageSize: 2 } }).adapter.types()),
    ).toMatch(/reported 4 documents and then 5/);
  });

  it("a collection over the bound is could-not-check, whatever count the server reports", async () => {
    const { adapter } = over({ adapter: { maxItemsPerType: 1 } });
    expect(await reasonOf(adapter.types())).toMatch(/more than 1/);
    const lying: Transport = () => json(200, listing([{ id: "a" }, { id: "b" }], { totalDocs: 1 }));
    expect(
      await reasonOf(over({ transport: lying, adapter: { maxItemsPerType: 1 } }).adapter.types()),
    ).toMatch(/more documents than the 1/);
    // With a limit asked for, a big collection is not refused for its size alone.
    const got = await collectPublished(
      over({ adapter: { maxItemsPerType: 1, pageSize: 1 } }).adapter,
      {
        limit: 1,
        types: ["posts"],
      },
    );
    expect(got.docs).toHaveLength(1);
  });

  it("drops a select Payload refuses (400) once and reads whole documents", async () => {
    const { adapter, seen } = over({ fixture: { strictSelect: true } });
    const got = await collectPublished(
      over({
        fixture: { strictSelect: true },
        adapter: { settings: { ...SETTINGS, fingerprint: { posts: ["nope"] } } },
      }).adapter,
      { types: ["posts"] },
    );
    expect(got.docs).toHaveLength(2);
    expect(await adapter.types()).toHaveLength(2);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("an answer over the size limit is asked again with a smaller page whose page number stays exact", async () => {
    const real = payloadTransport(QUILLON, { key: KEY });
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
    expect((await collectPublished(adapter, { types: ["posts"] })).docs.map((d) => d.id)).toEqual([
      "6650a1c0",
      "6650a1c1",
    ]);
    expect(seen.some((s) => param(s, "limit") === "50" && param(s, "page") === "1")).toBe(true);
    const never: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.alloc(6 * 1024 * 1024, 32)]),
      });
    expect(await reasonOf(over({ transport: never }).adapter.types())).toMatch(
      /larger than the 5 MB/,
    );
  });

  it("fingerprints are hashes: no value of a field reaches the result", async () => {
    const { adapter } = over({
      adapter: { settings: { ...SETTINGS, fingerprint: { posts: ["title", "summary"] } } },
    });
    const { docs } = await collectPublished(adapter, { types: ["posts"] });
    expect(docs[0]?.fieldHashes.title).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(docs[1]?.fieldHashes ?? {})).toEqual(["title"]);
    expect(JSON.stringify(docs)).not.toContain(PAYLOAD_MARKERS.harvest);
    expect(JSON.stringify(docs)).not.toContain(PAYLOAD_MARKERS.harvestSummary);
    expect(await adapter.fieldCounts("posts", ["title", "summary", "slug", "subtitle"])).toEqual({
      title: 2,
      summary: 1,
      slug: 2,
      subtitle: 0,
    });
    expect(await adapter.fieldCounts("not-named", ["title"])).toEqual({ title: 0 });
  });

  it("a field named like an Object.prototype member is not read from the prototype", async () => {
    const { adapter } = over({
      adapter: { settings: { ...SETTINGS, fingerprint: { posts: ["constructor", "__proto__"] } } },
    });
    const { docs } = await collectPublished(adapter, { types: ["posts"] });
    expect(docs.every((d) => Object.keys(d.fieldHashes).length === 0)).toBe(true);
    expect(await adapter.fieldCounts("posts", ["constructor"])).toEqual({ constructor: 0 });
  });

  it("slug is selected only when the collection's pattern uses it; select asks for the fields named and nothing else", async () => {
    const { adapter, seen } = over({
      adapter: {
        settings: {
          id: "payload",
          urls: { posts: "/journal/{id}" },
          fingerprint: { posts: ["title"] },
        },
      },
    });
    await collectPublished(adapter, { types: ["posts"] });
    const keys = [...new URL(seen[0]?.url ?? "").searchParams.keys()].filter((k) =>
      k.startsWith("select"),
    );
    expect(keys.sort()).toEqual([
      "select[_status]",
      "select[createdAt]",
      "select[title]",
      "select[updatedAt]",
    ]);
    const withSlug = over();
    await collectPublished(withSlug.adapter, { types: ["posts"] });
    expect(withSlug.seen[0]?.url).toContain("select%5Bslug%5D=true");
  });

  it("a rate limit that stays carries what was read so far", async () => {
    const real = payloadTransport(QUILLON, { key: KEY });
    let n = 0;
    const limited: Transport = (url, req) =>
      ++n > 1 ? json(429, {}, { "retry-after": "600" }) : real(url, req);
    const { adapter } = over({ transport: limited });
    const got = await collectPublished(adapter, { types: ["events", "posts"] });
    expect(got.partial).toBeDefined();
    expect(got.docs.map((d) => d.id)).toEqual(["1", "2"]);
  });

  it("builds only GET requests, and the key is never in an address", async () => {
    const { adapter, seen } = over();
    await adapter.types();
    await adapter.fieldCounts("posts", ["title"]);
    await adapter.draftsReachable();
    await collectPublished(adapter);
    await adapter.publicCollections();
    expect(seen.length).toBeGreaterThan(5);
    expect(requestProblems(seen)).toEqual([]);
    for (const s of seen) expect(s.url).not.toContain(KEY);
  });

  it("states its bounds", () => {
    expect(PAYLOAD_PAGE_SIZE).toBe(100);
    expect(PAYLOAD_LIMITS).toEqual({ itemsPerType: 10_000 });
  });
});

describe("Payload: unpublished work the key can reach", () => {
  it("true when a collection holds a draft, false when settled", async () => {
    expect(await over().adapter.draftsReachable()).toBe(true);
    expect(await over({ content: QUILLON_SETTLED }).adapter.draftsReachable()).toBe(false);
  });

  it("asks for a count only: limit 1, the status only, the one where, and reads nothing else", async () => {
    const { adapter, seen } = over();
    await adapter.draftsReachable();
    const asked = seen.filter((s) => param(s, "where[_status][equals]") === "draft");
    expect(asked.length).toBeGreaterThan(0);
    for (const s of asked) {
      expect(param(s, "limit")).toBe("1");
      expect(param(s, "select[_status]")).toBe("true");
    }
  });

  it("a collection with no drafts (Payload refuses the query with 400) is 'no drafts' only after one document shows it has no _status", async () => {
    const { adapter } = over({
      adapter: { settings: { id: "payload", urls: { events: "/e/{slug}" } } },
    });
    expect(await adapter.draftsReachable()).toBe(false);
    // An empty collection that refuses the query proves nothing.
    const empty = over({
      content: [{ slug: "events", docs: [] }],
      adapter: { settings: { id: "payload", urls: { events: "/e/{slug}" } } },
    });
    expect(await reasonOf(empty.adapter.draftsReachable())).toMatch(/HTTP 400/);
    // A collection that has _status and refuses the query is not read as 'no drafts' either.
    const refuses: Transport = (url) =>
      url.searchParams.has("where[_status][equals]")
        ? json(400, { errors: [{ message: "no" }] })
        : json(200, listing([{ id: "a", _status: "published" }]));
    expect(await reasonOf(over({ transport: refuses }).adapter.draftsReachable())).toMatch(
      /HTTP 400/,
    );
  });

  it("a collection that could not be asked, with no draft seen elsewhere, is could-not-check, not false", async () => {
    expect(
      await reasonOf(
        over({
          fixture: { denied: ["posts"] },
          content: QUILLON_SETTLED,
        }).adapter.draftsReachable(),
      ),
    ).toMatch(/would not let/);
  });

  it("a draft seen elsewhere is true even when another collection could not be asked", async () => {
    expect(await over({ fixture: { denied: ["events"] } }).adapter.draftsReachable()).toBe(true);
  });

  it("a count that is not a whole number is could-not-check", async () => {
    const odd: Transport = () => json(200, { docs: [], totalDocs: "3" });
    expect(await reasonOf(over({ transport: odd }).adapter.draftsReachable())).toMatch(/totalDocs/);
  });
});

describe("Payload: what a visitor with no key can list of the collections marked private", () => {
  it("positive: a collection a visitor can read gives a count, and nothing else", async () => {
    const { adapter, seen } = over({ fixture: { publicRead: ["wholesale-orders"] } });
    const got = await adapter.publicCollections();
    expect(got).toEqual([
      { type: "wholesale-orders", state: "public", listed: 2, exact: true },
      { type: "events", state: "closed", listed: 0, exact: true },
    ]);
    expect(seen.map(path)).toEqual(["/api/wholesale-orders", "/api/events"]);
    for (const s of seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.url).not.toContain(KEY);
      expect(param(s, "select[id]")).toBe("true");
      expect(param(s, "limit")).toBe("1");
    }
    expect(JSON.stringify(got)).not.toContain(PAYLOAD_MARKERS.order);
  });

  it("negative: a collection with no public read is closed, and the key is never used", async () => {
    const { adapter, seen } = over();
    const got = await adapter.publicCollections();
    expect(got.map((c) => c.state)).toEqual(["closed", "closed"]);
    for (const s of seen) expect(s.headers.authorization).toBeUndefined();
  });

  it("works with no key set at all", async () => {
    const { adapter } = over({ adapter: { env: { PAYLOAD_URL: API_URL } } });
    expect((await adapter.publicCollections()).map((c) => c.state)).toEqual(["closed", "closed"]);
  });

  it("without totalDocs the count is 'at least' the documents shown", async () => {
    const t: Transport = () => json(200, { docs: [{ id: "a" }] });
    expect((await over({ transport: t }).adapter.publicCollections())[0]).toEqual({
      type: "wholesale-orders",
      state: "public",
      listed: 1,
      exact: false,
    });
  });

  it("an empty answer is 'empty', never a pass; a server error is unread with its reason", async () => {
    const { adapter } = over({
      content: QUILLON.map((c) => (c.slug === "wholesale-orders" ? { ...c, docs: [] } : c)),
      fixture: { publicRead: ["wholesale-orders"] },
    });
    expect((await adapter.publicCollections())[0]?.state).toBe("empty");
    const down: Transport = () => json(500, {});
    const got = await over({ transport: down }).adapter.publicCollections();
    expect(got[0]).toMatchObject({ state: "unread" });
    expect(got[0]?.reason).toMatch(/HTTP 500/);
  });

  it("a collection that does not exist is a 404 and unread with the spelling named, never closed", async () => {
    const { adapter } = over({
      adapter: { settings: { ...SETTINGS, privateCollections: ["wholesale-ordres"] } },
    });
    const got = await adapter.publicCollections();
    expect(got[0]?.state).toBe("unread");
    expect(got[0]?.reason).toMatch(/spelling in privateCollections/);
  });

  it("a rate limit that stays is carried with what was read", async () => {
    const real = payloadTransport(QUILLON, { publicRead: ["wholesale-orders"] });
    let n = 0;
    const limited: Transport = (url, req) =>
      ++n > 1 ? json(429, {}, { "retry-after": "600" }) : real(url, req);
    const err: unknown = await over({ transport: limited })
      .adapter.publicCollections()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
    expect((err as AdapterRateLimitedError).partial).toEqual([
      { type: "wholesale-orders", state: "public", listed: 2, exact: true },
    ]);
  });

  it("with nothing marked private nothing is asked", async () => {
    const { adapter, seen } = over({
      adapter: { settings: { id: "payload", urls: QUILLON_URLS } },
    });
    expect(await adapter.publicCollections()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("a name that is not a Payload slug is unread and never reaches an address", async () => {
    const { adapter, seen } = over({
      adapter: { settings: { ...SETTINGS, privateCollections: ["a/b", "Orders"] } },
    });
    const got = await adapter.publicCollections();
    expect(got.map((c) => c.state)).toEqual(["unread", "unread"]);
    expect(seen).toEqual([]);
  });

  it("no address is unread with the variable named", async () => {
    const { adapter } = over({ adapter: { env: {} } });
    const got = await adapter.publicCollections();
    expect(got.map((c) => c.state)).toEqual(["unread", "unread"]);
    expect(got[0]?.reason).toMatch(/PAYLOAD_URL/);
  });
});

describe("Payload: the visitor probe proves Payload answered", () => {
  const real = payloadTransport(QUILLON, { key: KEY });
  const visitor =
    (answer: () => ReturnType<Transport>): Transport =>
    (url, req) =>
      req.headers.authorization === undefined ? answer() : real(url, req);

  it("a 403 that is not Payload's refusal (a CDN or WAF page) is unread, never closed", async () => {
    const html = visitor(() =>
      Promise.resolve({
        status: 403,
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from("<html>Attention Required</html>")]),
      }),
    );
    const got = await over({ transport: html }).adapter.publicCollections();
    expect(got.map((c) => c.state)).toEqual(["unread", "unread"]);
    expect(got[0]?.reason).toMatch(/not Payload's refusal/);
  });

  it("a JSON 403 with another message, or a translated one, or no errors list, is unread", async () => {
    for (const body of [
      { message: "blocked" },
      { errors: [{ message: "Nicht erlaubt." }] },
      { errors: [] },
      { errors: ["You are not allowed to perform this action."] },
      { errors: [{ message: FORBIDDEN_MESSAGE.toLowerCase() }] },
    ]) {
      const got = await over({
        transport: visitor(() => json(403, body)),
      }).adapter.publicCollections();
      expect(
        got.map((c) => c.state),
        JSON.stringify(body),
      ).toEqual(["unread", "unread"]);
    }
  });

  it("only a 403 is a closed collection: a 401 or a 400 is unread", async () => {
    for (const status of [401, 400, 405, 503]) {
      const got = await over({
        transport: visitor(() => json(status, { errors: [{ message: FORBIDDEN_MESSAGE }] })),
      }).adapter.publicCollections();
      expect(
        got.map((c) => c.state),
        String(status),
      ).toEqual(["unread", "unread"]);
    }
    const ok = await over({ transport: visitor(() => forbidden()) }).adapter.publicCollections();
    expect(ok.map((c) => c.state)).toEqual(["closed", "closed"]);
  });

  it("a redirect is not followed: a cross-origin 302 to a server that lists documents is unread, and that server is never asked", async () => {
    const hosts: string[] = [];
    const redirecting: Transport = (url, req) => {
      hosts.push(url.host);
      if (url.host === "elsewhere.example") return json(200, listing([{ id: 1 }]));
      return req.headers.authorization === undefined
        ? Promise.resolve({
            status: 302,
            headers: { location: "https://elsewhere.example/api/wholesale-orders" },
            body: Readable.from([]),
          })
        : real(url, req);
    };
    const got = await over({ transport: redirecting }).adapter.publicCollections();
    expect(got.map((c) => c.state)).toEqual(["unread", "unread"]);
    expect(got[0]?.reason).toMatch(/redirect/);
    expect(hosts).not.toContain("elsewhere.example");
  });

  it("a 200 that is not a Payload list is unread (a login page, a JSON of another shape)", async () => {
    for (const body of [
      "<html>login</html>",
      JSON.stringify({ data: [{ id: 1 }] }),
      JSON.stringify([1]),
    ]) {
      const t = visitor(() =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([Buffer.from(body)]),
        }),
      );
      const got = await over({ transport: t }).adapter.publicCollections();
      expect(
        got.map((c) => c.state),
        body,
      ).toEqual(["unread", "unread"]);
    }
  });

  it("rows with a count of 0, or a count with no rows, are unread; the larger of count and rows is listed", async () => {
    const a = await over({
      transport: visitor(() => json(200, { docs: [{ id: 1 }], totalDocs: 0 })),
    }).adapter.publicCollections();
    expect(a[0]?.state).toBe("unread");
    const b = await over({
      transport: visitor(() => json(200, { docs: [], totalDocs: 3 })),
    }).adapter.publicCollections();
    expect(b[0]?.state).toBe("unread");
    const c = await over({
      transport: visitor(() => json(200, { docs: [{ id: 1 }], totalDocs: 4 })),
    }).adapter.publicCollections();
    expect(c[0]).toMatchObject({ state: "public", listed: 4, exact: true });
  });

  it("the answer's documents are used for their number only", async () => {
    const t = visitor(() =>
      json(200, { docs: [{ id: 1, customer: PAYLOAD_MARKERS.order }], totalDocs: 1 }),
    );
    const got = await over({ transport: t }).adapter.publicCollections();
    expect(JSON.stringify(got)).not.toContain(PAYLOAD_MARKERS.order);
  });
});
