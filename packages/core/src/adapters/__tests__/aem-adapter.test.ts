import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { AdapterCouldNotCheck, type AdapterSettings } from "../types.js";
import { rateLimited } from "./contract.js";
import { AEM_LIMITS, createAemAdapter, damPath, type AemAdapterOptions } from "../aem.js";
import {
  AEM_CONTENT,
  AEM_ENV,
  AEM_MARKERS,
  aemTransport,
  metadataOf,
  type AemFixtureOptions,
  type FixtureQuery,
} from "./aem-fixture.js";

/**
 * What is particular to the Adobe Experience Manager adapter: persisted queries over GET, the cursor and the
 * list shapes, the path and name checks, and a hostile publish tier. The rules every adapter shares are in the
 * contract suite (contract.test.ts), which runs over this adapter's entry.
 */
const noWait = () => Promise.resolve();

const SETTINGS: AdapterSettings = {
  id: "aem",
  fingerprint: { rooms: ["name", "summary"] },
  urls: { rooms: "/rooms/{slug}", offers: "/offers/{slug}", venues: "/venues/{slug}" },
};

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
}

function make(
  over: Partial<AemAdapterOptions> = {},
  fixture: AemFixtureOptions = {},
  content: readonly FixtureQuery[] = AEM_CONTENT,
) {
  const seen: Seen[] = [];
  const adapter = createAemAdapter({
    env: AEM_ENV,
    fetcher: createFetcher({
      transport: aemTransport(content, {
        ...fixture,
        onRequest: (method, url, headers) => seen.push({ method, url, headers }),
      }),
      timeoutMs: 5000,
    }),
    sleep: noWait,
    settings: SETTINGS,
    ...over,
  });
  return { adapter, seen };
}

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof AdapterCouldNotCheck) return err.reason;
    throw err;
  }
  throw new Error("expected could-not-check");
};

const slow = (n: number): FixtureQuery => ({
  name: "rooms",
  form: "paginated",
  items: Array.from({ length: n }, (_, i) => ({
    path: `/content/dam/harbourline/en/rooms/room-${i}`,
    status: "published" as const,
    fields: { name: `Room ${i}` },
  })),
});

describe("the Adobe Experience Manager adapter: what it asks", () => {
  it("asks only GETs of /graphql/execute.json/<config>/<query> on the publish origin, anonymously", async () => {
    const { adapter, seen } = make();
    await adapter.types();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(s.url.origin).toBe("https://www.harbourline-hotels.example");
      expect(s.url.pathname).toMatch(
        /^\/graphql\/execute\.json\/harbourline\/(offers|rooms|venues)$/,
      );
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
      expect(s.url.search).toBe("");
    }
  });

  it("follows a paginated query by its cursor (;first=<n>;after=<cursor>) and gives the same items as one big page", async () => {
    const small = make({}, { firstPage: 1 });
    const docs = (await collectPublished(small.adapter, { types: ["venues"] })).docs;
    const big = (await collectPublished(make().adapter, { types: ["venues"] })).docs;
    expect(docs.map((d) => d.id)).toEqual([
      "harbourline.en.venues.terrace",
      "harbourline.en.venues.cellar",
    ]);
    expect(docs).toEqual(big);
    const second = small.seen.at(-1)?.url.pathname ?? "";
    expect(second).toMatch(/\/venues;first=100;after=[A-Za-z0-9%]+$/);
  });

  it("reads a list query (items, no pageInfo) in one request", async () => {
    const { adapter, seen } = make();
    const docs = (await collectPublished(adapter, { types: ["offers"] })).docs;
    expect(docs.map((d) => d.slug)).toEqual(["winter-stay"]);
    expect(seen).toHaveLength(1);
  });

  it("gives addresses from the pattern, the slug from the path, and the time only where the query returns it", async () => {
    const { adapter } = make({}, {}, [
      {
        name: "rooms",
        form: "paginated",
        items: [
          {
            path: "/content/dam/harbourline/en/rooms/garden",
            status: "published",
            modified: "2026-11-02T17:00:00Z",
            fields: { name: "n" },
          },
          {
            path: "/content/dam/harbourline/en/rooms/loft",
            status: "published",
            fields: { name: "n" },
          },
        ],
      },
    ]);
    const docs = (await collectPublished(adapter, { types: ["rooms"] })).docs;
    expect(docs[0]).toMatchObject({
      url: "/rooms/garden",
      slug: "garden",
      updatedAt: "2026-11-02T17:00:00.000Z",
    });
    expect(docs[1]?.updatedAt).toBeUndefined();
    expect(metadataOf(undefined)).toEqual({});
  });

  it("hashes the named fields and nothing else: no client text in a doc, a count or a message", async () => {
    const { adapter } = make();
    const docs = (await collectPublished(adapter, { types: ["rooms"] })).docs;
    expect(Object.keys(docs[0]?.fieldHashes ?? {})).toEqual(["name", "summary"]);
    expect(Object.keys(docs[1]?.fieldHashes ?? {})).toEqual(["name"]);
    const text = JSON.stringify([
      docs,
      await adapter.types(),
      await adapter.fieldCounts("rooms", ["name"]),
    ]);
    for (const m of Object.values(AEM_MARKERS)) expect(text).not.toContain(m);
  });

  it("the since window drops older fragments and keeps ones with no time", async () => {
    const { adapter } = make();
    const docs = (
      await collectPublished(adapter, { types: ["rooms"], since: "2026-11-01T00:00:00Z" })
    ).docs;
    expect(docs.map((d) => d.slug)).toEqual(["garden"]);
  });
});

describe("the Adobe Experience Manager adapter: a part that cannot be read", () => {
  it("a query the publish tier protects (401) is could-not-check for that query only", async () => {
    const { adapter } = make({}, { refuse: { rooms: 401 } });
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(
      /asked for a login \(HTTP 401\)/,
    );
    expect(await adapter.fieldCounts("offers", ["name"])).toEqual({ name: 1 });
    expect(await reason(adapter.types())).toMatch(/login/);
  });

  it("a query that is not published to the publish tier (404) says so", async () => {
    const { adapter } = make({}, { refuse: { venues: 404 } });
    expect(await reason(adapter.fieldCounts("venues", ["name"]))).toMatch(
      /not published to the publish tier/,
    );
  });

  it("a redirect is never followed", async () => {
    const { adapter, seen } = make({}, { refuse: { rooms: 302 } });
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(/redirect/);
    expect(seen).toHaveLength(1);
  });

  it("GraphQL errors in a 200 are could-not-check, never an empty list, and their text is not repeated", async () => {
    const { adapter } = make(
      {},
      {
        override: () => ({ data: null, errors: [{ message: AEM_MARKERS.suite }] }),
      },
    );
    const why = await reason(adapter.fieldCounts("rooms", ["name"]));
    expect(why).toMatch(/1 GraphQL error/);
    expect(why).not.toContain(AEM_MARKERS.suite);
  });

  it("an answer with no list, or two lists, is could-not-check", async () => {
    const none = make({}, { override: () => ({ data: { a: { total: 1 } } }) });
    expect(await reason(none.adapter.fieldCounts("rooms", ["name"]))).toMatch(/exactly one list/);
    const two = make({}, { override: () => ({ data: { a: { items: [] }, b: { items: [] } } }) });
    expect(await reason(two.adapter.fieldCounts("rooms", ["name"]))).toMatch(/exactly one list/);
    const text = make({}, { override: () => "nope" });
    expect(await reason(text.adapter.fieldCounts("rooms", ["name"]))).toMatch(
      /not an object|no data/,
    );
  });

  it("a 429 with a short Retry-After is waited out once, then the partial result is reported", async () => {
    const waits: number[] = [];
    const adapter = createAemAdapter({
      env: AEM_ENV,
      fetcher: createFetcher({
        transport: rateLimited(aemTransport(), { after: 1, times: 5, retryAfter: "2" }),
        timeoutMs: 5000,
      }),
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
      settings: SETTINGS,
    });
    const got = await collectPublished(adapter, { types: ["offers", "rooms"] });
    expect(waits).toEqual([2000]);
    expect(got.docs.map((d) => d.slug)).toEqual(["winter-stay"]);
    expect(got.partial).toMatchObject({ reason: "rate-limited", delivered: 1 });
  });
});

describe("the Adobe Experience Manager adapter: settings and addresses", () => {
  it("no persisted query named is could-not-check", async () => {
    const { adapter, seen } = make({ settings: { id: "aem" } });
    expect(await reason(adapter.types())).toMatch(/No persisted query is named/);
    expect(seen).toHaveLength(0);
  });

  it("an empty or bad AEM_PUBLISH_URL or AEM_CONFIG is could-not-check and sends nothing", async () => {
    const bad: Record<string, string>[] = [
      {},
      { AEM_PUBLISH_URL: "", AEM_CONFIG: "harbourline" },
      { AEM_PUBLISH_URL: "http://www.harbourline-hotels.example", AEM_CONFIG: "harbourline" },
      {
        AEM_PUBLISH_URL:
          "https://" +
          ["user", "pw"].join(":") +
          String.fromCharCode(64) +
          "www.harbourline-hotels.example",
        AEM_CONFIG: "harbourline",
      },
      {
        AEM_PUBLISH_URL: "https://www.harbourline-hotels.example/content",
        AEM_CONFIG: "harbourline",
      },
      { AEM_PUBLISH_URL: "https://www.harbourline-hotels.example/?x=1", AEM_CONFIG: "harbourline" },
      { AEM_PUBLISH_URL: "https://author.harbourline-hotels.example", AEM_CONFIG: "harbourline" },
      { AEM_PUBLISH_URL: "https://author-p1-e2.adobeaemcloud.com", AEM_CONFIG: "harbourline" },
      { AEM_PUBLISH_URL: "not an address", AEM_CONFIG: "harbourline" },
      { AEM_PUBLISH_URL: "https://www.harbourline-hotels.example" },
      { AEM_PUBLISH_URL: "https://www.harbourline-hotels.example", AEM_CONFIG: "a/b" },
      { AEM_PUBLISH_URL: "https://www.harbourline-hotels.example", AEM_CONFIG: ".." },
      { AEM_PUBLISH_URL: "https://www.harbourline-hotels.example", AEM_CONFIG: "%2e%2e" },
    ];
    for (const env of bad) {
      const { adapter, seen } = make({ env });
      await reason(adapter.fieldCounts("rooms", ["name"]));
      expect(seen).toHaveLength(0);
    }
  });

  it("a persisted query name that could escape the path is refused before any request", async () => {
    for (const name of ["../x", "a/b", "a;b", "%2e%2e", "a b", "", ".hidden", "a?b", "\uD800"]) {
      const { adapter, seen } = make({ settings: { id: "aem", urls: { [name]: "/x/{slug}" } } });
      await reason(adapter.types());
      expect(seen).toHaveLength(0);
    }
  });

  it("a type that is not named is could-not-check, never an empty type", async () => {
    const { adapter } = make();
    expect(await reason(adapter.fieldCounts("spa", ["name"]))).toMatch(
      /not a persisted query named/,
    );
  });

  it("draftsReachable is not-applicable: the publish tier serves only what is published", async () => {
    const { adapter, seen } = make();
    expect(await adapter.draftsReachable()).toBe("not-applicable");
    expect(seen).toHaveLength(0);
  });
});

describe("the Adobe Experience Manager adapter: fragment paths", () => {
  it("accepts /content/dam/ and plain segments only", () => {
    expect(damPath("/content/dam/harbourline/en/rooms/garden")).toBe(
      "/content/dam/harbourline/en/rooms/garden",
    );
    for (const bad of [
      "//evil.example/content/dam/x",
      "https://evil.example/content/dam/x",
      "/content/dam/../etc/passwd",
      "/content/dam/%2e%2e/x",
      "/content/dam/a%2fb",
      "/content/dam/",
      "/content/dam//x",
      "/content/dam/a b",
      "/content/dam/.hidden",
      "/content/dam/\uD800",
      "/content/dam/" + "a/".repeat(13) + "b",
      "/content/dam/" + "a".repeat(600),
      "/content/other/x",
      "content/dam/x",
      42,
      null,
    ])
      expect(damPath(bad)).toBeUndefined();
  });

  it("a fragment with a bad _path makes the query could-not-check, and no part of the path reaches a message", async () => {
    for (const path of [
      "//evil.example/x",
      "/content/dam/../x",
      "/content/dam/\uD800",
      "https://x.example/",
    ]) {
      const { adapter } = make(
        {},
        {
          override: () => ({ data: { l: { items: [{ _path: path, name: "n" }] } } }),
        },
      );
      const why = await reason(adapter.fieldCounts("rooms", ["name"]));
      expect(why).toMatch(/no usable `_path`/);
      expect(why).not.toContain("evil.example");
    }
  });

  it("a long path gives an id inside the id charset and 128 characters", async () => {
    const path = "/content/dam/" + Array.from({ length: 12 }, () => "s".repeat(40)).join("/");
    const { adapter } = make(
      {},
      {
        override: () => ({ data: { l: { items: [{ _path: path, name: "n" }] } } }),
      },
    );
    const docs = (await collectPublished(adapter, { types: ["rooms"] })).docs;
    expect(docs[0]?.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  });
});

describe("the Adobe Experience Manager adapter: a hostile publish tier", () => {
  const page = (n: number, hasNext: boolean, cursor: string, start = 0) => ({
    data: {
      p: {
        edges: Array.from({ length: n }, (_, i) => ({
          node: { _path: `/content/dam/h/en/r/item-${start + i}`, name: "n" },
        })),
        pageInfo: { hasNextPage: hasNext, endCursor: cursor },
      },
    },
  });

  it("the same cursor forever is could-not-check, not an endless read and never complete", async () => {
    let n = 0;
    const { adapter, seen } = make({}, { override: () => page(1, true, "AAAA", n++) });
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(/do not move on/);
    expect(seen.length).toBeLessThan(5);
  });

  it("an empty page that promises another is could-not-check", async () => {
    const { adapter } = make({}, { override: () => page(0, true, "AAAA") });
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(/do not move on/);
  });

  it("a cursor that is not a plain token is could-not-check and is never put in an address", async () => {
    for (const cursor of ["a;b", "a b", "", "x".repeat(600), "\uD800"]) {
      const { adapter, seen } = make({}, { override: () => page(1, true, cursor) });
      await reason(adapter.fieldCounts("rooms", ["name"]));
      expect(seen).toHaveLength(1);
    }
  });

  it("a cursor is percent-encoded into the variable, so it cannot add a path part", async () => {
    const { adapter, seen } = make({}, { override: () => page(1, true, "../x") });
    await reason(adapter.fieldCounts("rooms", ["name"]));
    expect(seen[1]?.url.pathname).toMatch(/\/rooms;first=100;after=\.\.%2Fx$/);
  });

  it("endless distinct pages stop at the page bound", async () => {
    let n = 0;
    const { adapter, seen } = make(
      { maxPagesPerType: 5 },
      {
        override: () => page(1, true, `C${n}`, n++),
      },
    );
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(/more than 5 pages/);
    expect(seen).toHaveLength(5);
  });

  it("more fragments than the cap is could-not-check, never a count of part", async () => {
    const { adapter } = make({ maxItemsPerType: 3 }, {}, [slow(10)]);
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(/more than 3 fragments/);
  });

  it("a huge unpaged list is could-not-check: a clamp is never reported as complete", async () => {
    const { adapter } = make({}, {}, [{ ...slow(AEM_LIMITS.unpagedList), form: "list" }]);
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(
      /default limit may have cut/,
    );
    const ok = make({}, {}, [{ ...slow(AEM_LIMITS.unpagedList - 1), form: "list" }]);
    expect(await ok.adapter.fieldCounts("rooms", ["name"])).toEqual({
      name: AEM_LIMITS.unpagedList - 1,
    });
  });

  it("the same fragment twice is could-not-check", async () => {
    const { adapter } = make(
      {},
      {
        override: () => ({
          data: {
            l: {
              items: [
                { _path: "/content/dam/h/a", name: "n" },
                { _path: "/content/dam/h/a", name: "n" },
              ],
            },
          },
        }),
      },
    );
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(/same fragment twice/);
  });

  it("a pageInfo with no hasNextPage is could-not-check", async () => {
    const { adapter } = make(
      {},
      {
        override: () => ({ data: { l: { edges: [], pageInfo: { endCursor: "A" } } } }),
      },
    );
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(/hasNextPage/);
  });

  it("one answer with more fragments than the cap is could-not-check", async () => {
    const { adapter } = make(
      {},
      {
        override: () => page(AEM_LIMITS.itemsPerType + 1, false, "Z"),
      },
    );
    expect(await reason(adapter.fieldCounts("rooms", ["name"]))).toMatch(
      /more than 10000 fragments/,
    );
  });
});
