import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import {
  BLOCKED_REASONS,
  GENERIC_API_LIMITS,
  type GenericApiCollection,
  type GenericApiMapping,
} from "../generic-api-config.js";
import { createGenericApiAdapter, graphqlSelection } from "../generic-api.js";
import { resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import type { AdapterSettings } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  HERON,
  HERON_API,
  HERON_MARKERS,
  HERON_URLS,
  heronTransport,
} from "./generic-api-fixture.js";

const KEY = testKey("generic-adapter");
const ENV = { GAUGELINE_HERON_TOKEN: KEY };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]),
  });

interface World {
  api?: GenericApiMapping;
  settings?: Partial<AdapterSettings>;
  env?: Record<string, string | undefined>;
  transport?: Transport;
}

function world(w: World = {}) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const transport = recording(w.transport ?? heronTransport({ key: KEY }), seen);
  const fetcher = createFetcher({ transport, timeoutMs: 5000 });
  const adapter = createGenericApiAdapter({
    env: w.env ?? ENV,
    fetcher,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    settings: { id: "generic-api", api: w.api ?? HERON_API, urls: HERON_URLS, ...w.settings },
  });
  return { adapter, seen, sleeps };
}

/** A one-collection mapping for the tests that need a different shape of answer. */
const mini = (
  over: Partial<GenericApiCollection> = {},
  api: Partial<GenericApiMapping> = {},
): GenericApiMapping => ({
  endpoint: "https://cms.example/api",
  collections: {
    item: {
      path: "/items",
      items: "/data",
      pagination: { style: "none" },
      fields: { id: "/id", updatedAt: "/updated" },
      ...over,
    },
  },
  ...api,
});

const couldNot = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const urls = (seen: Seen[]): URL[] => seen.map((s) => new URL(s.url));

describe("paging: page numbers (a Payload-style list)", () => {
  it("reads every page, in order, asking for the page size the mapping says", async () => {
    const w = world();
    const got = await collectPublished(w.adapter, { types: ["post"] });
    expect(got.docs.map((d) => d.id)).toEqual(["p-1", "p-2", "p-3", "p-4", "p-5"]);
    const asked = urls(w.seen);
    expect(asked.map((u) => u.pathname)).toEqual(["/api/posts", "/api/posts", "/api/posts"]);
    expect(asked.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    for (const u of asked) {
      expect(u.searchParams.get("limit")).toBe("2");
      expect(u.searchParams.get("depth")).toBe("0");
    }
  });

  it("fingerprints come from the paths and the settings: ids, slugs, addresses, times, hashes", async () => {
    const w = world();
    const got = await collectPublished(w.adapter, {
      types: ["post"],
      fields: { post: ["title", "seo.title"] },
    });
    const first = got.docs[0];
    expect(first).toMatchObject({
      id: "p-1",
      type: "post",
      slug: "beginner-flow",
      url: "/blog/beginner-flow",
      publishedAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-11-04T09:00:00.000Z",
    });
    expect(Object.keys(first?.fieldHashes ?? {}).sort()).toEqual(["seo.title", "title"]);
    // p-2 has no seo block: no hash, not a hash of empty.
    expect(Object.keys(got.docs[1]?.fieldHashes ?? {})).toEqual(["title"]);
  });

  it("types() takes the count from the answer: one request for a collection with a total", async () => {
    const w = world();
    expect(await w.adapter.types()).toEqual([
      { name: "class", count: 3 },
      { name: "post", count: 5 },
      { name: "workshop", count: 3 },
    ]);
    const asked = urls(w.seen).map((u) => u.pathname);
    // class: 1, post: 1, workshop (no total): 2 pages.
    expect(asked).toEqual(["/items/classes", "/api/posts", "/", "/"]);
  });

  it("a page count in the answer ends the read without a yes-or-no flag", async () => {
    const pages = [
      { data: [{ id: "a", updated: "2026-01-01T00:00:00Z" }], pages: 2 },
      { data: [{ id: "b", updated: "2026-01-02T00:00:00Z" }], pages: 2 },
    ];
    const w = world({
      api: mini({
        pagination: { style: "page", page: "page", size: "per_page", pageSize: 1, pages: "/pages" },
      }),
      transport: (url) => json(pages[Number(url.searchParams.get("page")) - 1] ?? { data: [] }),
    });
    const got = await collectPublished(w.adapter);
    expect(got.docs.map((d) => d.id)).toEqual(["a", "b"]);
    expect(w.seen).toHaveLength(2);
  });

  it("a platform that gives fewer items per page than asked, with a total to reach, is could-not-check", async () => {
    const w = world({
      api: mini({
        total: "/total",
        pagination: { style: "page", page: "page", size: "per_page", pageSize: 5 },
      }),
      transport: () => json({ data: [{ id: "a", updated: "2026-01-01T00:00:00Z" }], total: 9 }),
    });
    expect(await couldNot(collectPublished(w.adapter))).toContain("fewer items per page");
  });
});

describe("paging: offset (a Directus-style list)", () => {
  it("advances the offset by what came back and asks only for the fields it needs", async () => {
    const w = world();
    const got = await collectPublished(w.adapter, {
      types: ["class"],
      fields: { class: ["name"] },
    });
    expect(got.docs.map((d) => d.id)).toEqual(["c-1", "c-2", "c-3"]);
    const asked = urls(w.seen);
    expect(asked.map((u) => u.searchParams.get("offset"))).toEqual(["0", "2"]);
    for (const u of asked) {
      expect(u.searchParams.get("limit")).toBe("2");
      expect(u.searchParams.get("fields")).toBe("id,slug,date_updated,date_created,name");
      expect(u.searchParams.get("filter[status][_eq]")).toBe("published");
    }
    // c-2 was never edited: its date_updated is null, so the first path with a value is date_created.
    expect(got.docs[1]?.updatedAt).toBe("2026-08-02T06:00:00.000Z");
  });

  it("with no fingerprint fields, only the fixed fields are asked for", async () => {
    const w = world();
    await collectPublished(w.adapter, { types: ["class"] });
    expect(urls(w.seen)[0]?.searchParams.get("fields")).toBe("id,slug,date_updated,date_created");
  });

  it("a short page ends the read when the platform gives no total", async () => {
    const rows = [
      { id: "a", updated: "2026-01-01T00:00:00Z" },
      { id: "b", updated: "2026-01-02T00:00:00Z" },
      { id: "c", updated: "2026-01-03T00:00:00Z" },
    ];
    const w = world({
      api: mini({ pagination: { style: "offset", limit: "limit", offset: "offset", pageSize: 2 } }),
      transport: (url) => {
        const offset = Number(url.searchParams.get("offset"));
        return json({ data: rows.slice(offset, offset + 2) });
      },
    });
    expect((await collectPublished(w.adapter)).docs.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(w.seen).toHaveLength(2);
  });

  it("an empty page ends the read even when the platform says there is more", async () => {
    const w = world({
      api: mini({
        pagination: {
          style: "offset",
          limit: "limit",
          offset: "offset",
          pageSize: 2,
          more: "/more",
        },
      }),
      transport: () => json({ data: [], more: true }),
    });
    expect((await collectPublished(w.adapter)).docs).toEqual([]);
    expect(w.seen).toHaveLength(1);
  });
});

describe("paging: cursor, and GraphQL over GET", () => {
  it("asks for the first page with no cursor and the next with the one the answer gave", async () => {
    const w = world();
    const got = await collectPublished(w.adapter, { types: ["workshop"] });
    expect(got.docs.map((d) => d.id)).toEqual(["w-1", "w-2", "w-3"]);
    const vars = urls(w.seen).map((u) => JSON.parse(u.searchParams.get("variables") ?? "{}"));
    expect(vars).toEqual([{ first: 2 }, { first: 2, after: "cur-w-2" }]);
  });

  it("is a GET with the document in the address, and never a mutation or a POST", async () => {
    const w = world();
    await w.adapter.types();
    await collectPublished(w.adapter);
    expect(w.seen.map((s) => s.method)).not.toContain("POST");
    expect(requestProblems(w.seen)).toEqual([]);
    const graphql = urls(w.seen).filter((u) => u.searchParams.has("query"));
    expect(graphql.length).toBeGreaterThan(0);
    for (const u of graphql) expect(u.searchParams.get("query")).toMatch(/^query Workshops/);
  });

  it("puts the fingerprint fields in the document, and nothing when none are named", async () => {
    const withFields = world();
    await collectPublished(withFields.adapter, {
      types: ["workshop"],
      fields: { workshop: ["title", "level"] },
    });
    expect(urls(withFields.seen)[0]?.searchParams.get("query")).toContain(
      "updatedAt title level }",
    );
    const without = world();
    await collectPublished(without.adapter, { types: ["workshop"] });
    const text = urls(without.seen)[0]?.searchParams.get("query") ?? "";
    expect(text).not.toContain("__FIELDS__");
    expect(text).not.toContain("title");
  });

  it("builds nested selections from dotted names", () => {
    expect(graphqlSelection(["title", "seo.title", "seo.image", "a.b.c"])).toBe(
      "title seo { title image } a { b { c } }",
    );
    expect(graphqlSelection([])).toBe("");
  });

  it("an endpoint that answers a GET with 405 is could-not-check, and no POST follows", async () => {
    const w = world({ transport: heronTransport({ key: KEY, graphqlPostOnly: true }) });
    const reason = await couldNot(collectPublished(w.adapter, { types: ["workshop"] }));
    expect(reason).toContain("only answers GraphQL queries over POST");
    expect(reason).toContain("open question 53");
    expect(w.seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("a GraphQL error answer is could-not-check, and its message (which can carry content) is not shown", async () => {
    const w = world({ transport: heronTransport({ key: KEY, graphqlErrors: true }) });
    const reason = await couldNot(collectPublished(w.adapter, { types: ["workshop"] }));
    expect(reason).toContain("with errors");
    expect(reason).not.toContain(HERON_MARKERS.workshopOne);
  });

  it("a cursor that repeats is a loop, not an endless read", async () => {
    const w = world({
      api: mini({
        items: "/data/rows",
        pagination: { style: "cursor", cursor: "cursor", pageSize: 1, next: "/data/next" },
      }),
      transport: (url) =>
        json({
          data: {
            rows: [
              {
                id: `r-${url.searchParams.get("cursor") ?? "first"}`,
                updated: "2026-01-01T00:00:00Z",
              },
            ],
            next: "same",
          },
        }),
    });
    expect(await couldNot(collectPublished(w.adapter))).toContain("the pages loop");
  });
});

describe("the bounds on a read", () => {
  it("a collection with more pages than maxPages is could-not-check, never cut short", async () => {
    const w = world({ api: { ...HERON_API, maxPages: 1 } });
    const reason = await couldNot(collectPublished(w.adapter, { types: ["post"] }));
    expect(reason).toContain("more than 1 pages");
    expect(reason).toContain("maxPages");
  });

  it("a platform that ignores the paging parameters is caught by the repeated items", async () => {
    const w = world({ transport: heronTransport({ key: KEY, ignorePaging: true }) });
    expect(await couldNot(collectPublished(w.adapter, { types: ["post"] }))).toContain(
      "gave the same items again",
    );
  });

  it("limit stops the read early, and since filters on the update time", async () => {
    const limited = world();
    expect(
      (await collectPublished(limited.adapter, { types: ["post"], limit: 3 })).docs,
    ).toHaveLength(3);
    expect(limited.seen).toHaveLength(2);
    const since = world();
    const got = await collectPublished(since.adapter, {
      types: ["post"],
      since: "2026-10-25T00:00:00Z",
    });
    expect(got.docs.map((d) => d.id)).toEqual(["p-1", "p-2", "p-3"]);
    await expect(collectPublished(world().adapter, { since: "yesterday" })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("since without an updatedAt path in the mapping is could-not-check", async () => {
    const w = world({
      api: mini({ fields: { id: "/id" } }),
      transport: () => json({ data: [{ id: "a" }] }),
    });
    expect(
      await couldNot(collectPublished(w.adapter, { since: "2026-01-01T00:00:00Z" })),
    ).toContain("no updatedAt path");
  });

  it("the page size and page count the mapping can ask for have ceilings", () => {
    expect(GENERIC_API_LIMITS.pageSize).toBe(200);
    expect(GENERIC_API_LIMITS.maxPages).toBe(200);
  });
});

describe("the key", () => {
  it("goes in the one header the mapping names, with its prefix, and nowhere else", async () => {
    const w = world();
    await w.adapter.types();
    await collectPublished(w.adapter);
    expect(w.seen.length).toBeGreaterThan(0);
    for (const s of w.seen) {
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(s.url).not.toContain(KEY);
    }
  });

  it("another header name is sent as given, lower-cased, and no Authorization header goes with it", async () => {
    const w = world({
      api: mini({}, { auth: { header: "X-Joomla-Token", env: "GAUGELINE_JOOMLA_TOKEN" } }),
      env: { GAUGELINE_JOOMLA_TOKEN: KEY },
      transport: heronTransportAt("x-joomla-token", KEY),
    });
    await collectPublished(w.adapter);
    expect(w.seen[0]?.headers["x-joomla-token"]).toBe(KEY);
    expect(w.seen[0]?.headers.authorization).toBeUndefined();
  });

  it("a mapping with no auth sends no key header and no cookie", async () => {
    const w = world({
      api: mini(),
      transport: () => json({ data: [{ id: "a", updated: "2026-01-01T00:00:00Z" }] }),
    });
    await collectPublished(w.adapter);
    const names = Object.keys(w.seen[0]?.headers ?? {}).map((h) => h.toLowerCase());
    expect(names).not.toContain("authorization");
    expect(names).not.toContain("cookie");
  });

  it("a platform that refuses it is could-not-check naming the variable, never the key", async () => {
    for (const status of [401, 403] as const) {
      const w = world({ transport: () => json({ error: KEY }, status) });
      const reason = await couldNot(w.adapter.types());
      expect(reason).toContain("GAUGELINE_HERON_TOKEN");
      expect(reason).toContain(String(status));
      expect(reason).not.toContain(KEY);
    }
  });

  it("an anonymous mapping that is refused says to add auth", async () => {
    const w = world({ api: mini(), transport: () => json({}, 401) });
    expect(await couldNot(collectPublished(w.adapter))).toContain('add "auth"');
  });

  it("an unset variable, or one that cannot be a header value, asks for nothing", async () => {
    const unset = world({ env: {} });
    expect(await couldNot(unset.adapter.types())).toContain("GAUGELINE_HERON_TOKEN is not set");
    const bad = world({ env: { GAUGELINE_HERON_TOKEN: `abc\r\nX-Evil: 1` } });
    expect(await couldNot(bad.adapter.types())).toContain("cannot be sent as a header value");
    const reasonText = await couldNot(
      world({ env: { GAUGELINE_HERON_TOKEN: `caf${String.fromCharCode(233)}` } }).adapter.types(),
    );
    expect(reasonText).toContain("cannot be sent as a header value");
    expect(unset.seen).toEqual([]);
    expect(bad.seen).toEqual([]);
  });

  it("is dropped when the platform redirects to another origin, and when it redirects to plain http", async () => {
    for (const location of [
      "https://elsewhere.example/api/posts",
      "http://cms.heron-yoga.example/api/posts",
    ]) {
      const w = world({
        transport: (url) =>
          url.href.startsWith(`${HERON}/api/posts`)
            ? Promise.resolve({
                status: 302,
                headers: { location },
                body: Readable.from([Buffer.from("")]),
              })
            : json({ docs: [], totalDocs: 0, hasNextPage: false }),
      });
      await collectPublished(w.adapter, { types: ["post"] });
      expect(w.seen).toHaveLength(2);
      expect(w.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(w.seen[1]?.url.startsWith(location)).toBe(true);
      expect(JSON.stringify(w.seen[1]?.headers)).not.toContain(KEY);
      expect(w.seen[1]?.headers.authorization).toBeUndefined();
    }
  });

  it("is blanked from a failure the network layer words, whatever spelling it takes", async () => {
    const w = world({
      transport: () => Promise.reject(new Error(`connect failed for Bearer ${KEY} (${KEY})`)),
    });
    const reason = await couldNot(w.adapter.types());
    expect(reason).not.toContain(KEY);
  });
});

describe("a mapping that is blocked", () => {
  const blocked = (): ReturnType<typeof world> =>
    world({ api: { ...HERON_API, blocked: "key-in-address" } });

  it("asks for nothing, whichever method is called, and says why", async () => {
    const w = blocked();
    const reasons = [
      await couldNot(w.adapter.types()),
      await couldNot(w.adapter.fieldCounts("post", ["title"])),
      await couldNot(collectPublished(w.adapter)),
      await couldNot(w.adapter.draftsReachable()),
    ];
    for (const r of reasons) {
      expect(r).toContain(BLOCKED_REASONS["key-in-address"]);
      expect(r).toContain("open question 53");
    }
    expect(w.seen).toEqual([]);
  });
});

describe("what the platform answers", () => {
  it("a list that is not where the mapping says is could-not-check, naming the path", async () => {
    const w = world({ transport: heronTransport({ key: KEY, postsAt: "results" }) });
    const reason = await couldNot(collectPublished(w.adapter, { types: ["post"] }));
    expect(reason).toContain("no list of items at /docs");
    expect(reason).toContain('"items"');
  });

  it("an item with no id, or with an update time that is not a time, is could-not-check", async () => {
    for (const row of [
      { updated: "2026-01-01T00:00:00Z" },
      { id: "a", updated: "not a time" },
      { id: "a" },
    ]) {
      const w = world({ api: mini(), transport: () => json({ data: [row] }) });
      expect(await couldNot(collectPublished(w.adapter))).toContain("no id or no update time");
    }
  });

  it("an answer that is not JSON, or an item that is not an object, is could-not-check", async () => {
    const html = world({ api: mini(), transport: () => json("<html>maintenance</html>") });
    expect(await couldNot(collectPublished(html.adapter))).toContain("not JSON");
    const odd = world({ api: mini(), transport: () => json({ data: ["a"] }) });
    expect(await couldNot(collectPublished(odd.adapter))).toContain("is not an object");
  });

  it("a 404 names the check to make, and a 5xx names only the status", async () => {
    const missing = world({ transport: () => json({}, 404) });
    expect(await couldNot(missing.adapter.types())).toContain("check the endpoint");
    const down = world({ transport: () => json("<b>stack trace</b>", 503) });
    const reason = await couldNot(down.adapter.types());
    expect(reason).toContain("HTTP 503");
    expect(reason).not.toContain("stack trace");
  });

  it("times in the three shapes platforms use all become ISO 8601 UTC", async () => {
    const rows = [
      { id: "a", updated: "2026-11-02 10:00:00" },
      { id: "b", updated: 1790935200000 },
      { id: "c", updated: 1790935200 },
      { id: "d", updated: "2026-11-02T10:00:00+01:00" },
    ];
    const w = world({ api: mini(), transport: () => json({ data: rows }) });
    const got = await collectPublished(w.adapter);
    expect(got.docs.map((d) => d.updatedAt)).toEqual([
      "2026-11-02T10:00:00.000Z",
      "2026-10-02T10:00:00.000Z",
      "2026-10-02T10:00:00.000Z",
      "2026-11-02T09:00:00.000Z",
    ]);
  });

  it("an address the platform gives is kept as a path, and a path without its slash gets one", async () => {
    const rows = [
      { id: "a", updated: "2026-01-01T00:00:00Z", link: "https://client.example/news/a/?x=1" },
      { id: "b", updated: "2026-01-01T00:00:00Z", link: "news/b" },
      { id: "c", updated: "2026-01-01T00:00:00Z", link: "not a path" },
    ];
    const w = world({
      api: mini({ fields: { id: "/id", updatedAt: "/updated", url: "/link" } }),
      transport: () => json({ data: rows }),
    });
    const got = await collectPublished(w.adapter);
    expect(got.docs.map((d) => d.url)).toEqual(["/news/a/?x=1", "/news/b", undefined]);
  });

  it("numbers are ids too, and an empty or null id is no id", async () => {
    const w = world({
      api: mini(),
      transport: () => json({ data: [{ id: 7, updated: "2026-01-01T00:00:00Z" }] }),
    });
    expect((await collectPublished(w.adapter)).docs[0]?.id).toBe("7");
  });

  it("an answer that is the list itself is read from the root", async () => {
    const w = world({
      api: mini({ items: "" }),
      transport: () => json([{ id: "a", updated: "2026-01-01T00:00:00Z" }]),
    });
    expect((await collectPublished(w.adapter)).docs.map((d) => d.id)).toEqual(["a"]);
  });

  it("a key the answer names as a prototype key reads as nothing", async () => {
    const w = world({
      api: mini(),
      transport: () =>
        json(
          '{"data":[{"id":"a","updated":"2026-01-01T00:00:00Z","__proto__":{"id":"evil"},"constructor":{"x":1}}]}',
        ),
    });
    const got = await collectPublished(w.adapter, { fields: { item: ["title"] } }).catch(
      () => undefined,
    );
    expect(got?.docs[0]?.id).toBe("a");
    expect(({} as Record<string, unknown>).id).toBeUndefined();
  });
});

describe("a collection that holds several types (Prismic-style), and values asked for first", () => {
  const rows = [
    {
      id: "1",
      type: "post",
      uid: "a",
      last: "2026-01-03T00:00:00Z",
      data: { title: "A", blurb: "x" },
    },
    { id: "2", type: "page", uid: "b", last: "2026-01-02T00:00:00Z", data: { title: "B" } },
    { id: "3", type: "post", uid: "c", last: "2026-01-01T00:00:00Z", data: { title: "C" } },
  ];
  const api = mini(
    {
      path: "/documents",
      items: "/results",
      fieldRoot: "/data",
      fields: { id: "/id", type: "/type", slug: "/uid", updatedAt: "/last" },
    },
    {
      bootstrap: [
        {
          param: "ref",
          path: "",
          value: "/refs/0/ref",
          expect: { path: "/refs/0/isMasterRef", equals: true },
        },
      ],
    },
  );
  const transport: Transport = (url) =>
    url.pathname === "/api"
      ? json({ refs: [{ ref: "master-ref-1", isMasterRef: true }] })
      : json({ results: rows });

  it("types come from the items, and published() keeps only the types asked for", async () => {
    const w = world({ api, transport });
    expect(await w.adapter.types()).toEqual([
      { name: "page", count: 1 },
      { name: "post", count: 2 },
    ]);
    const got = await collectPublished(w.adapter, { types: ["post"], fields: { post: ["title"] } });
    expect(got.docs.map((d) => [d.id, d.type, d.slug])).toEqual([
      ["1", "post", "a"],
      ["3", "post", "c"],
    ]);
    expect(Object.keys(got.docs[0]?.fieldHashes ?? {})).toEqual(["title"]);
  });

  it("counts a field for the items of one type", async () => {
    const w = world({ api, transport });
    expect(await w.adapter.fieldCounts("post", ["title", "blurb"])).toEqual({ title: 2, blurb: 1 });
  });

  it("reads a value the platform hands out once, and puts it on every request after", async () => {
    const w = world({ api, transport });
    await w.adapter.types();
    await collectPublished(w.adapter);
    const asked = urls(w.seen);
    expect(asked[0]?.pathname).toBe("/api");
    for (const u of asked.slice(1)) expect(u.searchParams.get("ref")).toBe("master-ref-1");
    // Read once for the whole run, not once per request.
    expect(asked.filter((u) => u.pathname === "/api")).toHaveLength(1);
  });

  it("a ref that fails its check is could-not-check, and nothing else is asked", async () => {
    const w = world({
      api,
      transport: (url) =>
        url.pathname === "/api"
          ? json({ refs: [{ ref: "r", isMasterRef: false }] })
          : json({ results: rows }),
    });
    expect(await couldNot(w.adapter.types())).toContain("does not have true");
    expect(w.seen).toHaveLength(1);
  });

  it("an item with no type is could-not-check", async () => {
    const w = world({
      api,
      transport: (url) =>
        url.pathname === "/api"
          ? json({ refs: [{ ref: "r", isMasterRef: true }] })
          : json({ results: [{ id: "9" }] }),
    });
    expect(await couldNot(w.adapter.types())).toContain("no content type");
  });
});

describe("drafts and rate limits", () => {
  it("without a drafts listing in the mapping, drafts are not asked for and the answer is not-applicable", async () => {
    const w = world({ api: { ...HERON_API, drafts: undefined } });
    expect(await w.adapter.draftsReachable()).toBe("not-applicable");
    expect(w.seen).toEqual([]);
  });

  it("with one, a listing that returns items says drafts are reachable, and none says they are not", async () => {
    expect(await world().adapter.draftsReachable()).toBe(true);
    const none = world({ transport: () => json({ data: [], meta: { filter_count: 0 } }) });
    expect(await none.adapter.draftsReachable()).toBe(false);
  });

  it("a rate limit during published() carries how many items were read", async () => {
    let n = 0;
    const inner = heronTransport({ key: KEY });
    const w = world({
      transport: (url, req) =>
        ++n > 1
          ? Promise.resolve({
              status: 429,
              headers: { "retry-after": "120" },
              body: Readable.from([Buffer.from("{}")]),
            })
          : inner(url, req),
    });
    const err: unknown = await collectPublished(w.adapter, { types: ["post"] }).then(
      (r) => r.partial,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ reason: "rate-limited", retry: "in 120 seconds", delivered: 2 });
    expect(new AdapterRateLimitedError(2).partial).toBe(2);
  });
});

describe("the adapter in the registry", () => {
  it("is built, and an entry with no mapping cannot be created", () => {
    const built = resolveAdapters({ adapters: [{ id: "generic-api", api: HERON_API }] });
    expect(built.map((b) => b.id)).toEqual(["generic-api"]);
    const fetcher = createFetcher({ transport: heronTransport(), timeoutMs: 1000 });
    expect(() => built[0]?.create({ env: ENV, fetcher }, { id: "generic-api" })).toThrow(
      /valid "api" mapping/,
    );
  });
});

/** A server that wants the key in a header of this name, for the custom-header test. */
function heronTransportAt(header: string, key: string): Transport {
  return (url, req) =>
    req.headers[header] === key
      ? json({ data: [{ id: "a", updated: "2026-01-01T00:00:00Z" }] })
      : json({}, 401);
}

describe("mapping validation (a recipe with a wrong path fails before anything is asked)", () => {
  const parse = (api: unknown, extra: Record<string, unknown> = {}) =>
    adaptersConfigSchema.safeParse({ adapters: [{ id: "generic-api", api, ...extra }] });
  const messages = (api: unknown, extra?: Record<string, unknown>): string => {
    const r = parse(api, extra);
    return r.success
      ? ""
      : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
  };
  const collection = (over: Record<string, unknown>) => ({
    collections: { item: { ...mini().collections.item, ...over } },
    endpoint: "https://cms.example/api",
  });

  it("a mapping that is right is accepted", () => {
    expect(parse(mini()).success).toBe(true);
    expect(parse(HERON_API, { urls: HERON_URLS }).success).toBe(true);
  });

  it("a path that is not a plain pointer is refused, with where it is", () => {
    for (const bad of [
      "data/items",
      "/data//items",
      "/data/../x",
      "/__proto__/x",
      "/a/constructor",
      "/data/prototype",
      "/a b",
      `/${"x".repeat(80)}`,
      "/a/b/c/d/e/f/g/h/i",
    ])
      expect(messages(collection({ items: bad })), bad).toContain("collections.item.items");
    expect(messages(collection({ fields: { id: "/id/__proto__" } }))).toContain(
      "collections.item.fields.id",
    );
    expect(messages(collection({ fields: { id: ["/id", "bad"] } }))).toContain(
      "collections.item.fields.id",
    );
  });

  it("a collection path that climbs, carries a query or has no slash is refused", () => {
    for (const bad of ["items", "/items/../admin", "/items?x=1", "//items", "/items/./x"])
      expect(messages(collection({ path: bad })), bad).toContain("collections.item.path");
  });

  it("an endpoint must be https, with no credentials, query or fragment", () => {
    for (const bad of [
      "http://cms.example/api",
      "ftp://cms.example",
      "https://user:pw\u0040cms.example/api",
      "https://cms.example/api?token=1",
      "https://cms.example/api#x",
      "cms.example/api",
    ])
      expect(messages({ ...mini(), endpoint: bad }), bad).toContain("endpoint");
  });

  it("plain http is accepted for 127.0.0.1 with no key, and refused with one", () => {
    expect(parse({ ...mini(), endpoint: "http://127.0.0.1:4010/api" }).success).toBe(true);
    const keyed = messages({
      ...mini(),
      endpoint: "http://127.0.0.1:4010/api",
      auth: { header: "Authorization", env: "GAUGELINE_X_TOKEN" },
    });
    expect(keyed).toContain("plain http");
  });

  it("a key can only be named by a GAUGELINE_ variable, in a header that carries a key", () => {
    for (const env of [
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "gauge_token",
      "GAUGELINE_",
      "GAUGELINE_lower",
    ])
      expect(messages({ ...mini(), auth: { header: "Authorization", env } }), env).toContain(
        "auth.env",
      );
    for (const header of ["Host", "Cookie", "Content-Length", "bad header", "x\r\ny"])
      expect(messages({ ...mini(), auth: { header, env: "GAUGELINE_X_TOKEN" } }), header).toContain(
        "auth.header",
      );
  });

  it("a key cannot be written into the mapping as a parameter", () => {
    for (const name of [
      "token",
      "api_key",
      "apiKey",
      "access_token",
      "key",
      "secret",
      "Authorization",
      "signature",
    ])
      expect(messages(collection({ query: { [name]: "abc" } })), name).toContain(
        "looks like a key",
      );
    expect(
      parse(collection({ query: { depth: "0", "filter[status][_eq]": "published" } })).success,
    ).toBe(true);
  });

  it("page size, page count and collection count have ceilings", () => {
    const paged = (pageSize: number) =>
      collection({ pagination: { style: "offset", limit: "l", offset: "o", pageSize } });
    expect(parse(paged(GENERIC_API_LIMITS.pageSize)).success).toBe(true);
    for (const size of [0, -1, 201, 1.5])
      expect(messages(paged(size)), String(size)).toContain("pageSize");
    expect(messages({ ...mini(), maxPages: 201 })).toContain("maxPages");
    expect(messages({ ...mini(), maxPages: 0 })).toContain("maxPages");
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, n) => [`c${n}`, mini().collections.item]),
    );
    expect(messages({ endpoint: "https://cms.example", collections: many })).toContain(
      "collections",
    );
    expect(messages({ endpoint: "https://cms.example", collections: {} })).toContain("collections");
  });

  it("GraphQL: only a query, parsed, with its variables used and its fields marker at most once", () => {
    const gql = (graphql: string, pagination?: unknown) => {
      return collection({
        path: undefined,
        graphql,
        pagination: pagination ?? { style: "offset", limit: "first", offset: "skip", pageSize: 10 },
      });
    };
    const ok =
      "query($first: Int!, $skip: Int!) { posts(first: $first, skip: $skip) { id updated __FIELDS__ } }";
    expect(parse(gql(ok)).success).toBe(true);
    expect(
      messages(
        gql(
          "mutation($first: Int!, $skip: Int!) { deletePost(first: $first, skip: $skip) { id } }",
        ),
      ),
    ).toContain("a mutation is never sent");
    expect(messages(gql("subscription($first: Int!, $skip: Int!) { posts { id } }"))).toContain(
      "a subscription is never sent",
    );
    expect(messages(gql("query($first: Int!) { posts { id } }"))).toContain(
      "does not use the variable $skip",
    );
    expect(messages(gql("query { posts { id "))).toContain("GraphQL that parses");
    expect(messages(gql(`${ok.replace("updated", "__FIELDS__")}`))).toContain("at most once");
    expect(
      messages(gql(ok, { style: "offset", limit: "page[limit]", offset: "skip", pageSize: 10 })),
    ).toContain("not a GraphQL variable name");
    expect(messages(gql("query { a { id } } query { b { id } }"))).toContain("exactly one query");
  });

  it("a collection is REST or GraphQL, not both and not neither", () => {
    expect(messages(collection({ path: undefined }))).toContain('"path" (REST) or "graphql"');
    expect(messages(collection({ graphql: "query { a { id } }" }))).toContain(
      '"path" (REST) or "graphql"',
    );
  });

  it("settings that name a type the mapping does not have are refused, and unknown keys too", () => {
    expect(messages(mini(), { fingerprint: { post: ["title"] } })).toContain("fingerprint.post");
    expect(messages(mini(), { urls: { post: "/blog/{slug}" } })).toContain("urls.post");
    expect(messages(mini(), { fingerprint: { item: ["__proto__.x"] } })).toContain("prototype");
    expect(messages({ ...mini(), password: "x" })).not.toBe("");
    expect(messages({ ...mini(), drafts: { collection: "nope", query: { a: "b" } } })).toContain(
      "drafts.collection",
    );
  });

  it("the mapping belongs to generic-api, and generic-api needs one", () => {
    expect(
      adaptersConfigSchema.safeParse({ adapters: [{ id: "sanity", api: mini() }] }).success,
    ).toBe(false);
    const missing = adaptersConfigSchema.safeParse({ adapters: [{ id: "generic-api" }] });
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.issues)).toContain('needs an \\"api\\" mapping');
  });
});
