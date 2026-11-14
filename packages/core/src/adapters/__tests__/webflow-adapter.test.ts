import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { hashValue } from "../fingerprint.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapters, resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import {
  WEBFLOW_LIMITS,
  WEBFLOW_PAGE_SIZE,
  WEBFLOW_STAGED_TOLERANCE_MS,
  createWebflowAdapter,
  type WebflowAdapterOptions,
} from "../webflow.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  COLLECTION_IDS,
  SALTMARSH,
  SITE_ID,
  WEBFLOW_MARKERS,
  webflowTransport,
  type FixtureCollection,
  type WebflowFixtureOptions,
} from "./webflow-fixture.js";

const KEY = testKey("webflow-unit");
const ENV = { WEBFLOW_TOKEN: KEY, WEBFLOW_SITE_ID: SITE_ID };

function over(
  options: {
    content?: readonly FixtureCollection[];
    fixture?: WebflowFixtureOptions;
    adapter?: Partial<WebflowAdapterOptions>;
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(
      options.transport ??
        webflowTransport(options.content ?? SALTMARSH, { token: KEY, ...options.fixture }),
      seen,
    ),
    timeoutMs: 5000,
  });
  const adapter = createWebflowAdapter({
    env: ENV,
    fetcher,
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

describe("Webflow on ContentAdapter: what it says about itself", () => {
  it("asks for a token with read scopes only, and says where to read how", () => {
    const { adapter } = over();
    expect(adapter.id).toBe("webflow");
    expect(adapter.describe()).toEqual({
      name: "Webflow",
      docsUrl: "https://gaugeline.dev/docs/integrations/webflow",
      keyKind: "read-only",
    });
    expect(adapterHeader(adapter.describe())).toBe(
      "Content system: Webflow, with a read-only key. Endpoints and how to make the key: https://gaugeline.dev/docs/integrations/webflow",
    );
  });

  it("is built, not planned, and a settings file can name it", async () => {
    expect(BUILT_ADAPTERS.has("webflow")).toBe(true);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "webflow")).toBe(false);
    const config = adaptersConfigSchema.parse({
      adapters: [
        {
          id: "webflow",
          fingerprint: { events: ["name", "post-body"] },
          urls: { events: "/events/{slug}" },
        },
      ],
    });
    expect(resolveAdapters(config).map((b) => b.id)).toEqual(["webflow"]);
    const { fetcher } = { fetcher: createFetcher({ transport: webflowTransport() }) };
    expect((await createAdapters(config, { env: ENV, fetcher })).map((a) => a.id)).toEqual([
      "webflow",
    ]);
  });

  it("Webflow field names may have hyphens; no other adapter takes one, and the Webflow-only settings stay refused", () => {
    expect(() =>
      adaptersConfigSchema.parse({
        adapters: [{ id: "sanity", fingerprint: { post: ["post-body"] } }],
      }),
    ).toThrow(/Webflow/);
    expect(() =>
      adaptersConfigSchema.parse({
        adapters: [{ id: "webflow", site: "https://saltmarsh-supper.example" }],
      }),
    ).toThrow(/sitemap-feed/);
    expect(() =>
      adaptersConfigSchema.parse({
        adapters: [{ id: "webflow", fingerprint: { events: ["Post Body"] } }],
      }),
    ).toThrow();
  });
});

describe("Webflow: the key and the site", () => {
  it("no token is could-not-check and no request is made", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(webflowTransport(), seen),
      timeoutMs: 5000,
    });
    const adapter = createWebflowAdapter({ env: { WEBFLOW_SITE_ID: SITE_ID }, fetcher });
    expect(await reasonOf(adapter.types())).toMatch(/WEBFLOW_TOKEN/);
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/WEBFLOW_TOKEN/);
    expect(seen).toEqual([]);
  });

  it("with no site id, the site is the one the token can see", async () => {
    const { adapter, seen } = over({ adapter: { env: { WEBFLOW_TOKEN: KEY } } });
    expect((await adapter.types()).map((t) => t.name)).toEqual([
      "events",
      "menu-items",
      "testimonials",
    ]);
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v2/sites");
  });

  it("a token that sees more than one site must be told which: could-not-check, never a guess", async () => {
    const two: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from(JSON.stringify({ sites: [{ id: "a1" }, { id: "b2" }] }))]),
      }) as ReturnType<Transport>;
    const { adapter, seen } = over({
      transport: two,
      adapter: { env: { WEBFLOW_TOKEN: KEY } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/WEBFLOW_SITE_ID/);
    expect(seen).toHaveLength(1);
  });

  it("a site id that is not a Webflow id is refused before anything is asked", async () => {
    const { adapter, seen } = over({
      adapter: { env: { WEBFLOW_TOKEN: KEY, WEBFLOW_SITE_ID: "../../v2/sites" } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/WEBFLOW_SITE_ID/);
    expect(seen).toEqual([]);
  });

  it("a site the token cannot see is could-not-check", async () => {
    const { adapter } = over({
      adapter: { env: { WEBFLOW_TOKEN: KEY, WEBFLOW_SITE_ID: "ffffffffffffffffffffffff" } },
    });
    expect(await reasonOf(adapter.types())).toMatch(/404/);
  });

  it("a token with cms:read and no sites:read cannot find the site, and says which scope is missing; with the site id it reads", async () => {
    const fixture = { scopes: ["cms:read"] as const };
    const lost = over({ fixture, adapter: { env: { WEBFLOW_TOKEN: KEY } } });
    expect(await reasonOf(lost.adapter.types())).toMatch(/sites:read/);
    const named = over({ fixture });
    expect((await named.adapter.types()).length).toBe(3);
  });

  it("a token with sites:read and no cms:read cannot read the content, and says which scope is missing", async () => {
    const { adapter } = over({ fixture: { scopes: ["sites:read"] } });
    expect(await reasonOf(adapter.types())).toMatch(/cms:read/);
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/cms:read/);
    expect(await reasonOf(collectPublished(adapter))).toMatch(/cms:read/);
  });

  it("a token the platform does not know is could-not-check and its text never comes back", async () => {
    const { adapter } = over({ fixture: { token: testKey("someone-else") } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/401/);
    expect(reason).not.toContain(KEY);
  });

  it("a failure that quotes the token is blanked", async () => {
    const real = createFetcher({ transport: webflowTransport() });
    const fetcher = { ...real, get: () => Promise.reject(new Error(`connection reset by ${KEY}`)) };
    const adapter = createWebflowAdapter({ env: ENV, fetcher });
    const reason = await reasonOf(adapter.types());
    expect(reason).not.toContain(KEY);
    expect(reason).toContain("[redacted]");
  });
});

describe("Webflow: reading collections and items", () => {
  it("types() counts what is live, one tiny request per collection, and lists a collection with none", async () => {
    const empty: FixtureCollection[] = [
      ...SALTMARSH,
      {
        id: "6561a0c2e5b3d7a9c8e4c009",
        displayName: "Press",
        singularName: "Press",
        slug: "press",
        items: [],
      },
    ];
    const { adapter, seen } = over({ content: empty });
    expect(await adapter.types()).toEqual([
      { name: "events", count: 2 },
      { name: "menu-items", count: 2 },
      { name: "press", count: 0 },
      { name: "testimonials", count: 2 },
    ]);
    const counts = seen.filter((s) => s.url.includes("/items/live"));
    expect(counts).toHaveLength(4);
    for (const s of counts) expect(new URL(s.url).searchParams.get("limit")).toBe("1");
  });

  it("never asks for more than the API's own page size, and reads every page", async () => {
    expect(WEBFLOW_PAGE_SIZE).toBe(100);
    const { adapter, seen } = over({ adapter: { pageSize: 1 } });
    const got = await collectPublished(adapter, { types: ["events"] });
    expect(got.docs.map((d) => d.id)).toEqual(["e-harvest", "e-oyster"]);
    const pages = seen.filter(
      (s) => s.url.includes("/collections/") && s.url.includes("/items/live"),
    );
    expect(pages.map((s) => new URL(s.url).searchParams.get("offset"))).toEqual(["0", "1"]);
    const big = over({ adapter: { pageSize: 5000 } });
    await collectPublished(big.adapter, { types: ["events"] });
    for (const s of big.seen)
      if (s.url.includes("limit"))
        expect(Number(new URL(s.url).searchParams.get("limit"))).toBeLessThanOrEqual(100);
  });

  it("fieldCounts counts non-empty values among the published items only", async () => {
    const withEmpty = SALTMARSH.map((c) =>
      c.slug === "events"
        ? {
            ...c,
            items: c.items.map((i) =>
              i.id === "e-oyster" ? { ...i, fieldData: { ...i.fieldData, summary: "" } } : i,
            ),
          }
        : c,
    );
    const { adapter } = over({ content: withEmpty });
    // The staged event and the draft have a name too; they are not published, so they are not counted.
    expect(await adapter.fieldCounts("events", ["name", "summary", "seats", "slug"])).toEqual({
      name: 2,
      summary: 1,
      seats: 2,
      slug: 2,
    });
  });

  it("a collection that is not on the site counts 0 for every field", async () => {
    const { adapter } = over();
    expect(await adapter.fieldCounts("nothing-here", ["a"])).toEqual({ a: 0 });
  });

  it("published() gives fingerprints: slug, last published, last updated, and the address the settings give", async () => {
    const { adapter } = over({
      adapter: { settings: { id: "webflow", urls: { events: "/events/{slug}" } } },
    });
    const docs = (await collectPublished(adapter, { types: ["events", "testimonials"] })).docs;
    expect(docs[0]).toEqual({
      id: "e-harvest",
      type: "events",
      url: "/events/harvest-table",
      slug: "harvest-table",
      publishedAt: "2026-10-28T09:00:00.000Z",
      updatedAt: "2026-10-28T08:55:00.000Z",
      fieldHashes: {},
    });
    // A collection with no address pattern gets no address, never a guessed one.
    const quote = docs.find((d) => d.id === "t-1");
    expect(quote?.url).toBeUndefined();
    expect(quote?.slug).toBe("a-regular");
  });

  it("published() leaves out drafts, archived items and an item that was never published", async () => {
    const { adapter } = over();
    const ids = (await collectPublished(adapter)).docs.map((d) => d.id);
    expect(ids).toEqual(["e-harvest", "e-oyster", "m-trout", "m-leek", "t-1", "t-2"]);
  });

  it("published() with `since` keeps what changed at or after it, and a limit stops the read", async () => {
    const { adapter } = over();
    const since = await collectPublished(adapter, { since: "2026-11-01T00:00:00Z" });
    expect(since.docs.map((d) => d.id)).toEqual(["e-oyster", "m-trout"]);
    await expect(collectPublished(adapter, { since: "last week" })).rejects.toThrow(TypeError);
    const limited = await collectPublished(adapter, { limit: 3 });
    expect(limited.docs).toHaveLength(3);
  });

  it("the settings name the fields to hash, and only those are hashed; the values stay out", async () => {
    const { adapter } = over({
      adapter: { settings: { id: "webflow", fingerprint: { events: ["name", "summary"] } } },
    });
    const docs = (await collectPublished(adapter, { types: ["events"] })).docs;
    expect(docs[0]?.fieldHashes).toEqual({
      name: hashValue(WEBFLOW_MARKERS.harvest),
      summary: hashValue(WEBFLOW_MARKERS.harvestSummary),
    });
    // The oyster night has no summary: left out, never hashed as empty.
    expect(docs[1]?.fieldHashes).toEqual({ name: hashValue(WEBFLOW_MARKERS.oyster) });
    const text = JSON.stringify(docs);
    for (const marker of Object.values(WEBFLOW_MARKERS)) expect(text).not.toContain(marker);
  });

  it("an answer that is not what the API sends is could-not-check, never a shorter list", async () => {
    const answer =
      (body: unknown): Transport =>
      (url) =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([
            Buffer.from(
              JSON.stringify(
                url.pathname.endsWith("/collections")
                  ? { collections: [{ id: COLLECTION_IDS.events, slug: "events" }] }
                  : body,
              ),
            ),
          ]),
        }) as ReturnType<Transport>;
    for (const body of [
      { items: "nope", pagination: { total: 1 } },
      { items: [{ isDraft: false }], pagination: { total: 1 } },
      { items: [], pagination: { total: "many" } },
      "[]",
    ]) {
      const { adapter } = over({ transport: answer(body) });
      await reasonOf(collectPublished(adapter, { types: ["events"] }));
    }
    for (const body of [{ items: [], pagination: { total: "many" } }, "[]"])
      await reasonOf(over({ transport: answer(body) }).adapter.types());
  });

  it("a collection bigger than the cap is could-not-check for field counts, not a count of part of it", async () => {
    expect(WEBFLOW_LIMITS.itemsPerCollection).toBe(10_000);
    const { adapter } = over({ adapter: { maxItemsPerCollection: 1 } });
    expect(await reasonOf(adapter.fieldCounts("events", ["name"]))).toMatch(/more than 1 item/);
  });

  it("a collection the token may not read is could-not-check for that collection, and the others still read", async () => {
    const { adapter } = over({ fixture: { denied: [COLLECTION_IDS.menu] } });
    expect(await reasonOf(adapter.fieldCounts("menu-items", ["name"]))).toMatch(/403/);
    expect(await adapter.fieldCounts("events", ["name"])).toEqual({ name: 2 });
    const events = await collectPublished(adapter, { types: ["events"] });
    expect(events.docs).toHaveLength(2);
    await reasonOf(collectPublished(adapter, { types: ["menu-items"] }));
  });

  it("draftsReachable is false when every item is live, and true when the staged list holds one that is not", async () => {
    const live = SALTMARSH.map((c) => ({
      ...c,
      items: c.items.filter((i) => !i.isDraft && !i.isArchived && i.lastPublished !== null),
    }));
    expect(await over({ content: live }).adapter.draftsReachable()).toBe(false);
    expect(await over().adapter.draftsReachable()).toBe(true);
  });

  it("a rate limit carries what was read", async () => {
    const limited: Transport = (url, req) =>
      url.pathname.endsWith("/items/live")
        ? (Promise.resolve({
            status: 429,
            headers: { "retry-after": "3600" },
            body: Readable.from([Buffer.from("{}")]),
          }) as ReturnType<Transport>)
        : webflowTransport(SALTMARSH, { token: KEY })(url, req);
    const { adapter } = over({ transport: limited });
    const err: unknown = await adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
    expect((err as AdapterRateLimitedError).retry).toBe("in 3600 seconds");
  });
});

/** A collection of `count` published items whose body is `bytes` long, for answers that are too big. */
function blog(count: number, bytes: number): FixtureCollection[] {
  return [
    {
      id: COLLECTION_IDS.events,
      displayName: "Blog",
      singularName: "Post",
      slug: "blog",
      items: Array.from({ length: count }, (_v, n) => ({
        id: `p-${String(n).padStart(3, "0")}`,
        isDraft: false,
        isArchived: false,
        lastPublished: "2026-10-01T09:00:00.000Z",
        lastUpdated: "2026-10-01T08:00:00.000Z",
        createdOn: "2026-05-01T10:00:00.000Z",
        fieldData: { name: `Post ${n}`, slug: `post-${n}`, body: "x".repeat(bytes) },
      })),
    },
  ];
}

/** The platform answers with at most `cap` items a page, whatever the limit asked for. */
const capped =
  (inner: Transport, cap: number): Transport =>
  (url, req) => {
    const next = new URL(url.href);
    if (next.searchParams.has("limit"))
      next.searchParams.set("limit", String(Math.min(Number(next.searchParams.get("limit")), cap)));
    return inner(next, req);
  };

describe("Webflow: answers that are too big or too short", () => {
  it("a page of 100 long posts is over the 5 MB an answer may be: the page is asked again with fewer items, and every item is read", async () => {
    const { adapter, seen } = over({ content: blog(100, 60_000) });
    const got = await collectPublished(adapter, { types: ["blog"] });
    expect(got.docs).toHaveLength(100);
    const limits = seen
      .filter((x) => x.url.includes("/items/live"))
      .map((x) => new URL(x.url).searchParams.get("limit"));
    expect(limits[0]).toBe("100");
    expect(limits).toContain("50");
    expect(await adapter.fieldCounts("blog", ["body"])).toEqual({ body: 100 });
  });

  it("items too long to read even ten at a time are could-not-check, and the reason says what was tried", async () => {
    const { adapter } = over({ content: blog(12, 1_000_000) });
    const reason = await reasonOf(collectPublished(adapter, { types: ["blog"] }));
    expect(reason).toMatch(/5 MB/);
    expect(reason).toMatch(/10 items/);
  });

  it("a short page in the middle of a list is not the end of it: the read goes on until every item is read", async () => {
    const { adapter } = over({
      transport: capped(webflowTransport(blog(7, 10), { token: KEY }), 3),
    });
    const got = await collectPublished(adapter, { types: ["blog"] });
    expect(got.docs).toHaveLength(7);
    const staged: string[] = [];
    for await (const x of adapter.staged()) staged.push(x.id);
    expect(staged).toHaveLength(7);
    expect(await adapter.fieldCounts("blog", ["name"])).toEqual({ name: 7 });
  });

  it("a page that stops short and gives nothing more is could-not-check, never a shorter list", async () => {
    const stalled: Transport = (url, req) => {
      const inner = webflowTransport(blog(7, 10), { token: KEY });
      if (url.searchParams.get("offset") === "3") {
        return Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([
            Buffer.from(
              JSON.stringify({ items: [], pagination: { limit: 3, offset: 3, total: 7 } }),
            ),
          ]),
        }) as ReturnType<Transport>;
      }
      return capped(inner, 3)(url, req);
    };
    const { adapter } = over({ transport: stalled });
    expect(await reasonOf(collectPublished(adapter, { types: ["blog"] }))).toMatch(/3 of 7/);
  });
});

describe("Webflow: what counts as having a field, and when an edit counts as a change", () => {
  it("an empty string, an empty list and an empty object count as no value", async () => {
    const content = blog(5, 1).map((c) => ({
      ...c,
      items: c.items.map((i, n) => ({
        ...i,
        fieldData: {
          ...i.fieldData,
          tags: [[], ["a"], "", {}, { k: 1 }][n],
        },
      })),
    }));
    const { adapter } = over({ content });
    expect(await adapter.fieldCounts("blog", ["tags", "name"])).toEqual({ tags: 2, name: 5 });
  });

  it("an edit stamped within two seconds of the publish is not a change; three seconds later is", async () => {
    expect(WEBFLOW_STAGED_TOLERANCE_MS).toBe(2000);
    const at = (updated: string) =>
      blog(1, 1).map((c) => ({
        ...c,
        items: c.items.map((i) => ({
          ...i,
          lastPublished: "2026-10-01T09:00:00.000Z",
          lastUpdated: updated,
        })),
      }));
    const stateFor = async (updated: string): Promise<string | undefined> => {
      for await (const x of over({ content: at(updated) }).adapter.staged()) return x.state;
      return undefined;
    };
    expect(await stateFor("2026-10-01T09:00:01.500Z")).toBe("live");
    expect(await stateFor("2026-10-01T09:00:02.000Z")).toBe("live");
    expect(await stateFor("2026-10-01T09:00:03.000Z")).toBe("changed");
  });
});

describe("Webflow: what is staged", () => {
  it("names each item's state from the staged list: staged, changed, draft, archived or live", async () => {
    const { adapter } = over();
    const states: Record<string, string> = {};
    for await (const s of adapter.staged()) states[s.id] = s.state;
    expect(states).toEqual({
      "e-harvest": "live",
      "e-oyster": "live",
      "e-winter": "staged",
      "e-new-year": "draft",
      "e-summer": "archived",
      "m-trout": "changed",
      "m-leek": "live",
      "t-1": "live",
      "t-2": "live",
    });
  });

  it("gives ids, slugs and times only: no name, no field", async () => {
    const { adapter } = over();
    const all: unknown[] = [];
    for await (const s of adapter.staged({ types: ["events"] })) all.push(s);
    const text = JSON.stringify(all);
    for (const marker of Object.values(WEBFLOW_MARKERS)) expect(text).not.toContain(marker);
    expect(all).toContainEqual({
      id: "e-winter",
      type: "events",
      slug: "winter-warmer",
      state: "staged",
      lastUpdated: "2026-11-08T17:00:00.000Z",
    });
  });

  it("an edit made after the last publish is `changed`; one made before it is live", async () => {
    const { adapter } = over();
    const got: Record<string, string> = {};
    for await (const s of adapter.staged({ types: ["menu-items"] })) got[s.id] = s.state;
    expect(got).toEqual({ "m-trout": "changed", "m-leek": "live" });
  });
});

describe("Webflow: read only", () => {
  it("builds no request but GET, to api.webflow.com only, with the token in a header", async () => {
    const { adapter, seen } = over({
      adapter: { settings: { id: "webflow", fingerprint: { events: ["name"] } } },
    });
    await adapter.types();
    await adapter.fieldCounts("events", ["name"]);
    await collectPublished(adapter);
    await adapter.draftsReachable();
    for await (const s of adapter.staged()) void s;
    expect(seen.length).toBeGreaterThan(5);
    expect(requestProblems(seen)).toEqual([]);
    for (const s of seen) {
      expect(new URL(s.url).host).toBe("api.webflow.com");
      expect(s.url).not.toContain(KEY);
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    }
    expect(
      new Set(seen.map((s) => new URL(s.url).pathname.replace(/[0-9a-f]{24}/g, ":id"))),
    ).toEqual(
      new Set([
        "/v2/sites/:id/collections",
        "/v2/collections/:id/items/live",
        "/v2/collections/:id/items",
      ]),
    );
  });
});
