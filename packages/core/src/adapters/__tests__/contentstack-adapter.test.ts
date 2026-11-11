import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import {
  CONTENTSTACK_HOSTS,
  createContentstackAdapter,
  type ContentstackAdapterOptions,
} from "../contentstack.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import {
  CONTENTSTACK_CONTENT,
  CONTENTSTACK_HOST,
  CONTENTSTACK_MARKERS,
  contentstackTransport,
  type ContentstackFixtureOptions,
  type FixtureType,
} from "./contentstack-fixture.js";

/**
 * What is particular to the Contentstack adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out
 * once) are in the contract suite, which runs over this adapter's entry: no test here for those.
 */
const noWait = () => Promise.resolve();
const TOKEN = "test-delivery-token-0123456789";
const API_KEY = "test-stack-api-key-0123456789";
const ENV = {
  CONTENTSTACK_API_KEY: API_KEY,
  CONTENTSTACK_DELIVERY_TOKEN: TOKEN,
  CONTENTSTACK_ENVIRONMENT: "production",
};

function make(
  over: Partial<ContentstackAdapterOptions> = {},
  fixture: ContentstackFixtureOptions = {},
  content?: readonly FixtureType[],
  transport?: Transport,
) {
  const seen: { method: string; url: URL; headers: Record<string, string> }[] = [];
  const base = contentstackTransport(content, {
    token: TOKEN,
    apiKey: API_KEY,
    ...fixture,
    onRequest: (method, url, headers) => seen.push({ method, url, headers }),
  });
  return {
    seen,
    adapter: createContentstackAdapter({
      env: ENV,
      fetcher: createFetcher({ transport: transport ?? base, timeoutMs: 5000 }),
      sleep: noWait,
      ...over,
    }),
  };
}

const reasonOf = async (call: () => Promise<unknown>): Promise<string> => {
  const err: unknown = await call().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

/** Entries with a hand-made list, for hostile answers. */
const json = (body: unknown, status = 200) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const typesAnswer = {
  content_types: [{ uid: "rooms", schema: [{ uid: "title" }, { uid: "url" }] }],
  count: 1,
};

/** A server that answers the type list and then whatever `entries` makes of each entries request. */
const hostile =
  (entries: (url: URL) => unknown): Transport =>
  (url) =>
    url.pathname === "/v3/content_types" ? json(typesAnswer) : json(entries(url));

describe("the Contentstack adapter: reading", () => {
  it("steps by the page that came back: a server that clamps the page size loses nothing", async () => {
    const clamped = (await collectPublished(make({}, { pageMax: 1 }).adapter, { types: ["rooms"] }))
      .docs;
    const big = (await collectPublished(make().adapter, { types: ["rooms"] })).docs;
    expect(clamped.map((d) => d.id)).toEqual(["blt0a1b2c3d4e5f0101", "blt0a1b2c3d4e5f0102"]);
    expect(clamped).toEqual(big);
    expect(await make({}, { pageMax: 1 }).adapter.fieldCounts("rooms", ["title"])).toEqual({
      title: 2,
    });
  });

  it("an entry never published to the environment is not in the list or the counts", async () => {
    const { adapter } = make();
    const docs = (await collectPublished(adapter, { types: ["rooms"] })).docs;
    expect(docs.map((d) => d.id)).not.toContain("blt0a1b2c3d4e5f0103");
    expect((await adapter.types()).find((t) => t.name === "rooms")?.count).toBe(2);
  });

  it("gives each entry its address from its URL field, and a configured pattern wins", async () => {
    const plain = (await collectPublished(make().adapter, { types: ["rooms", "team"] })).docs;
    expect(plain.find((d) => d.id === "blt0a1b2c3d4e5f0101")).toMatchObject({
      url: "/rooms/harbour-view",
      slug: "harbour-view",
    });
    // A type with no URL field has no page of its own: no address is made up.
    expect(plain.find((d) => d.type === "team")?.url).toBeUndefined();
    const patterned = (
      await collectPublished(
        make({ settings: { id: "contentstack", urls: { rooms: "/stay/{slug}" } } }).adapter,
        { types: ["rooms"] },
      )
    ).docs;
    expect(patterned.map((d) => d.url)).toEqual(["/stay/harbour-view", "/stay/garden"]);
  });

  it("asks only for the fields it needs, and never expands references", async () => {
    const { adapter, seen } = make();
    await collectPublished(adapter, { types: ["rooms"], fields: { rooms: ["title", "nope"] } });
    const asked = seen.filter((s) => s.url.pathname.endsWith("/entries"));
    expect(asked.length).toBeGreaterThan(0);
    for (const s of asked) {
      expect(s.url.searchParams.getAll("only[BASE][]").sort()).toEqual(["title", "url"]);
      expect(s.url.searchParams.get("environment")).toBe("production");
      expect([...s.url.searchParams.keys()].some((k) => /^include(?!_count$)/.test(k))).toBe(false);
    }
    // No fields named: nothing but the system fields and the URL field is asked for.
    const quiet = make();
    await collectPublished(quiet.adapter, { types: ["rooms"] });
    for (const s of quiet.seen.filter((x) => x.url.pathname.endsWith("/entries")))
      expect(s.url.searchParams.getAll("only[BASE][]")).toEqual(["url"]);
  });

  it("a type bigger than the bound is could-not-check, never a count of part of it", async () => {
    expect(
      await reasonOf(() => make({ maxEntriesPerType: 1 }).adapter.fieldCounts("rooms", ["title"])),
    ).toMatch(/more than 1/);
  });

  it("a server that lies about a huge count cannot keep a run going", async () => {
    const same = hostile((url) => {
      const skip = Number(url.searchParams.get("skip") ?? "0");
      return {
        entries: [0, 1, 2].map((i) => ({
          uid: `blt00000000${skip + i}`,
          updated_at: "2026-10-01T00:00:00.000Z",
        })),
        count: 1_000_000_000,
      };
    });
    const { adapter } = make({ maxEntriesPerType: 5 }, {}, undefined, same);
    // Asked for a few (a limit): the cap on the whole type is not applied, but the read still stops.
    expect(
      await reasonOf(() => collectPublished(adapter, { types: ["rooms"], limit: 50 })),
    ).toMatch(/more than 5 entries/);
    expect(await reasonOf(() => adapter.fieldCounts("rooms", ["title"]))).toMatch(/more than 5/);
  });

  it("a server that sends one entry a page for a huge count is stopped by a page cap, not 10,000 requests", async () => {
    let asked = 0;
    const slow = hostile((url) => {
      asked++;
      const skip = Number(url.searchParams.get("skip") ?? "0");
      return {
        entries: [{ uid: `blt00000000${skip}`, updated_at: "2026-10-01T00:00:00.000Z" }],
        count: 1_000_000_000,
      };
    });
    const { adapter } = make({ maxEntriesPerType: 200 }, {}, undefined, slow);
    expect(
      await reasonOf(() => collectPublished(adapter, { types: ["rooms"], limit: 1000 })),
    ).toMatch(/pages/);
    expect(asked).toBeLessThanOrEqual(25);
  });

  it("a run has a request budget: over it, the read is could-not-check with the reason", async () => {
    const { adapter, seen } = make({ maxRequests: 2 }, { pageMax: 1 });
    expect(await reasonOf(() => adapter.fieldCounts("rooms", ["title"]))).toMatch(/requests/);
    expect(seen.length).toBeLessThanOrEqual(2);
  });

  it("the same entries for every page are could-not-check, never counted or yielded twice", async () => {
    const loop = hostile(() => ({
      entries: [
        { uid: "blt0a1b2c3d4e5f0001", updated_at: "2026-10-01T00:00:00.000Z" },
        { uid: "blt0a1b2c3d4e5f0002", updated_at: "2026-10-01T00:00:00.000Z" },
      ],
      count: 6,
    }));
    const { adapter } = make({}, {}, undefined, loop);
    const seenIds: string[] = [];
    const reason = await reasonOf(async () => {
      for await (const d of adapter.published({ types: ["rooms"] })) seenIds.push(d.id);
    });
    expect(reason).toMatch(/more than once|repeat/);
    expect(seenIds).toEqual(["blt0a1b2c3d4e5f0001", "blt0a1b2c3d4e5f0002"]);
    expect(await reasonOf(() => adapter.fieldCounts("rooms", ["title"]))).toMatch(
      /more than once|repeat/,
    );
  });

  it("a field uid with a surrogate half is could-not-check in plain words, never a raw URIError", async () => {
    const { adapter } = make({}, {}, undefined, (url) =>
      url.pathname === "/v3/content_types"
        ? json({
            content_types: [{ uid: "rooms", schema: [{ uid: "a\ud800" }, { uid: "title" }] }],
            count: 1,
          })
        : json({ entries: [], count: 0 }),
    );
    expect(await reasonOf(() => adapter.fieldCounts("rooms", ["title"]))).toMatch(/field/);
    expect(await reasonOf(() => adapter.fieldCounts("rooms", ["a\ud800"]))).toMatch(/field/);
  });

  it("a list that comes back empty before its count is could-not-check", async () => {
    const stalled = hostile(() => ({ entries: [], count: 7 }));
    const { adapter } = make({}, {}, undefined, stalled);
    expect(await reasonOf(() => collectPublished(adapter, { types: ["rooms"] }))).toMatch(
      /stopped after 0 of 7/,
    );
  });

  it("an answer with no count is could-not-check, not an empty list", async () => {
    const { adapter } = make(
      {},
      {},
      undefined,
      hostile(() => ({ entries: [] })),
    );
    expect(await reasonOf(() => collectPublished(adapter, { types: ["rooms"] }))).toMatch(
      /not a count/,
    );
  });

  it("an entry whose uid or URL field could change an address is read without one", async () => {
    const bad = [
      "//evil.example/x",
      "https://evil.example/x",
      "/rooms/../admin",
      "rooms/no-slash",
      "/rooms/a?b=1",
      "/rooms/a b",
      "/\\evil.example",
      "/%2e%2e/admin",
      "/%2E%2e/admin",
      "/rooms/%2e/x",
      "/rooms%2fa",
      "/rooms%5Ca",
    ];
    const entries = bad.map((url, i) => ({
      uid: `blt000000000000${i}`,
      updated_at: "2026-10-01T00:00:00.000Z",
      url,
    }));
    const { adapter } = make(
      {},
      {},
      undefined,
      hostile(() => ({ entries, count: entries.length })),
    );
    const docs = (await collectPublished(adapter, { types: ["rooms"] })).docs;
    expect(docs).toHaveLength(bad.length);
    for (const d of docs) expect(d.url).toBeUndefined();
  });

  it("a uid that is not a plain address part, or not valid text, is could-not-check, and never throws", async () => {
    for (const uid of ["../x", "a/b", "ab\ud800", "", "-start", "x".repeat(200)]) {
      const { adapter } = make(
        {},
        {},
        undefined,
        hostile(() => ({ entries: [{ uid, updated_at: "2026-10-01T00:00:00.000Z" }], count: 1 })),
      );
      expect(await reasonOf(() => collectPublished(adapter, { types: ["rooms"] }))).toMatch(
        /uid|no uid/,
      );
    }
    const lone = createContentstackAdapter({
      env: ENV,
      fetcher: createFetcher({
        transport: hostile(() => ({ entries: [], count: 0 })),
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    expect(lone.resolveUrl?.({ id: "blt1234567890abcd", type: "rooms", slug: "a\ud800" })).toBe("");
  });

  it("a content type uid with a slash or a surrogate half is could-not-check", async () => {
    for (const uid of ["a/b", "a\ud800", "..", ""]) {
      const { adapter } = make({}, {}, undefined, () =>
        json({ content_types: [{ uid, schema: [] }], count: 1 }),
      );
      expect(await reasonOf(() => adapter.types())).toMatch(/content type/);
    }
  });
});

describe("the Contentstack adapter: the key, the region and the environment", () => {
  it("sends the stack key and the token in headers to the delivery host, and nowhere else or in an address", async () => {
    const { adapter, seen } = make();
    await adapter.types();
    await collectPublished(adapter, { types: ["rooms"] });
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) {
      expect(s.url.protocol).toBe("https:");
      expect(s.url.host).toBe(CONTENTSTACK_HOST);
      expect(s.headers.api_key).toBe(API_KEY);
      expect(s.headers.access_token).toBe(TOKEN);
      expect(s.url.href).not.toContain(TOKEN);
      expect(s.url.href).not.toContain(API_KEY);
    }
  });

  it("reads the region's own host, chosen from a fixed list", async () => {
    for (const [region, host] of Object.entries(CONTENTSTACK_HOSTS)) {
      const { adapter, seen } = make(
        { env: { ...ENV, CONTENTSTACK_REGION: region.toUpperCase() } },
        { host },
      );
      expect((await adapter.types()).length).toBe(3);
      expect(seen.every((s) => s.url.host === host)).toBe(true);
    }
    expect(
      Object.values(CONTENTSTACK_HOSTS).every((h) =>
        /^[a-z-]*cdn\.contentstack\.(io|com)$/.test(h),
      ),
    ).toBe(true);
  });

  it("a region that is not on the list, or is a host, is refused and nothing is asked", async () => {
    for (const region of [
      "evil.example",
      "cdn.contentstack.io",
      "eu/../x",
      "__proto__",
      "toString",
    ]) {
      const { adapter, seen } = make({ env: { ...ENV, CONTENTSTACK_REGION: region } });
      expect(await reasonOf(() => adapter.types())).toContain("CONTENTSTACK_REGION");
      expect(seen).toEqual([]);
    }
  });

  it("an unset environment is could-not-check, never guessed, and a malformed one is refused", async () => {
    const unset = make({ env: { ...ENV, CONTENTSTACK_ENVIRONMENT: "" } });
    expect(await reasonOf(() => collectPublished(unset.adapter, { types: ["rooms"] }))).toContain(
      "CONTENTSTACK_ENVIRONMENT",
    );
    for (const name of ["a/b", "x y", "..", "a&b=c"]) {
      const { adapter } = make({ env: { ...ENV, CONTENTSTACK_ENVIRONMENT: name } });
      expect(await reasonOf(() => adapter.fieldCounts("rooms", ["title"]))).toContain(
        "CONTENTSTACK_ENVIRONMENT",
      );
    }
  });

  it("an environment the token is not for is could-not-check, not 'nothing published'", async () => {
    const { adapter } = make({}, { environment: "staging" });
    const reason = await reasonOf(() => collectPublished(adapter, { types: ["rooms"] }));
    expect(reason).toMatch(/HTTP 422/);
    expect(reason).toContain("CONTENTSTACK_ENVIRONMENT");
  });

  it("without either key it says which variable to set and asks for nothing", async () => {
    for (const drop of ["CONTENTSTACK_API_KEY", "CONTENTSTACK_DELIVERY_TOKEN"]) {
      const env = { ...ENV, [drop]: "" };
      const { adapter, seen } = make({ env });
      expect(await reasonOf(() => adapter.types())).toContain(drop);
      expect(seen).toEqual([]);
    }
  });

  it("a key with characters that could split a header is refused before it is sent", async () => {
    const { adapter, seen } = make({
      env: { ...ENV, CONTENTSTACK_DELIVERY_TOKEN: "abc\r\nx: y12345" },
    });
    const reason = await reasonOf(() => adapter.types());
    expect(reason).not.toContain("abc");
    expect(seen).toEqual([]);
  });

  it("a redirect to another origin carries neither header", async () => {
    const elsewhere: { host: string; headers: Record<string, string> }[] = [];
    const base = contentstackTransport(undefined, { token: TOKEN, apiKey: API_KEY });
    const transport: Transport = (url, req) => {
      if (url.host === "elsewhere.example") {
        elsewhere.push({ host: url.host, headers: req.headers });
        return json(typesAnswer);
      }
      if (url.pathname === "/v3/content_types")
        return Promise.resolve({
          status: 302,
          headers: { location: "https://elsewhere.example/v3/content_types" },
          body: Readable.from([]),
        });
      return base(url, req);
    };
    const { adapter } = make({}, {}, undefined, transport);
    await adapter.types().catch(() => undefined);
    for (const hop of elsewhere) {
      expect(hop.headers.api_key).toBeUndefined();
      expect(hop.headers.access_token).toBeUndefined();
    }
  });

  it("a refused key says so without repeating the key, in fixed words", async () => {
    const bad = make({ env: { ...ENV, CONTENTSTACK_DELIVERY_TOKEN: "wrong-token-0123456789" } });
    const reason = await reasonOf(() => bad.adapter.types());
    expect(reason).toMatch(/HTTP 401/);
    expect(reason).not.toContain("wrong-token");
    expect(reason).not.toContain(API_KEY);
  });
});

describe("the Contentstack adapter: what the token cannot see", () => {
  it("a content type the token may not read is could-not-check by name, never zero published", async () => {
    const { adapter } = make({}, { restricted: ["team"] });
    const reason = await reasonOf(() => adapter.types());
    expect(reason).toMatch(/^team: /);
    expect(reason).toMatch(/HTTP 403/);
    expect(await reasonOf(() => adapter.fieldCounts("team", ["title"]))).toMatch(/HTTP 403/);
    // The part the token can read is still read.
    expect((await collectPublished(adapter, { types: ["rooms"] })).docs).toHaveLength(2);
    expect(await adapter.fieldCounts("rooms", ["title"])).toEqual({ title: 2 });
  });

  it("a content type the stack does not list (or the token cannot see) is could-not-check, not empty", async () => {
    const { adapter } = make();
    expect(
      await reasonOf(() => collectPublished(adapter, { types: ["rooms", "members"] })),
    ).toMatch(/no content type named members/);
    expect(await reasonOf(() => adapter.fieldCounts("members", ["title"]))).toMatch(/members/);
  });

  it("drafts are out of reach of a delivery token: false, after one read that proves the key works", async () => {
    const { adapter, seen } = make();
    expect(await adapter.draftsReachable()).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    const refused = make({
      env: { ...ENV, CONTENTSTACK_DELIVERY_TOKEN: "wrong-token-0123456789" },
    });
    expect(await reasonOf(() => refused.adapter.draftsReachable())).toMatch(/HTTP 401/);
  });

  it("an empty list of content types is not a clean pass for a type that was asked for by name", async () => {
    const { adapter } = make({}, {}, []);
    expect(await adapter.types()).toEqual([]);
    expect(await reasonOf(() => collectPublished(adapter, { types: ["rooms"] }))).toMatch(
      /no content type named rooms/,
    );
  });
});

describe("the Contentstack adapter: limits and fingerprints", () => {
  it("a rate limit that stays is reported with what was read", async () => {
    let calls = 0;
    const base = contentstackTransport(undefined, { token: TOKEN, apiKey: API_KEY });
    const transport: Transport = (url, req) =>
      ++calls > 2
        ? Promise.resolve({
            status: 429,
            headers: { "retry-after": "500" },
            body: Readable.from([Buffer.from("{}")]),
          })
        : base(url, req);
    const { adapter } = make({}, {}, undefined, transport);
    const err: unknown = await (async () => {
      for await (const d of adapter.published({ types: ["rooms", "team"] })) void d;
    })().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
    expect((err as AdapterRateLimitedError<number>).partial).toBe(2);
  });

  it("hashes field values and never returns one", async () => {
    const { adapter } = make();
    const docs = (
      await collectPublished(adapter, { types: ["rooms"], fields: { rooms: ["title", "summary"] } })
    ).docs;
    const text = JSON.stringify(docs);
    for (const marker of Object.values(CONTENTSTACK_MARKERS)) expect(text).not.toContain(marker);
    expect(Object.keys(docs[0]?.fieldHashes ?? {}).sort()).toEqual(["summary", "title"]);
    // The entry without a summary has no hash for it.
    expect(Object.keys(docs[1]?.fieldHashes ?? {})).toEqual(["title"]);
  });

  it("filters by since on the entry's update time", async () => {
    const { adapter } = make();
    const docs = (
      await collectPublished(adapter, { types: ["rooms"], since: "2026-11-01T00:00:00.000Z" })
    ).docs;
    expect(docs.map((d) => d.id)).toEqual(["blt0a1b2c3d4e5f0102"]);
  });

  it("lists every type of the stack, sorted", async () => {
    expect(CONTENTSTACK_CONTENT.map((t) => t.uid)).toEqual(["offers", "rooms", "team"]);
    expect((await make().adapter.types()).map((t) => t.name)).toEqual(["offers", "rooms", "team"]);
  });
});
