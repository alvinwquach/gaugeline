// check-community: allow-email (an invented malformed repository name, to prove it never becomes a host)
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { createPrismicAdapter, type PrismicAdapterOptions } from "../prismic.js";
import { AdapterCouldNotCheck } from "../types.js";
import {
  CACHE_HOST,
  LARKSPUR,
  MASTER_REF,
  OLD_MASTER_REF,
  ORIGIN_HOST,
  PRISMIC_MARKERS,
  RELEASE_DOCS_CLEAN,
  RELEASE_ID,
  RELEASE_REF,
  REPOSITORY,
  prismicTransport,
  rich,
  type FixtureDoc,
  type PrismicFixtureOptions,
} from "./prismic-fixture.js";

/**
 * What is particular to the Prismic adapter. The rules every adapter shares (counts and fingerprints but never a
 * value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out once) are in the
 * contract suite, which runs over this adapter's entry in entries.ts: no test here repeats those.
 */
const KEY = testKey("prismic-tests");
const noWait = () => Promise.resolve();

interface World {
  seen: { method: string; url: URL; headers: Record<string, string> }[];
  sleeps: number[];
  adapter: ReturnType<typeof createPrismicAdapter>;
}

function world(
  fixture: PrismicFixtureOptions = {},
  over: Partial<PrismicAdapterOptions> = {},
  content: readonly FixtureDoc[] = LARKSPUR,
): World {
  const seen: World["seen"] = [];
  const sleeps: number[] = [];
  const adapter = createPrismicAdapter({
    env: { PRISMIC_REPOSITORY: REPOSITORY, PRISMIC_ACCESS_TOKEN: KEY },
    fetcher: createFetcher({
      transport: prismicTransport(content, {
        onRequest: (method, url, headers) => seen.push({ method, url, headers }),
        ...fixture,
      }),
      timeoutMs: 5000,
    }),
    sleep: (ms) => {
      sleeps.push(ms);
      return noWait();
    },
    settings: {
      id: "prismic",
      urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}" },
      checkReleases: true,
    },
    ...over,
  });
  return { seen, sleeps, adapter };
}

const reason = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

/** Forty teachers: more than one page at any small page size. */
const MANY: FixtureDoc[] = Array.from({ length: 30 }, (_, i) => ({
  id: `t-${String(i).padStart(2, "0")}`,
  uid: `teacher-${i}`,
  type: "teachers",
  lang: "en-us",
  first: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00.000Z`,
  last: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00.000Z`,
  data: { name: rich(`Teacher ${i}`) },
}));

describe("the Prismic adapter: the repository name", () => {
  it.each([
    "",
    "larkspur.example",
    "https://larkspur-yoga.cdn.prismic.io",
    "larkspur-yoga/evil",
    "larkspur-yoga@evil.example",
    "larkspur:443",
    "larkspur-yoga:8080",
    "larkspur-yoga.",
    "larkspur-yoga..",
    "larksp\u00fcr-yoga",
    "larkspur-yoga\u3002example",
    "larkspur yoga",
    "xn--larkspur",
    "lark--spur",
    "-larkspur",
    "larkspur-",
    "ab",
    `${"a".repeat(64)}`,
  ])("%j never becomes a host name, and nothing is asked", async (name) => {
    const w = world({}, { env: { PRISMIC_REPOSITORY: name, PRISMIC_ACCESS_TOKEN: KEY } });
    expect(await reason(w.adapter.types())).toContain("PRISMIC_REPOSITORY");
    expect(w.seen).toEqual([]);
  });

  it("is read from the cache host and the origin host of that name, and no other", async () => {
    const w = world();
    await w.adapter.types();
    await w.adapter.masterRefs();
    expect(new Set(w.seen.map((s) => s.url.host))).toEqual(new Set([CACHE_HOST, ORIGIN_HOST]));
    for (const s of w.seen) {
      expect(s.url.protocol).toBe("https:");
      expect(s.url.username).toBe("");
      expect(s.url.port).toBe("");
    }
  });
});

describe("the Prismic adapter: the token", () => {
  it("a public repository is read with no token at all, though one is set", async () => {
    const w = world();
    await w.adapter.types();
    await collectPublished(w.adapter);
    expect(w.seen.length).toBeGreaterThan(0);
    for (const s of w.seen) expect(s.headers.authorization).toBeUndefined();
  });

  it("a private repository: refused without the token once, then every read sends it in a header", async () => {
    const w = world({ token: KEY });
    const types = await w.adapter.types();
    expect(types.map((t) => t.name)).toEqual(["classes", "notices", "teachers"]);
    expect(w.seen[0]?.headers.authorization).toBeUndefined();
    const later = w.seen.slice(1);
    expect(later.length).toBeGreaterThan(1);
    for (const s of later) expect(s.headers.authorization).toBe(`Token ${KEY}`);
    for (const s of w.seen) expect(s.url.href).not.toContain(KEY);
  });

  it("a private repository with no token says so, and names the variable", async () => {
    const w = world({ token: KEY }, { env: { PRISMIC_REPOSITORY: REPOSITORY } });
    const text = await reason(w.adapter.types());
    expect(text).toContain("PRISMIC_ACCESS_TOKEN");
    expect(text).toMatch(/private/);
  });

  it("a token the repository does not accept is could-not-check, and never quoted", async () => {
    const w = world(
      { token: KEY },
      { env: { PRISMIC_REPOSITORY: REPOSITORY, PRISMIC_ACCESS_TOKEN: `${KEY}-x` } },
    );
    const text = await reason(w.adapter.types());
    expect(text).toMatch(/did not accept/);
    expect(text).not.toContain(KEY);
    // The explanation names the one thing a person can do about a repository that takes the token only in the address.
    expect(text).toMatch(/address/);
  });

  it("the key is never in an address, even when the repository is read with it", async () => {
    const w = world({ token: KEY });
    await collectPublished(w.adapter);
    await w.adapter.draftsReachable();
    for (const s of w.seen) {
      expect(s.url.href).not.toContain(KEY);
      expect(s.url.searchParams.has("access_token")).toBe(false);
    }
  });
});

describe("the Prismic adapter: reading a list", () => {
  it("reads a list a page at a time and gives the same documents as one big page", async () => {
    const small = (
      await collectPublished(world({}, { pageSize: 1 }).adapter, { types: ["classes"] })
    ).docs;
    const big = (await collectPublished(world().adapter, { types: ["classes"] })).docs;
    expect(small.map((d) => d.id)).toEqual(["c-morning", "c-evening"]);
    expect(small).toEqual(big);
  });

  it("every list has an explicit order, all languages and a type filter, and asks no field it was not given", async () => {
    const w = world();
    await collectPublished(w.adapter, { types: ["classes"], fields: { classes: ["name"] } });
    const search = w.seen.filter((s) => s.url.pathname.endsWith("/documents/search"));
    expect(search.length).toBeGreaterThan(0);
    for (const s of search) {
      expect(s.url.searchParams.get("orderings")).toBe("[document.first_publication_date]");
      expect(s.url.searchParams.get("lang")).toBe("*");
      expect(s.url.searchParams.get("q")).toBe('[[at(document.type, "classes")]]');
      expect(s.url.searchParams.get("fetch")).toBe("classes.name");
      expect(s.url.searchParams.get("ref")).toBe(MASTER_REF);
    }
  });

  it("a list bigger than the bound is could-not-check, never a count of part of it", async () => {
    expect(
      await reason(world({}, { maxItemsPerType: 1 }).adapter.fieldCounts("classes", ["name"])),
    ).toMatch(/more than 1/);
  });

  it("an answer over the size limit is asked again with a smaller page, and the whole list is read", async () => {
    const w = world(
      {
        mangle: (body, q) => {
          const results = body.results as { data: Record<string, unknown> }[];
          if (Number(q.get("pageSize")) >= 50)
            for (const r of results) r.data = { ...r.data, pad: "x".repeat(300_000) };
          return body;
        },
      },
      {},
      MANY,
    );
    const got = await collectPublished(w.adapter, { types: ["teachers"] });
    expect(got.docs).toHaveLength(30);
    const sizes = w.seen.map((s) => s.url.searchParams.get("pageSize"));
    expect(sizes).toContain("100");
    expect(sizes).toContain("50");
    expect(sizes).toContain("25");
  });

  it("a server that gives a smaller page than asked for is could-not-check, not a shorter list", async () => {
    const w = world({ perPage: 1 }, { pageSize: 2 });
    expect(await reason(collectPublished(w.adapter, { types: ["classes"] }))).toMatch(
      /1 documents to a page when 2/,
    );
  });

  it("a total that moves between pages is could-not-check", async () => {
    const w = world(
      {
        mangle: (body, _q, call) => ({
          ...body,
          total_results_size: 30 - (call > 0 ? 1 : 0),
          total_pages: 2,
        }),
      },
      { pageSize: 25 },
      MANY,
    );
    expect(await reason(collectPublished(w.adapter, { types: ["teachers"] }))).toMatch(
      /changed while/,
    );
  });

  it("a document that comes back on two pages is could-not-check, not counted twice", async () => {
    const w = world(
      {
        mangle: (body, _q, call) => {
          if (call === 1) {
            const results = body.results as { id: string }[];
            results[0] = { ...results[0], id: "t-00" } as (typeof results)[number];
          }
          return body;
        },
      },
      { pageSize: 25 },
      MANY,
    );
    expect(await reason(collectPublished(w.adapter, { types: ["teachers"] }))).toMatch(/two pages/);
  });

  it("a list that stops before its total is could-not-check", async () => {
    const w = world(
      {
        mangle: (body) => ({
          ...body,
          results: (body.results as unknown[]).slice(0, 1),
          results_size: 1,
        }),
      },
      { pageSize: 25 },
      MANY,
    );
    expect(await reason(collectPublished(w.adapter, { types: ["teachers"] }))).toMatch(/expected/);
  });

  it("a list that holds more than its total is could-not-check", async () => {
    const w = world({ mangle: (body) => ({ ...body, total_results_size: 1, total_pages: 1 }) });
    expect(await reason(collectPublished(w.adapter, { types: ["classes"] }))).toMatch(
      /expected|more/,
    );
  });

  it("a page number the server did not answer is could-not-check", async () => {
    const w = world({ mangle: (body) => ({ ...body, page: 3 }) });
    expect(await reason(collectPublished(w.adapter, { types: ["classes"] }))).toMatch(
      /page 3 when page 1/,
    );
  });

  it("a count that is not a whole number is could-not-check", async () => {
    const w = world({ mangle: (body) => ({ ...body, total_results_size: "2" }) });
    expect(await reason(w.adapter.types())).toMatch(/no usable total/);
  });

  it("a ref that expires while a list is read is could-not-check, not a shorter list", async () => {
    const w = world({ expired: [MASTER_REF] });
    expect(await reason(collectPublished(w.adapter, { types: ["classes"] }))).toMatch(
      /410|expired/,
    );
  });
});

describe("the Prismic adapter: a document that is not what it should be", () => {
  const bad = (change: (d: Record<string, unknown>) => void) =>
    world({
      mangle: (body) => {
        const first = (body.results as Record<string, unknown>[])[0];
        if (first) change(first);
        return body;
      },
    });

  it("a uid that is neither text nor empty is unknown, never 'none'", async () => {
    const w = bad((d) => {
      d.uid = { de: "morgen-fluss" };
    });
    expect(await reason(collectPublished(w.adapter, { types: ["classes"] }))).toMatch(
      /uid is neither text nor empty/,
    );
  });

  it("a missing uid is unknown too, and an empty one is a document with no uid", async () => {
    const missing = bad((d) => {
      delete d.uid;
    });
    expect(await reason(collectPublished(missing.adapter, { types: ["classes"] }))).toMatch(/uid/);
    const empty = bad((d) => {
      d.uid = null;
    });
    const docs = (await collectPublished(empty.adapter, { types: ["classes"] })).docs;
    expect(docs[0]?.slug).toBeUndefined();
    expect(docs[0]?.url).toBeUndefined();
    expect(docs[1]?.url).toBe("/classes/evening-stretch");
  });

  it.each([
    ["last_publication_date", null],
    ["last_publication_date", "yesterday"],
    ["first_publication_date", 1760000000],
    ["type", { name: "classes" }],
    ["lang", 5],
    ["id", ""],
  ])("a %s of %j is could-not-check, never a made-up value", async (key, value) => {
    const w = bad((d) => {
      d[key] = value;
    });
    expect(await reason(collectPublished(w.adapter, { types: ["classes"] }))).toMatch(
      /Prismic answered with a document/,
    );
  });

  it.each([
    ["none", []],
    [
      "two",
      [
        { id: "a", ref: "abc", label: "Master", isMasterRef: true },
        { id: "b", ref: "def", label: "Master", isMasterRef: true },
      ],
    ],
  ])("a root with %s master refs is could-not-check", async (_name, refs) => {
    const adapter = createPrismicAdapter({
      env: { PRISMIC_REPOSITORY: REPOSITORY },
      fetcher: createFetcher({
        transport: () =>
          Promise.resolve({
            status: 200,
            headers: { "content-type": "application/json" },
            body: Readable.from([Buffer.from(JSON.stringify({ refs, types: {} }))]),
          }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    expect(await reason(adapter.types())).toMatch(/master refs, and there must be exactly one/);
  });
});

describe("the Prismic adapter: languages and text fields", () => {
  const fr: FixtureDoc = {
    id: "c-morning-fr",
    uid: "morning-flow",
    type: "classes",
    lang: "fr-fr",
    first: "2026-10-02T09:00:00.000Z",
    last: "2026-10-21T09:00:00.000Z",
    data: { name: rich("Flux du matin") },
  };

  it("reads every language, and gives an address only to a document in the main language", async () => {
    const w = world({}, {}, [...LARKSPUR, fr]);
    const docs = (await collectPublished(w.adapter, { types: ["classes"] })).docs;
    expect(docs.map((d) => d.id)).toEqual(["c-morning", "c-morning-fr", "c-evening"]);
    expect(docs.find((d) => d.id === "c-morning")?.url).toBe("/classes/morning-flow");
    expect(docs.find((d) => d.id === "c-morning-fr")?.url).toBeUndefined();
    expect((await w.adapter.types()).find((t) => t.name === "classes")?.count).toBe(3);
  });

  it("when the root names no main language, no document is given an address", async () => {
    const w = world({ masterLang: "none" });
    const docs = (await collectPublished(w.adapter, { types: ["classes"] })).docs;
    expect(docs.length).toBe(2);
    for (const d of docs) expect(d.url).toBeUndefined();
  });

  it("an empty rich text is not a field: not counted, and left out of the hashes", async () => {
    const w = world();
    expect(await w.adapter.fieldCounts("classes", ["name", "summary"])).toEqual({
      name: 2,
      summary: 1,
    });
    const docs = (
      await collectPublished(w.adapter, {
        types: ["classes"],
        fields: { classes: ["name", "summary"] },
      })
    ).docs;
    expect(Object.keys(docs.find((d) => d.id === "c-evening")?.fieldHashes ?? {})).toEqual([
      "name",
    ]);
    expect(Object.keys(docs.find((d) => d.id === "c-morning")?.fieldHashes ?? {}).sort()).toEqual([
      "name",
      "summary",
    ]);
  });

  it("no field text reaches the documents it gives", async () => {
    const w = world();
    const text = JSON.stringify(
      (await collectPublished(w.adapter, { fields: { classes: ["name", "summary"] } })).docs,
    );
    for (const marker of Object.values(PRISMIC_MARKERS)) expect(text).not.toContain(marker);
  });

  it("a type that does not exist has no counts and is not asked for", async () => {
    const w = world();
    expect(await w.adapter.fieldCounts("none", ["name"])).toEqual({ name: 0 });
    expect(w.seen.filter((s) => s.url.pathname.endsWith("/documents/search"))).toEqual([]);
  });

  it("a type name that would break out of the filter never reaches an address", async () => {
    const w = createPrismicAdapter({
      env: { PRISMIC_REPOSITORY: REPOSITORY },
      fetcher: createFetcher({
        transport: () =>
          Promise.resolve({
            status: 200,
            headers: { "content-type": "application/json" },
            body: Readable.from([
              Buffer.from(
                JSON.stringify({
                  refs: [{ id: "master", ref: "abc", label: "Master", isMasterRef: true }],
                  types: { 'x")]]&ref=other': "Bad" },
                }),
              ),
            ]),
          }),
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    expect(await reason(w.types())).toMatch(/not a document type name/);
  });
});

describe("the Prismic adapter: drafts", () => {
  it("with no token there is no key to ask about", async () => {
    const w = world({}, { env: { PRISMIC_REPOSITORY: REPOSITORY } });
    expect(await w.adapter.draftsReachable()).toBe("not-applicable");
    expect(w.seen).toEqual([]);
  });

  it("a release the token can see means unpublished work is reachable, from the refs alone", async () => {
    const w = world({ releaseToken: KEY });
    expect(await w.adapter.draftsReachable()).toBe(true);
    expect(w.seen.every((s) => !s.url.pathname.endsWith("/documents/search"))).toBe(true);
  });

  it("with a token but without checkReleases it does not look at the releases at all", async () => {
    const w = world({ releaseToken: KEY }, { settings: { id: "prismic" } });
    expect(await reason(w.adapter.draftsReachable())).toMatch(/checkReleases: true/);
    expect(w.seen).toEqual([]);
  });

  it("no release listed is could-not-check, never 'no'", async () => {
    const w = world({ releaseToken: KEY, releases: [] });
    expect(await reason(w.adapter.draftsReachable())).toMatch(/no release/);
  });
});

describe("the Prismic adapter: the master ref at the cache and at the origin", () => {
  it("the same ref on both hosts is a pass, read once each", async () => {
    const w = world();
    expect(await w.adapter.masterRefs()).toEqual({ state: "same" });
    expect(w.sleeps).toEqual([]);
  });

  it("a cache that stays behind is stale, judged by the newest document each ref shows", async () => {
    const w = world({ masterRef: (host) => (host === "cache" ? OLD_MASTER_REF : MASTER_REF) });
    const got = await w.adapter.masterRefs();
    expect(got).toEqual({
      state: "stale",
      cacheLatest: "2026-10-20T08:30:00.000Z",
      originLatest: "2026-11-03T12:00:00.000Z",
      originLatestId: "n-closed",
    });
    // The pair has to survive one wait longer than the cache's own five seconds.
    expect(w.sleeps).toEqual([6000, 6000]);
  });

  it("a cache that catches up during the wait is a pass, not a finding", async () => {
    const w = world({
      masterRef: (host, n) => (host === "cache" && n === 0 ? OLD_MASTER_REF : MASTER_REF),
    });
    expect(await w.adapter.masterRefs()).toEqual({ state: "same" });
    expect(w.sleeps).toEqual([6000]);
  });

  it("refs that keep changing are undetermined, never a finding", async () => {
    const w = world({
      masterRef: (host, n) =>
        host === "cache" ? (n % 2 === 0 ? OLD_MASTER_REF : RELEASE_REF) : MASTER_REF,
    });
    const got = await w.adapter.masterRefs();
    expect(got.state).toBe("undetermined");
    expect(got.reason).toMatch(/kept changing/);
  });

  it("two refs that differ with no newer document behind them are undetermined", async () => {
    const w = world({
      masterRef: (host) => (host === "cache" ? OLD_MASTER_REF : MASTER_REF),
      snapshots: { [MASTER_REF]: LARKSPUR, [OLD_MASTER_REF]: LARKSPUR },
    });
    const got = await w.adapter.masterRefs();
    expect(got.state).toBe("undetermined");
    expect(got.reason).toMatch(/cannot be said the cache is older/);
  });

  it("a ref that has expired is could-not-check", async () => {
    const w = world({
      masterRef: (host) => (host === "cache" ? OLD_MASTER_REF : MASTER_REF),
      expired: [OLD_MASTER_REF],
    });
    expect(await reason(w.adapter.masterRefs())).toMatch(/expired|410/);
  });

  it("an origin that does not answer is could-not-check", async () => {
    const w = world({}, {});
    const failing = createPrismicAdapter({
      env: { PRISMIC_REPOSITORY: REPOSITORY },
      fetcher: createFetcher({
        transport: (url, req) =>
          url.host === ORIGIN_HOST
            ? Promise.resolve({
                status: 503,
                headers: {},
                body: Readable.from([]),
              })
            : prismicTransport()(url, req),
        timeoutMs: 5000,
      }),
      sleep: noWait,
    });
    expect(await reason(failing.masterRefs())).toMatch(/503/);
    void w;
  });
});

describe("the Prismic adapter: releases", () => {
  it("finds a document whose copy in the release is older than the live one", async () => {
    const w = world({ releaseToken: KEY });
    const got = await w.adapter.releaseReadings({ ownerConsent: true });
    expect(got).toEqual([
      {
        id: RELEASE_ID,
        label: "Autumn retreat",
        state: "read",
        documents: 6,
        behind: [{ id: "c-evening", type: "classes" }],
      },
    ]);
  });

  it("a release with nothing behind the live copy has no finding", async () => {
    const w = world({
      releaseToken: KEY,
      snapshots: {
        [MASTER_REF]: LARKSPUR,
        [RELEASE_REF]: RELEASE_DOCS_CLEAN,
        [OLD_MASTER_REF]: LARKSPUR,
      },
    });
    const [rel] = await w.adapter.releaseReadings({ ownerConsent: true });
    expect(rel?.state).toBe("read");
    expect(rel?.behind).toEqual([]);
  });

  it("sends the token in a header to every release read, and never in an address", async () => {
    const w = world({ releaseToken: KEY });
    await w.adapter.releaseReadings({ ownerConsent: true });
    expect(w.seen.length).toBeGreaterThanOrEqual(4);
    for (const s of w.seen) {
      expect(s.headers.authorization).toBe(`Token ${KEY}`);
      expect(s.url.href).not.toContain(KEY);
    }
    expect(w.seen.some((s) => s.url.searchParams.get("ref") === RELEASE_REF)).toBe(true);
  });

  it("with no token it asks nothing", async () => {
    const w = world({}, { env: { PRISMIC_REPOSITORY: REPOSITORY } });
    expect(await reason(w.adapter.releaseReadings({ ownerConsent: true }))).toContain(
      "PRISMIC_ACCESS_TOKEN",
    );
    expect(w.seen).toEqual([]);
  });

  it("a release that cannot be listed is unread with its reason, and the others are still read", async () => {
    const w = world({
      releaseToken: KEY,
      releases: [
        { id: "rel-a", label: "Gone", ref: "Zgone~x" },
        { id: RELEASE_ID, label: "Autumn retreat", ref: RELEASE_REF },
      ],
    });
    const got = await w.adapter.releaseReadings({ ownerConsent: true });
    expect(got.map((g) => [g.id, g.state])).toEqual([
      ["rel-a", "unread"],
      [RELEASE_ID, "read"],
    ]);
    expect(got[0]?.reason).toMatch(/404|no such/);
  });

  it("more releases than the bound are unread by name, not skipped", async () => {
    const w = world(
      {
        releaseToken: KEY,
        releases: [
          { id: RELEASE_ID, label: "Autumn retreat", ref: RELEASE_REF },
          { id: "rel-z", label: "Winter", ref: "Zwinter~x" },
        ],
      },
      { maxReleases: 1 },
    );
    const got = await w.adapter.releaseReadings({ ownerConsent: true });
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({ id: "rel-z", state: "unread" });
    expect(got[1]?.reason).toMatch(/more than 1 releases/);
  });

  it("a publication between the reads starts the reading over once; a second one is unread, never a finding", async () => {
    const once = world({
      releaseToken: KEY,
      masterRef: (_h, n) => (n === 1 ? OLD_MASTER_REF : MASTER_REF),
    });
    const second = await once.adapter.releaseReadings({ ownerConsent: true });
    expect(second[0]?.state).toBe("read");
    // Every pair of reads sees the master ref move: the reading gives up.
    const always = world({
      releaseToken: KEY,
      masterRef: (_h, n) => (n % 2 === 1 ? OLD_MASTER_REF : MASTER_REF),
    });
    const got = await always.adapter.releaseReadings({ ownerConsent: true });
    expect(got.every((g) => g.state === "unread")).toBe(true);
    expect(got[0]?.behind).toEqual([]);
    expect(got[0]?.reason).toMatch(/published to while the release was read/);
  });

  it("a release read that the token may not make is unread", async () => {
    const w = world({ token: KEY, releaseToken: KEY });
    // The repository takes the token; the release ref answers 401 when it is missing, so a good token reads it.
    const [rel] = await w.adapter.releaseReadings({ ownerConsent: true });
    expect(rel?.state).toBe("read");
  });
});

describe("the settings", () => {
  it("checkReleases is accepted for prismic and for no other adapter", () => {
    expect(
      adaptersConfigSchema.safeParse({ adapters: [{ id: "prismic", checkReleases: true }] })
        .success,
    ).toBe(true);
    const other = adaptersConfigSchema.safeParse({
      adapters: [{ id: "sanity", checkReleases: true }],
    });
    expect(other.success).toBe(false);
  });

  it("is off unless the settings say so", () => {
    expect(world({}, { settings: { id: "prismic" } }).adapter.checkReleases()).toBe(false);
    expect(world().adapter.checkReleases()).toBe(true);
  });
});

describe("the Prismic adapter: review fixes", () => {
  it("a publication that reaches the cache only on the third read is not stale", async () => {
    const w = world({
      masterRef: (host, n) => (host === "cache" && n < 2 ? OLD_MASTER_REF : MASTER_REF),
    });
    expect(await w.adapter.masterRefs()).toEqual({ state: "same" });
    expect(w.sleeps).toEqual([6000, 6000]);
  });

  it("a different pair on the third read than on the first two is undetermined, never stale", async () => {
    const w = world({
      masterRef: (host, n) =>
        host === "cache" ? (n < 2 ? OLD_MASTER_REF : RELEASE_REF) : MASTER_REF,
    });
    const got = await w.adapter.masterRefs();
    expect(got.state).toBe("undetermined");
  });

  it("a release whose list shows nothing that differs from the live repository is could-not-check, never a pass", async () => {
    const w = world({
      releaseToken: KEY,
      snapshots: { [MASTER_REF]: LARKSPUR, [RELEASE_REF]: LARKSPUR, [OLD_MASTER_REF]: LARKSPUR },
    });
    const [rel] = await w.adapter.releaseReadings({ ownerConsent: true });
    expect(rel?.state).toBe("unread");
    expect(rel?.reason).toMatch(/cannot tell what the release holds/);
  });

  it("a release that lists a document the live repository does not have is read", async () => {
    const w = world({
      releaseToken: KEY,
      snapshots: {
        [MASTER_REF]: LARKSPUR,
        [RELEASE_REF]: RELEASE_DOCS_CLEAN,
        [OLD_MASTER_REF]: LARKSPUR,
      },
    });
    const [rel] = await w.adapter.releaseReadings({ ownerConsent: true });
    expect(rel?.state).toBe("read");
    expect(rel?.behind).toEqual([]);
  });

  it("releases are not read without the owner's consent or without the setting, and nothing is asked", async () => {
    const noConsent = world({ releaseToken: KEY });
    expect(await reason(noConsent.adapter.releaseReadings())).toMatch(/owner-consent/);
    expect(await reason(noConsent.adapter.releaseReadings({ ownerConsent: false }))).toMatch(
      /owner-consent/,
    );
    expect(noConsent.seen).toEqual([]);
    const noSetting = world({ releaseToken: KEY }, { settings: { id: "prismic" } });
    expect(await reason(noSetting.adapter.releaseReadings({ ownerConsent: true }))).toMatch(
      /checkReleases: true/,
    );
    expect(noSetting.seen).toEqual([]);
  });

  it.each([null, [], "text", 7])(
    "a document whose data is %j is could-not-check, never zero fields",
    async (data) => {
      const w = world({
        mangle: (body) => {
          const first = (body.results as Record<string, unknown>[])[0];
          if (first) first.data = data;
          return body;
        },
      });
      expect(await reason(w.adapter.fieldCounts("classes", ["name"]))).toMatch(/data/);
      const missing = world({
        mangle: (body) => {
          const first = (body.results as Record<string, unknown>[])[0];
          if (first) delete first.data;
          return body;
        },
      });
      expect(await reason(collectPublished(missing.adapter, { types: ["classes"] }))).toMatch(
        /data/,
      );
    },
  );

  it.each([".", ".."])(
    "a uid of %j is never given an address (it would resolve to another page)",
    async (uid) => {
      const w = world({
        mangle: (body) => {
          const first = (body.results as Record<string, unknown>[])[0];
          if (first) first.uid = uid;
          return body;
        },
      });
      const docs = (await collectPublished(w.adapter, { types: ["classes"] })).docs;
      expect(docs[0]?.url).toBeUndefined();
      expect(docs[1]?.url).toBe("/classes/evening-stretch");
    },
  );

  it("with no fingerprint the list is asked for whole documents, and only the header fields are kept", async () => {
    const w = world();
    const docs = (await collectPublished(w.adapter, { types: ["classes"] })).docs;
    for (const s of w.seen.filter((x) => x.url.pathname.endsWith("/documents/search")))
      expect(s.url.searchParams.has("fetch")).toBe(false);
    expect(JSON.stringify(docs)).not.toContain(PRISMIC_MARKERS.morning);
  });

  it("a page size reduced in the middle of a list does not make the list look as if it moved", async () => {
    const many: FixtureDoc[] = Array.from({ length: 120 }, (_, i) => ({
      id: `t-${String(i).padStart(3, "0")}`,
      uid: `teacher-${i}`,
      type: "teachers",
      lang: "en-us",
      first: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      last: "2026-02-01T00:00:00.000Z",
      data: { name: rich(`Teacher ${i}`) },
    }));
    const w = world(
      {
        mangle: (body, q, call) => {
          if (Number(q.get("pageSize")) === 100 && call >= 1)
            for (const r of body.results as { data: Record<string, unknown> }[])
              r.data = { ...r.data, pad: "x".repeat(400_000) };
          return body;
        },
      },
      {},
      many,
    );
    expect((await collectPublished(w.adapter, { types: ["teachers"] })).docs).toHaveLength(120);
  });

  it("a private repository that answers a missing token with 404 is read with the token", async () => {
    const w = world({ token: KEY, deniedAs404: true });
    expect((await w.adapter.types()).map((t) => t.name)).toEqual([
      "classes",
      "notices",
      "teachers",
    ]);
    expect(w.seen[0]?.headers.authorization).toBeUndefined();
    expect(w.seen[1]?.headers.authorization).toBe(`Token ${KEY}`);
  });

  it("a private repository that answers 404 and has no token says it may be private", async () => {
    const w = world({ token: KEY, deniedAs404: true }, { env: { PRISMIC_REPOSITORY: REPOSITORY } });
    expect(await reason(w.adapter.types())).toMatch(/private/);
  });

  it("an upper-case repository name is accepted and asks the lower-case host", async () => {
    const w = world({}, { env: { PRISMIC_REPOSITORY: "Larkspur-Yoga" } });
    await w.adapter.types();
    expect(new Set(w.seen.map((s) => s.url.host))).toEqual(new Set([CACHE_HOST]));
  });

  it("a redirect to another origin carries no Authorization header", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const inner = prismicTransport(LARKSPUR, { releaseToken: KEY });
    const adapter = createPrismicAdapter({
      env: { PRISMIC_REPOSITORY: REPOSITORY, PRISMIC_ACCESS_TOKEN: KEY },
      fetcher: createFetcher({
        transport: (url, req) => {
          seen.push({ url: url.href, headers: req.headers });
          if (url.host === CACHE_HOST && url.pathname === "/api/v2")
            return Promise.resolve({
              status: 302,
              headers: { location: "https://elsewhere.example/api/v2" },
              body: Readable.from([]),
            });
          if (url.host === "elsewhere.example")
            return inner(new URL(`https://${CACHE_HOST}/api/v2`), req);
          return inner(url, req);
        },
        timeoutMs: 5000,
      }),
      sleep: noWait,
      settings: { id: "prismic", checkReleases: true },
    });
    await adapter.draftsReachable().catch(() => undefined);
    const elsewhere = seen.filter((s) => s.url.includes("elsewhere.example"));
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const h of elsewhere) expect(h.headers.authorization).toBeUndefined();
    expect(seen.some((s) => s.url.includes(CACHE_HOST) && s.headers.authorization)).toBe(true);
  });
});
