import { afterEach, describe, expect, it, vi } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { resolveQueryAllow } from "../../fetch/query-registry.js";
import { createFetcher, FetchError, type Fetcher, type Transport } from "../../fetcher.js";
import { QueryRefusedError } from "../../fetch/read-only-query.js";
import { collectPublished } from "../collect.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError, type AdapterSettings } from "../types.js";
import { WIX_QUERY_ALLOW, createWixAdapter, type WixAdapter } from "../wix.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  MARLOW_COLLECTIONS,
  MARLOW_SITE_ID,
  WIX_NATIVE_MARKERS,
  cursorFor,
  wixTransport,
  type WixItem,
  type WixTransportOptions,
} from "./wix-native-fixture.js";

afterEach(() => vi.restoreAllMocks());

const KEY = testKey("wix-native");
const SETTINGS: AdapterSettings = {
  id: "wix",
  siteId: MARLOW_SITE_ID,
  urls: { Programs: "/programs/{slug}", Testimonials: "/testimonials/{id}" },
};

function build(
  server: Partial<WixTransportOptions> = {},
  extra: {
    settings?: AdapterSettings;
    pageSize?: number;
    maxItemsPerType?: number;
    key?: string;
    wrap?: (t: Transport) => Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const base = wixTransport({ key: KEY, ...server });
  const fetcher = createFetcher({
    transport: recording(extra.wrap ? extra.wrap(base) : base, seen),
    timeoutMs: 5000,
  });
  const adapter = createWixAdapter({
    env: { WIX_API_KEY: extra.key ?? KEY },
    fetcher,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    settings: extra.settings ?? SETTINGS,
    ...(extra.pageSize === undefined ? {} : { pageSize: extra.pageSize }),
    ...(extra.maxItemsPerType === undefined ? {} : { maxItemsPerType: extra.maxItemsPerType }),
  });
  return { adapter, seen, sleeps, fetcher };
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const items = (n: number, prefix = "item"): WixItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    data: {
      _id: `${prefix}-${i}`,
      _updatedDate: { $date: "2026-11-01T00:00:00.000Z" },
      title: `t${i}`,
    },
  }));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body,
});

describe("a healthy Wix site: the collections the settings name", () => {
  it("counts items, field counts and fingerprints, and sends only read-only queries", async () => {
    const { adapter, seen } = build();
    expect(await adapter.types()).toEqual([
      { name: "Programs", count: 3 },
      { name: "Testimonials", count: 2 },
    ]);
    expect(await adapter.fieldCounts("Programs", ["title", "blurb", "slug", "subtitle"])).toEqual({
      title: 3,
      blurb: 1,
      slug: 3,
      subtitle: 0,
    });
    const { docs } = await collectPublished(adapter, {
      types: ["Programs"],
      fields: { Programs: ["title"] },
      since: "2026-11-01",
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: "prog-spring-cohort",
      type: "Programs",
      slug: "spring-cohort",
      url: "/programs/spring-cohort",
      updatedAt: "2026-11-09T07:30:00.000Z",
    });
    expect(Object.keys(docs[0]?.fieldHashes ?? {})).toEqual(["title"]);
    expect(requestProblems(seen, [WIX_QUERY_ALLOW])).toEqual([]);
    for (const s of seen) {
      expect(s.method).toBe("POST");
      expect(new URL(s.url).host).toBe("www.wixapis.com");
      expect(s.body).not.toContain("$");
    }
  });

  it("the entry is registered, frozen, and marked as not verified against Wix's page", () => {
    expect(resolveQueryAllow("wix-data-query")).toBe(WIX_QUERY_ALLOW);
    expect(Object.isFrozen(WIX_QUERY_ALLOW)).toBe(true);
    expect(WIX_QUERY_ALLOW.docs.checked).toBeNull();
    expect(WIX_QUERY_ALLOW.host).toBe("www.wixapis.com");
  });

  it("never returns a field value, hashes only the fields asked for, and gives the same hashes twice", async () => {
    const a = await collectPublished(build().adapter, {
      fields: { Programs: ["title", "blurb"] },
    });
    const b = await collectPublished(build().adapter, {
      fields: { Programs: ["title", "blurb"] },
    });
    expect(b.docs).toEqual(a.docs);
    const text = JSON.stringify(a.docs);
    for (const marker of Object.values(WIX_NATIVE_MARKERS)) expect(text).not.toContain(marker);
    const testimonial = a.docs.find((d) => d.type === "Testimonials");
    expect(testimonial?.fieldHashes).toEqual({});
  });

  it("an item whose field changed has a different hash, and an unchanged one the same", async () => {
    const changed = structuredClone(MARLOW_COLLECTIONS);
    const first = changed.Programs?.[0];
    if (first) first.data.title = "A different title";
    const opts = { types: ["Programs"], fields: { Programs: ["title"] } };
    const before = (await collectPublished(build().adapter, opts)).docs;
    const after = (await collectPublished(build({ collections: changed }).adapter, opts)).docs;
    expect(after[0]?.fieldHashes.title).not.toBe(before[0]?.fieldHashes.title);
    expect(after[1]?.fieldHashes.title).toBe(before[1]?.fieldHashes.title);
  });

  it("draftsReachable is not-applicable and asks for nothing", async () => {
    const { adapter, seen } = build();
    expect(await adapter.draftsReachable()).toBe("not-applicable");
    expect(seen).toEqual([]);
  });

  it("limit stops the read early and asks for no more than it needs", async () => {
    const { adapter, seen } = build({}, { pageSize: 2 });
    const { docs } = await collectPublished(adapter, { types: ["Programs"], limit: 2 });
    expect(docs).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });
});

describe("the key and the headers", () => {
  it("the key is the Authorization header, the site id its own header, and neither is anywhere else", async () => {
    const { adapter, seen } = build();
    await adapter.types();
    await collectPublished(adapter);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.headers.authorization).toBe(KEY);
      expect(s.headers["wix-site-id"]).toBe(MARLOW_SITE_ID);
      expect(s.url).not.toContain(KEY);
      expect(s.body ?? "").not.toContain(KEY);
      expect(s.body ?? "").not.toContain(MARLOW_SITE_ID);
    }
  });

  it("no key, no query: the live-site read sends the key nowhere and no POST", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(wixTransport({ key: KEY }), seen),
      timeoutMs: 5000,
    });
    const adapter = createWixAdapter({ fetcher, site: "https://marlow-coaching.example" });
    await adapter.types().catch(() => undefined);
    for (const s of seen) {
      expect(s.method).not.toBe("POST");
      expect(s.headers.authorization).toBeUndefined();
    }
  });

  it("a key that is wrong is could-not-check for every part, and the reason has no key", async () => {
    const { adapter } = build({ key: "some-other-key" });
    for (const call of [
      () => adapter.types(),
      () => adapter.fieldCounts("Programs", ["title"]),
      () => collectPublished(adapter),
    ]) {
      const reason = await reasonOf(call());
      expect(reason).toContain("WIX_API_KEY");
      expect(reason).not.toContain(KEY);
      expect(reason).toContain("401");
    }
  });

  it("a key with a space, a newline or a control character is never sent", async () => {
    for (const bad of ["a b", "a\nb", "a\u0000b", "café"]) {
      const { adapter, seen } = build({}, { key: bad });
      const reason = await reasonOf(adapter.types());
      expect(reason).toContain("WIX_API_KEY");
      expect(seen).toEqual([]);
    }
  });

  it("the site id must be an id: nothing is sent for another value", async () => {
    for (const siteId of [undefined, "", "short", "id with spaces 123", "x/../y-12345678"]) {
      const { adapter, seen } = build(
        {},
        {
          settings: { ...SETTINGS, ...(siteId === undefined ? { siteId: undefined } : { siteId }) },
        },
      );
      expect(await reasonOf(adapter.types())).toContain("siteId");
      expect(seen).toEqual([]);
    }
  });

  it("empty settings are could-not-check: no collection named, nothing asked", async () => {
    const { adapter, seen } = build({}, { settings: { id: "wix", siteId: MARLOW_SITE_ID } });
    expect(adapter.collections()).toEqual([]);
    expect(await reasonOf(adapter.types())).toContain("No collection is named");
    expect(await reasonOf(adapter.fieldCounts("Programs", ["title"]))).toContain("No collection");
    expect(await reasonOf(collectPublished(adapter))).toContain("No collection");
    expect(seen).toEqual([]);
  });

  it("a fetcher that cannot send a query is could-not-check, not a crash", async () => {
    const { fetcher } = build();
    const bare: Fetcher = { ...fetcher, query: undefined as never };
    delete (bare as { query?: unknown }).query;
    const adapter = createWixAdapter({
      env: { WIX_API_KEY: KEY },
      fetcher: bare,
      settings: SETTINGS,
    });
    expect(await reasonOf(adapter.types())).toContain("cannot send a read-only query");
  });
});

describe("a key that may not read one collection: could-not-check for that part only", () => {
  it("readCollections counts the others and names why one was not read", async () => {
    const { adapter } = build({ deny: ["Testimonials"] });
    const got = await adapter.readCollections();
    expect(got[0]).toEqual({ type: "Programs", count: 3 });
    expect(got[1]).toMatchObject({ type: "Testimonials" });
    const reason = (got[1] as { reason: string }).reason;
    expect(reason).toContain("Testimonials");
    expect(reason).toContain("403");
    expect(reason).not.toContain(KEY);
  });

  it("types() is could-not-check naming the collection, never a list without it", async () => {
    const { adapter } = build({ deny: ["Testimonials"] });
    expect(await reasonOf(adapter.types())).toContain("Testimonials");
  });

  it("the collection that is readable still reads on its own", async () => {
    const { adapter } = build({ deny: ["Testimonials"] });
    const { docs } = await collectPublished(adapter, { types: ["Programs"] });
    expect(docs).toHaveLength(3);
    await expect(collectPublished(adapter, { types: ["Testimonials"] })).rejects.toBeInstanceOf(
      AdapterCouldNotCheck,
    );
  });

  it("a collection Wix does not have (404) names the collection and the setting to check", async () => {
    const { adapter } = build({ collections: { Programs: MARLOW_COLLECTIONS.Programs ?? [] } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("Testimonials");
    expect(reason).toContain("404");
  });
});

describe("drift: what Wix answers is not always what was expected", () => {
  it("an item with no usable id, or no update time, is could-not-check, never skipped", async () => {
    const odd = (data: Record<string, unknown>, id?: unknown) => ({
      collections: { Programs: [{ id: id as string, data }] },
    });
    const date = { _updatedDate: { $date: "2026-11-01T00:00:00.000Z" } };
    for (const server of [
      odd({ _id: "../evil", ...date }, "../evil"),
      odd({ ...date }, undefined),
      odd({ _id: "a".repeat(129), ...date }, "a".repeat(129)),
      odd({ _id: "ok-1" }, "ok-1"),
    ]) {
      const { adapter } = build(server, {
        settings: { ...SETTINGS, urls: { Programs: "/p/{id}" } },
      });
      await reasonOf(adapter.types());
    }
  });

  it("a slug that is not plain ASCII is left out and gives no address; lone surrogates never throw", async () => {
    const odd = (slug: string): WixItem => ({
      id: "x-1",
      data: { _id: "x-1", _updatedDate: "2026-11-01T00:00:00Z", slug },
    });
    for (const slug of ["\ud800", "a\udc00b", "/evil", "//evil.example", "café", "", "a b"]) {
      const { adapter } = build({ collections: { Programs: [odd(slug)] } });
      const { docs } = await collectPublished(adapter, { types: ["Programs"] });
      expect(docs).toHaveLength(1);
      expect(docs[0]?.slug).toBeUndefined();
      expect(docs[0]?.url).toBeUndefined();
    }
  });

  it("an address pattern that would name another site is never an address", async () => {
    for (const template of ["//other.example/{slug}", "/\\other.example/{slug}"]) {
      const { adapter } = build({}, { settings: { ...SETTINGS, urls: { Programs: template } } });
      const { docs } = await collectPublished(adapter, { types: ["Programs"] });
      for (const d of docs) expect(d.url).toBeUndefined();
    }
  });

  it("dates come as {$date} or as text, and an update time is read from either", async () => {
    const make = (d: unknown): WixItem => ({ id: "d-1", data: { _id: "d-1", _updatedDate: d } });
    for (const d of [{ $date: "2026-11-01T10:00:00Z" }, "2026-11-01T10:00:00Z"]) {
      const { adapter } = build({ collections: { Programs: [make(d)] } });
      const { docs } = await collectPublished(adapter, { types: ["Programs"] });
      expect(docs[0]?.updatedAt).toBe("2026-11-01T10:00:00.000Z");
    }
  });

  it("an answer that is not JSON, not an object or has no list is could-not-check", async () => {
    for (const reply of [
      json(200, "not json at all"),
      json(200, []),
      json(200, { dataItems: "nope" }),
      json(200, {}),
    ])
      await reasonOf(build({ handler: () => reply }).adapter.types());
  });

  it("other statuses are named by number and never by the answer's text", async () => {
    const { adapter } = build({
      handler: () => json(500, { message: WIX_NATIVE_MARKERS.spring }),
    });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("500");
    expect(reason).not.toContain(WIX_NATIVE_MARKERS.spring);
  });

  it("an unreachable Wix is could-not-check in fixed words", async () => {
    const { adapter } = build(
      {},
      {
        wrap: () => () =>
          Promise.reject(Object.assign(new Error("boom " + KEY), { code: "ECONNRESET" })),
      },
    );
    const reason = await reasonOf(adapter.types());
    expect(reason).not.toContain(KEY);
    expect(FetchError.name).toBe("FetchError");
  });

  it("a collection name that is not an id is could-not-check and nothing is sent", async () => {
    const { adapter, seen } = build(
      {},
      { settings: { ...SETTINGS, urls: undefined, fingerprint: undefined } },
    );
    expect(await reasonOf(adapter.types())).toContain("No collection");
    const odd = build({}, { settings: { ...SETTINGS, urls: { "bad/name": "/x/{id}" } } });
    expect(await reasonOf(odd.adapter.types())).toContain("is not a Wix collection ID");
    expect(odd.seen).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("a field name that is not a name is could-not-check and nothing is sent", async () => {
    const { adapter, seen } = build();
    expect(await reasonOf(adapter.fieldCounts("Programs", ["a b"]))).toContain("field name");
    expect(
      await reasonOf(collectPublished(adapter, { fields: { Programs: ["__proto__.x y"] } })),
    ).toContain("field name");
    expect(seen).toEqual([]);
  });

  it("a field named like an object's own property is not read from the prototype", async () => {
    const { adapter } = build();
    expect(await adapter.fieldCounts("Programs", ["constructor", "toString"])).toEqual({
      constructor: 0,
      toString: 0,
    });
  });
});

describe("pagination stops at the real end", () => {
  const many = { Programs: items(7) };
  const only = { settings: { ...SETTINGS, urls: { Programs: "/programs/{slug}" } } };

  it("reads every page by the cursor the server gives, whatever limit was asked for", async () => {
    const { adapter, seen } = build({ collections: many, serverMax: 3 }, { pageSize: 5, ...only });
    expect((await adapter.types())[0]).toEqual({ name: "Programs", count: 7 });
    // 3 + 3 + 1: the server's own page size, not the one asked for, sets the steps.
    expect(seen).toHaveLength(3);
    expect(JSON.parse(seen[1]?.body ?? "{}").query.cursorPaging.cursor).toBe(cursorFor(3));
  });

  it("a page that fills the limit and has no cursor is the end: no extra request", async () => {
    const { adapter, seen } = build(
      { collections: { Programs: items(2) } },
      { pageSize: 2, ...only },
    );
    expect((await adapter.types())[0]?.count).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("a short page that still has a cursor is not the end", async () => {
    const { adapter } = build({ collections: many, serverMax: 2 }, { pageSize: 100, ...only });
    expect((await adapter.types())[0]?.count).toBe(7);
  });

  it("the first page of the projection and later pages carry the cursor only", async () => {
    const { seen, adapter } = build({ collections: many, serverMax: 3 }, only);
    await adapter.fieldCounts("Programs", ["title"]);
    const first = JSON.parse(seen[0]?.body ?? "{}");
    const second = JSON.parse(seen[1]?.body ?? "{}");
    expect(first.query.fields).toEqual(["_id", "_updatedDate", "_createdDate", "slug", "title"]);
    expect(second.query.fields).toBeUndefined();
  });

  it("hasNext with no cursor is could-not-check, not the end", async () => {
    const { adapter } = build({
      handler: () =>
        json(200, {
          dataItems: [{ id: "a-1", data: { _id: "a-1", _updatedDate: "2026-11-01T00:00:00Z" } }],
          pagingMetadata: { count: 1, cursors: {}, hasNext: true },
        }),
    });
    expect(await reasonOf(adapter.types())).toContain("not read to the end");
  });

  it("a repeated cursor, an empty page that is not the end and a cursor that is not a token are could-not-check", async () => {
    const page = (next: string, n: number) =>
      json(200, {
        dataItems: items(n, `r${next.length}`).map((i) => ({ id: i.id, data: i.data })),
        pagingMetadata: { count: n, cursors: { next }, hasNext: true },
      });
    for (const handler of [
      () => page("same", 1),
      () => page("next", 0),
      () => page("DELETE FROM items", 1),
      () => page("a b", 1),
    ])
      expect(await reasonOf(build({ handler }).adapter.types())).toContain(
        "did not come to an end",
      );
  });

  it("a server that never ends is stopped by the request cap", async () => {
    let n = 0;
    const { adapter, seen } = build(
      {
        handler: () => {
          n++;
          return json(200, {
            dataItems: items(1, `loop${n}`).map((i) => ({ id: i.id, data: i.data })),
            pagingMetadata: { count: 1, cursors: { next: `c${n}` }, hasNext: true },
          });
        },
      },
      { maxItemsPerType: 30 },
    );
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/more than \d+ requests|more than 30 items/);
    expect(seen.length).toBeLessThan(20);
  });

  it("more items than the cap is could-not-check, never a count of part of a collection", async () => {
    const { adapter } = build({ collections: { Programs: items(12) } }, { maxItemsPerType: 10 });
    expect(await reasonOf(adapter.types())).toContain("more than 10 items");
  });

  it("an item repeated across pages is one item", async () => {
    const dup = items(3);
    const { adapter } = build({
      handler: (c) =>
        c.n === 0
          ? json(200, {
              dataItems: dup.slice(0, 2).map((i) => ({ id: i.id, data: i.data })),
              pagingMetadata: { count: 2, cursors: { next: "p2" }, hasNext: true },
            })
          : json(200, {
              dataItems: dup.slice(1).map((i) => ({ id: i.id, data: i.data })),
              pagingMetadata: { count: 2, cursors: {}, hasNext: false },
            }),
    });
    expect((await adapter.types())[0]?.count).toBe(3);
  });

  it("an answer over the size limit is asked again with a smaller page", async () => {
    const sizes: number[] = [];
    const big: Transport = (url, req) => {
      const limit = (JSON.parse(req.body ?? "{}") as { query: { cursorPaging: { limit: number } } })
        .query.cursorPaging.limit;
      sizes.push(limit);
      return limit > 25
        ? Promise.resolve({
            status: 200,
            headers: { "content-type": "application/json" },
            body: (async function* () {
              yield Buffer.alloc(6 * 1024 * 1024, "a");
            })() as never,
          })
        : wixTransport({ key: KEY })(url, req);
    };
    const { adapter } = build({}, { wrap: () => big });
    expect((await adapter.types())[0]?.count).toBe(3);
    expect(sizes.slice(0, 3)).toEqual([100, 50, 25]);
  });
});

describe("rate limits", () => {
  const limited = (status: 429 | 403, retry = "2") =>
    json(status, { message: "slow down" }, { "retry-after": retry });

  it("a 429 with a short Retry-After is waited out once and the read goes on", async () => {
    const { adapter, sleeps } = build({ handler: (c) => (c.n === 0 ? limited(429) : undefined) });
    expect((await adapter.types())[0]?.count).toBe(3);
    expect(sleeps).toEqual([2000]);
  });

  it("a 403 that says Retry-After is a rate limit, not a refused key", async () => {
    const { adapter, sleeps } = build({ handler: (c) => (c.n === 0 ? limited(403) : undefined) });
    expect((await adapter.types())[0]?.count).toBe(3);
    expect(sleeps).toEqual([2000]);
  });

  it("a limit that stays throws the rate limit with what was read", async () => {
    const { adapter } = build({ handler: (c) => (c.n >= 1 ? limited(429) : undefined) });
    const err: unknown = await adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
    expect((err as AdapterRateLimitedError).partial).toEqual([{ name: "Programs", count: 3 }]);
    expect((err as AdapterRateLimitedError).retry).toBe("in 2 seconds");
  });

  it("published() reports where it stopped, with the items already read", async () => {
    const { adapter } = build({ handler: (c) => (c.n >= 1 ? limited(429) : undefined) });
    const got = await collectPublished(adapter);
    expect(got.docs.map((d) => d.type)).toEqual(["Programs", "Programs", "Programs"]);
    expect(got.partial).toEqual({ reason: "rate-limited", retry: "in 2 seconds", delivered: 3 });
  });

  it("a Retry-After over a minute is not waited for", async () => {
    const { adapter, sleeps } = build({ handler: () => limited(429, "3600") });
    await expect(adapter.types()).rejects.toBeInstanceOf(AdapterRateLimitedError);
    expect(sleeps).toEqual([]);
  });
});

describe("the fetcher refuses a POST that is a write, and the key stays on its origin", () => {
  const ask = async (body: Record<string, unknown>, url?: string) => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(wixTransport({ key: KEY }), seen),
      timeoutMs: 5000,
    });
    const err: unknown = await (fetcher.query as NonNullable<Fetcher["query"]>)(
      url ?? "https://www.wixapis.com/wix-data/v2/items/query",
      {
        allow: WIX_QUERY_ALLOW.id,
        body,
        headers: { authorization: KEY, "wix-site-id": MARLOW_SITE_ID },
      },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { err, seen };
  };

  it("a body that inserts, updates, removes or carries an operator is refused before anything is sent", async () => {
    for (const body of [
      { dataCollectionId: "Programs", dataItem: { data: { a: 1 } } },
      { dataCollectionId: "Programs", insert: { a: 1 } },
      { dataCollectionId: "Programs", query: { $set: { a: 1 } } },
      { dataCollectionId: "Programs", query: { filter: { removeItem: 1 } } },
      { dataCollectionId: "Programs", query: { filter: { title: { $eq: "x" } } } },
      { dataCollectionId: "Programs", query: { fields: ["DELETE FROM Programs"] } },
      { dataCollectionId: "Programs", returnTotalCount: true },
    ]) {
      const { err, seen } = await ask(body);
      expect(err, JSON.stringify(body)).toBeInstanceOf(QueryRefusedError);
      expect(seen).toEqual([]);
    }
  });

  it("another path or host on the same allowlist entry is refused", async () => {
    const body = { dataCollectionId: "Programs", query: {} };
    for (const url of [
      "https://www.wixapis.com/wix-data/v2/items/insert",
      "https://www.wixapis.com/wix-data/v2/items",
      "https://www.wixapis.com/wix-data/v2/items/query?x=1",
      "https://evil.example/wix-data/v2/items/query",
      "http://www.wixapis.com/wix-data/v2/items/query",
    ]) {
      const { err, seen } = await ask(body, url);
      expect(err, url).toBeInstanceOf(QueryRefusedError);
      expect(seen).toEqual([]);
    }
  });

  it("a redirect is refused and the key goes nowhere else", async () => {
    const seen: Seen[] = [];
    const redirect: Transport = () =>
      Promise.resolve({
        status: 307,
        headers: { location: "https://evil.example/collect" },
        body: (async function* () {})() as never,
      });
    const fetcher = createFetcher({ transport: recording(redirect, seen), timeoutMs: 5000 });
    const adapter = createWixAdapter({ env: { WIX_API_KEY: KEY }, fetcher, settings: SETTINGS });
    const reason = await reasonOf(adapter.types());
    expect(reason).not.toContain(KEY);
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["www.wixapis.com"]);
  });

  it("the request log records the allowlist id and never the body or the key", async () => {
    const { adapter, fetcher } = build();
    await adapter.types();
    const log = JSON.stringify(fetcher.history?.() ?? []);
    expect(log).toContain("wix-data-query");
    expect(log).not.toContain(KEY);
    expect(log).not.toContain("dataCollectionId");
  });
});

describe("the adapter type", () => {
  it("a Wix adapter with a key reads collections, not pages", () => {
    const a: WixAdapter = build().adapter;
    expect(a.readsPages).toBe(false);
    expect(a.collections()).toEqual(["Programs", "Testimonials"]);
    expect(a.describe().keyKind).toBe("read-only");
    expect(a.resolveUrl?.({ id: "1", type: "Programs", slug: "x" })).toBe("/programs/x");
    expect(a.resolveUrl?.({ id: "1", type: "Programs" })).toBe("");
  });
});
