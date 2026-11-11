import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { adaptersConfigSchema } from "../config.js";
import { collectPublished } from "../collect.js";
import {
  createHygraphAdapter,
  HYGRAPH_API_QUERY,
  HYGRAPH_CDN_QUERY,
  parseHygraphEndpoint,
  type HygraphAdapter,
} from "../hygraph.js";
import { AdapterCouldNotCheck, type AdapterSettings } from "../types.js";
import {
  HYGRAPH_COLLECTIONS,
  HYGRAPH_CONTENT,
  HYGRAPH_HOST,
  HYGRAPH_URL,
  hygraphTransport,
  type HygraphFixtureOptions,
} from "./hygraph-fixture.js";

/**
 * What is particular to the Hygraph adapter. The rules every adapter shares (counts and fingerprints but never a
 * value, no request but an allowlisted query, a refused key is could-not-check, a rate limit is waited out once) are
 * in the contract suite, which runs over this adapter's entry: no test here repeats them.
 */
const noWait = () => Promise.resolve();
const KEY = ["hygraph", "adapter", "test0123456789abcdef"].join("_");

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function make(
  over: {
    pageSize?: number;
    maxItemsPerType?: number;
    settings?: Partial<AdapterSettings>;
    env?: Record<string, string>;
    fixture?: HygraphFixtureOptions;
    sent?: Sent[];
  } = {},
): HygraphAdapter {
  const sent = over.sent;
  return createHygraphAdapter({
    env: { HYGRAPH_TOKEN: KEY, HYGRAPH_ENDPOINT: HYGRAPH_URL, ...over.env },
    fetcher: createFetcher({
      transport: hygraphTransport(undefined, {
        token: KEY,
        ...over.fixture,
        onRequest: (r) => {
          sent?.push({ method: r.method, url: r.url.href, headers: r.headers, body: r.body });
          over.fixture?.onRequest?.(r);
        },
      }),
      timeoutMs: 5000,
    }),
    settings: { id: "hygraph", collections: HYGRAPH_COLLECTIONS, ...over.settings },
    sleep: noWait,
    ...(over.pageSize === undefined ? {} : { pageSize: over.pageSize }),
    ...(over.maxItemsPerType === undefined ? {} : { maxItemsPerType: over.maxItemsPerType }),
  });
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const queryOf = (r: Sent | undefined): string =>
  (JSON.parse(r?.body ?? "{}") as { query: string }).query;

describe("the Hygraph endpoint", () => {
  const good = [
    "https://api-eu-central-1.hygraph.com/v2/cm1pennywhistle0000bake01/master",
    "https://ap-south-1.cdn.hygraph.com/content/cm1pennywhistle0000bake01/master",
    "https://us-east-1-shared-usea1-02.cdn.hygraph.com/content/cm1pennywhistle0000bake01/staging",
  ];
  it.each(good)("accepts %s", (url) => {
    const parsed = parseHygraphEndpoint(url);
    expect(typeof parsed).toBe("object");
  });

  it("chooses the allowlist entry by path", () => {
    expect(parseHygraphEndpoint(good[0] ?? "")).toMatchObject({ allow: HYGRAPH_API_QUERY.id });
    expect(parseHygraphEndpoint(good[1] ?? "")).toMatchObject({ allow: HYGRAPH_CDN_QUERY.id });
  });

  const bad = [
    "",
    "not a url",
    "http://api-eu-central-1.hygraph.com/v2/cm1pennywhistle0000bake01/master",
    "https://hygraph.com/v2/cm1pennywhistle0000bake01/master",
    "https://api-eu-central-1.hygraph.com.attacker.example/v2/cm1pennywhistle0000bake01/master",
    "https://evil.example/v2/cm1pennywhistle0000bake01/master",
    "https://attacker@api-eu-central-1.hygraph.com/v2/cm1pennywhistle0000bake01/master",
    "https://api-eu-central-1.hygraph.com:8443/v2/cm1pennywhistle0000bake01/master",
    "https://api-eu-central-1.hygraph.com/v2/cm1pennywhistle0000bake01/master?x=1",
    "https://api-eu-central-1.hygraph.com/v2/cm1pennywhistle0000bake01/master#a",
    "https://api-eu-central-1.hygraph.com/v2/short/master",
    "https://api-eu-central-1.hygraph.com/v2/cm1pennywhistle0000bake01/master/extra",
    "https://api-eu-central-1.hygraph.com/v2/cm1pennywhistle0000bake01/..%2Fmaster",
    "https://api-eu-central-1.hygraph.com/other/cm1pennywhistle0000bake01/master",
    "https://127.0.0.1/v2/cm1pennywhistle0000bake01/master",
    "https://api-eu-central-1.graphcms.com/v2/cm1pennywhistle0000bake01/master",
    `https://${"a-".repeat(80)}a.cdn.hygraph.com/content/cm1pennywhistle0000bake01/master`,
  ];
  it.each(bad)("refuses %s, without repeating it", (url) => {
    const parsed = parseHygraphEndpoint(url);
    expect(typeof parsed).toBe("string");
    if (url.length > 3) expect(parsed).not.toContain(url);
  });

  it("a long run of hyphens in the host does not take long to refuse", () => {
    const t = Date.now();
    parseHygraphEndpoint(`https://api-${"a-".repeat(120)}!.hygraph.com/v2/x/y`);
    parseHygraphEndpoint(`https://${"a-".repeat(120)}!.cdn.hygraph.com/v2/x/y`);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("a bad endpoint is could-not-check and the token goes nowhere", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(
      make({
        sent,
        env: { HYGRAPH_ENDPOINT: "https://evil.example/v2/cm1pennywhistle0000bake01/master" },
      }).types(),
    );
    expect(reason).toContain("HYGRAPH_ENDPOINT");
    expect(sent).toEqual([]);
  });

  it("with no endpoint set it says which variable to set and asks for nothing", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(make({ sent, env: { HYGRAPH_ENDPOINT: "" } }).types());
    expect(reason).toContain("HYGRAPH_ENDPOINT");
    expect(sent).toEqual([]);
  });
});

describe("the Hygraph adapter: the requests it builds", () => {
  it("sends one POSTed GraphQL query to the project's endpoint, with the token in a header only", async () => {
    const sent: Sent[] = [];
    await collectPublished(make({ sent }), { types: ["pages"] });
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(r.method).toBe("POST");
      expect(r.url).toBe(HYGRAPH_URL);
      expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(r.url).not.toContain(KEY);
      expect(r.body).not.toContain(KEY);
      const query = queryOf(r);
      expect(query.trimStart()).toMatch(/^query\b/);
      expect(query).not.toMatch(/\b(mutation|subscription|__schema|__type)\b/);
    }
  });

  it("always names the PUBLISHED stage and never the DRAFT one, for every shared read", async () => {
    const sent: Sent[] = [];
    const adapter = make({ sent });
    await adapter.types();
    await adapter.fieldCounts("pages", ["title"]);
    await collectPublished(adapter);
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      const q = queryOf(r);
      expect(q).toContain("stage: PUBLISHED");
      expect(q).not.toContain("DRAFT");
    }
  });

  it("asks only the names the settings give, and a dotted field becomes a nested selection", async () => {
    const sent: Sent[] = [];
    const docs = (
      await collectPublished(
        make({ sent, settings: { fingerprint: { pages: ["title", "seo.title"] } } }),
        { types: ["pages"] },
      )
    ).docs;
    const query = queryOf(sent[0]);
    expect(query).toMatch(/pages\(first: 100, skip: 0, stage: PUBLISHED, orderBy: id_ASC\)/);
    expect(query).toMatch(/seo\s*\{\s*title\s*\}/);
    expect(query).not.toContain("summary");
    expect(Object.keys(docs[0]?.fieldHashes ?? {}).sort()).toEqual(["seo.title", "title"]);
    expect(Object.keys(docs[1]?.fieldHashes ?? {})).toEqual(["title"]);
  });

  it("never asks for more than 1000 entries in a page, whatever page size is given", async () => {
    const sent: Sent[] = [];
    await make({ sent, pageSize: 50_000 }).types();
    for (const r of sent)
      for (const m of queryOf(r).matchAll(/first: (\d+)/g))
        expect(Number(m[1])).toBeLessThanOrEqual(1000);
  });

  it("the registered entries take the configured host and one path pattern each, over a query body", () => {
    expect(HYGRAPH_API_QUERY.host).toEqual({ configured: "HYGRAPH_ENDPOINT" });
    expect(HYGRAPH_CDN_QUERY.host).toEqual({ configured: "HYGRAPH_ENDPOINT" });
    expect(HYGRAPH_API_QUERY.path).toBe("/v2/*/*");
    expect(HYGRAPH_CDN_QUERY.path).toBe("/content/*/*");
    for (const a of [HYGRAPH_API_QUERY, HYGRAPH_CDN_QUERY]) {
      expect(a.body.kind).toBe("graphql-query");
      expect(Object.isFrozen(a)).toBe(true);
    }
  });

  it("the host in the endpoint is the host the request goes to", async () => {
    const sent: Sent[] = [];
    await make({ sent }).types();
    expect(new URL(sent[0]?.url ?? "").host).toBe(HYGRAPH_HOST);
  });
});

describe("the Hygraph adapter: reading", () => {
  it("reads a list a page at a time and gives the same entries as one big page", async () => {
    const small = (await collectPublished(make({ pageSize: 1 }), { types: ["pages"] })).docs;
    const big = (await collectPublished(make(), { types: ["pages"] })).docs;
    expect(small).toEqual(big);
    expect(big.map((d) => d.id)).toEqual(["cm1page000000000home001", "cm1page000000000menu002"]);
  });

  it("gives an entry's id, slug and times, and a url from the settings pattern", async () => {
    const { docs } = await collectPublished(make({ settings: { urls: { pages: "/{slug}" } } }), {
      types: ["pages"],
    });
    expect(docs[0]).toMatchObject({
      id: "cm1page000000000home001",
      type: "pages",
      slug: "home",
      url: "/home",
      publishedAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-20T08:30:00.000Z",
    });
  });

  it("an address pattern that does not give one path on this site is no address", async () => {
    const { docs } = await collectPublished(
      make({ settings: { urls: { pages: "//other.example/{slug}" } } }),
      { types: ["pages"] },
    );
    expect(docs[0]?.url).toBeUndefined();
  });

  it("lists the types the settings name, sorted, and nothing else", async () => {
    expect((await make().types()).map((t) => t.name)).toEqual(["events", "pages"]);
  });

  it("only gives entries changed since the time asked for", async () => {
    const { docs } = await collectPublished(make(), {
      types: ["pages"],
      since: "2026-11-01T00:00:00Z",
    });
    expect(docs.map((d) => d.slug)).toEqual(["menu"]);
  });

  it("a type bigger than the bound is could-not-check, never a count of part of it", async () => {
    const reason = await reasonOf(make({ maxItemsPerType: 1 }).types());
    expect(reason).toContain("more than 1 entry");
  });

  it("a page that is full is not the end: it asks for the next and stops at the first short one", async () => {
    const sent: Sent[] = [];
    await make({ sent, pageSize: 2 }).fieldCounts("pages", ["title"]);
    const skips = sent.map((r) => /skip: (\d+)/.exec(queryOf(r))?.[1]);
    expect(skips).toEqual(["0", "2"]);
  });

  it("an entry that appears on two pages is could-not-check: the list moved while it was read", async () => {
    const reason = await reasonOf(
      make({
        pageSize: 1,
        fixture: {
          override: (collection, skip) =>
            collection === "pages" && skip === 1
              ? [{ id: "cm1page000000000home001", updatedAt: "2026-10-20T08:30:00.000Z" }]
              : undefined,
        },
      }).types(),
    );
    expect(reason).toContain("more than once");
  });

  it("an entry with no id or no update time is could-not-check, never made up", async () => {
    const noId = await reasonOf(
      collectPublished(
        make({
          fixture: {
            override: (c) => (c === "pages" ? [{ updatedAt: "2026-10-20T08:30:00Z" }] : undefined),
          },
        }),
        { types: ["pages"] },
      ),
    );
    expect(noId).toContain("no id");
    const noTime = await reasonOf(
      collectPublished(
        make({ fixture: { override: (c) => (c === "pages" ? [{ id: "x1" }] : undefined) } }),
        { types: ["pages"] },
      ),
    );
    expect(noTime).toContain("no update time");
  });

  it("an answer with GraphQL errors is could-not-check and does not repeat the messages", async () => {
    const reason = await reasonOf(
      make({ settings: { collections: { pages: { collection: "nope", slug: "slug" } } } }).types(),
    );
    expect(reason).toContain("error");
    expect(reason).not.toContain("Cannot query field");
  });

  it("an HTTP 400 or 500 is could-not-check with the status", async () => {
    const adapter = createHygraphAdapter({
      env: { HYGRAPH_TOKEN: KEY, HYGRAPH_ENDPOINT: HYGRAPH_URL },
      fetcher: createFetcher({
        transport: () =>
          Promise.resolve({ status: 500, headers: {}, body: (async function* () {})() as never }),
        timeoutMs: 5000,
      }),
      settings: { id: "hygraph", collections: HYGRAPH_COLLECTIONS },
      sleep: noWait,
    });
    expect(await reasonOf(adapter.types())).toContain("HTTP 500");
  });

  it("a type the settings do not name is could-not-check and names the setting", async () => {
    expect(await reasonOf(make().fieldCounts("recipes", ["title"]))).toContain("collections");
  });

  it("with no models in the settings it says what to add and asks for nothing", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(make({ sent, settings: { collections: undefined } }).types());
    expect(reason).toContain("collections");
    expect(sent).toEqual([]);
  });

  it("a collection name that is not a plain GraphQL name is never put into a query", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(
      make({
        sent,
        settings: {
          collections: { pages: { collection: "pages) { id } } mutation M { x", slug: "slug" } },
        },
      }).types(),
    );
    expect(reason).toContain("plain GraphQL name");
    expect(sent).toEqual([]);
  });

  it("a field name that is not a plain GraphQL name is never put into a query", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(make({ sent }).fieldCounts("pages", ["title } } mutation"]));
    expect(reason).toContain("plain GraphQL name");
    expect(sent).toEqual([]);
  });

  it("with no token set it says which variable to set and asks for nothing", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(make({ sent, env: { HYGRAPH_TOKEN: "" } }).types());
    expect(reason).toContain("HYGRAPH_TOKEN");
    expect(sent).toEqual([]);
  });

  it("a token with a newline in it is refused before anything is sent", async () => {
    const sent: Sent[] = [];
    await reasonOf(make({ sent, env: { HYGRAPH_TOKEN: "abc\r\nX-Other: 1" } }).types());
    expect(sent).toEqual([]);
  });

  it("a token that is not accepted is could-not-check and says to check the token", async () => {
    const reason = await reasonOf(make({ env: { HYGRAPH_TOKEN: "another-token-value" } }).types());
    expect(reason).toContain("HYGRAPH_TOKEN");
    expect(reason).not.toContain("another-token-value");
  });
});

describe("the Hygraph adapter: what the read must get right", () => {
  it("the first page asks the model's count, every page asks an explicit order, and later pages ask no count", async () => {
    const sent: Sent[] = [];
    await make({ sent, pageSize: 1 }).fieldCounts("pages", ["title"]);
    expect(queryOf(sent[0])).toContain("pagesConnection(stage: PUBLISHED) { aggregate { count } }");
    for (const r of sent.slice(1)) expect(queryOf(r)).not.toContain("Connection");
    for (const r of sent) expect(queryOf(r)).toContain("orderBy: id_ASC");
  });

  it("a count that is not the number of entries read is could-not-check", async () => {
    const reason = await reasonOf(
      make({ fixture: { countOverride: (c) => (c === "pages" ? 5 : undefined) } }).types(),
    );
    expect(reason).toContain("said the model has 5");
  });

  it("a count that is not a whole number is could-not-check", async () => {
    const reason = await reasonOf(make({ fixture: { countOverride: () => 1.5 } }).types());
    expect(reason).toContain("not a count");
  });

  it("a count over the bound fails on the first page, before the rest is read", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(
      make({ sent, maxItemsPerType: 3, fixture: { countOverride: () => 50 } }).types(),
    );
    expect(reason).toContain("more than 3");
    expect(sent).toHaveLength(1);
  });

  it("entries scanned count against the bound even when a limit and a since filter mean none is delivered", async () => {
    const reason = await reasonOf(
      collectPublished(make({ maxItemsPerType: 1 }), {
        types: ["pages"],
        limit: 5,
        since: "2030-01-01T00:00:00Z",
      }),
    );
    expect(reason).toContain("more than 1");
  });
});

describe("the Hygraph adapter: the DRAFT stage", () => {
  const draft = { settings: { readDraftStage: true } };

  it("is never read unless the settings say readDraftStage: true, and then asks nothing", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(make({ sent }).unpublishedReading());
    expect(reason).toContain("readDraftStage");
    expect(sent).toEqual([]);
  });

  it("finds the entry that is in DRAFT and not in PUBLISHED, as an id and a slug", async () => {
    const reads = await make(draft).unpublishedReading();
    const pages = reads.find((r) => r.type === "pages");
    expect(pages).toMatchObject({ state: "read", published: 2, unpublished: 1 });
    expect(pages?.entries).toEqual([{ id: "cm1page000000000supp003", slug: "winter-supper-club" }]);
    expect(reads.find((r) => r.type === "events")).toMatchObject({ state: "read", unpublished: 0 });
  });

  it("asks the DRAFT stage for the id and the slug field only, never a field of a draft", async () => {
    const sent: Sent[] = [];
    await make({ ...draft, sent }).unpublishedReading();
    const drafts = sent.map(queryOf).filter((q) => q.includes("stage: DRAFT"));
    expect(drafts.length).toBeGreaterThan(0);
    for (const q of drafts) {
      expect(q).not.toMatch(/\b(title|summary|seo)\b/);
      expect(q).toMatch(/\{ id slug \} \}$/);
    }
    for (const r of sent) expect(r.method).toBe("POST");
  });

  it("the published list is read again when something is found, and a list that changed is could-not-check", async () => {
    let publishedReads = 0;
    const reads = await make({
      ...draft,
      fixture: {
        onRequest: (r) => {
          const q = (JSON.parse(r.body) as { query: string }).query;
          if (q.includes("pages(first") && q.includes("stage: PUBLISHED")) publishedReads++;
        },
        // The second read of the published list of pages has one entry fewer, with a count that agrees.
        override: (collection, _skip, stage) =>
          collection === "pages" && stage === "PUBLISHED" && publishedReads >= 2
            ? [{ id: "cm1page000000000home001" }]
            : undefined,
        countOverride: (collection, stage) =>
          collection === "pages" && stage === "PUBLISHED" && publishedReads >= 2 ? 1 : undefined,
      },
    }).unpublishedReading();
    const pages = reads.find((r) => r.type === "pages");
    expect(pages?.state).toBe("unread");
    expect(pages?.reason).toContain("changed during the read");
  });

  it("a stable published list is read again once when something is found, and not at all when nothing is", async () => {
    const sent: Sent[] = [];
    await make({ ...draft, sent }).unpublishedReading();
    const publishedPages = sent
      .map(queryOf)
      .filter((q) => q.includes("pages(first") && q.includes("stage: PUBLISHED"));
    // Once for the list, once for the re-read, once more for the slugs; events has nothing unpublished.
    expect(publishedPages).toHaveLength(3);
    const publishedEvents = sent
      .map(queryOf)
      .filter((q) => q.includes("events(first") && q.includes("stage: PUBLISHED"));
    expect(publishedEvents).toHaveLength(1);
  });

  it("a token limited to PUBLISHED (HTTP 403 on the first DRAFT page) is 'refused', and the other model is still read", async () => {
    const reads = await make({
      ...draft,
      fixture: { draftStage: "refused-http" },
    }).unpublishedReading();
    expect(reads.map((r) => r.state)).toEqual(["refused", "refused"]);
    expect(reads[0]?.published).toBeGreaterThan(0);
  });

  it("a GraphQL error on the first DRAFT page, after the PUBLISHED page was answered, is 'refused'", async () => {
    const reads = await make({
      ...draft,
      fixture: { draftStage: "refused-errors" },
    }).unpublishedReading();
    expect(reads.every((r) => r.state === "refused")).toBe(true);
  });

  it("a refusal after the first DRAFT page is could-not-check, never 'the token cannot read DRAFT'", async () => {
    const reads = await make({
      ...draft,
      pageSize: 1,
      fixture: { draftStage: "refused-after-first-page" },
    }).unpublishedReading();
    const pages = reads.find((r) => r.type === "pages");
    expect(pages?.state).toBe("unread");
    expect(pages?.reason).toContain("after answering its first page");
  });

  it("an error on the PUBLISHED stage is 'unread', not 'refused': a wrong model name is not a token that cannot read DRAFT", async () => {
    const reads = await make({
      settings: {
        readDraftStage: true,
        collections: { pages: { collection: "nope", slug: "slug" } },
      },
    }).unpublishedReading();
    expect(reads[0]?.state).toBe("unread");
  });

  it("an unpublished entry with the same slug as a published one is reported as sharing it", async () => {
    const content = structuredClone(HYGRAPH_CONTENT);
    const pages = content[0];
    if (pages === undefined) throw new Error("fixture");
    pages.entries.push({
      id: "cm1page000000000copy004",
      slug: "menu",
      published: false,
      updatedAt: "2026-11-10T10:00:00.000Z",
      fields: {},
    });
    const adapter = createHygraphAdapter({
      env: { HYGRAPH_TOKEN: KEY, HYGRAPH_ENDPOINT: HYGRAPH_URL },
      fetcher: createFetcher({
        transport: hygraphTransport(content, { token: KEY }),
        timeoutMs: 5000,
      }),
      settings: { id: "hygraph", collections: HYGRAPH_COLLECTIONS, ...draft.settings },
      sleep: noWait,
    });
    const read = (await adapter.unpublishedReading()).find((r) => r.type === "pages");
    expect(read?.sharedSlugs).toEqual(["menu"]);
  });

  it("never reads a model more than the bound: DRAFT counts against it too", async () => {
    const reads = await make({ ...draft, maxItemsPerType: 2 }).unpublishedReading();
    const pages = reads.find((r) => r.type === "pages");
    expect(pages?.state).toBe("unread");
  });

  it("ids and slugs that are not plain are not passed on", async () => {
    const reads = await make({
      ...draft,
      fixture: {
        override: (c, _s, stage) =>
          c === "pages" && stage === "DRAFT"
            ? [{ id: "bad id with spaces", slug: "x y" }]
            : undefined,
        countOverride: (c, stage) => (c === "pages" && stage === "DRAFT" ? 1 : undefined),
      },
    }).unpublishedReading();
    const pages = reads.find((r) => r.type === "pages");
    expect(pages?.unpublished).toBe(1);
    expect(pages?.entries).toEqual([]);
  });
});

describe("the Hygraph settings", () => {
  const parse = (entry: Record<string, unknown>) =>
    adaptersConfigSchema.safeParse({ adapters: [entry] });

  it("accepts collections and readDraftStage for hygraph", () => {
    expect(
      parse({ id: "hygraph", collections: HYGRAPH_COLLECTIONS, readDraftStage: true }).success,
    ).toBe(true);
  });

  it("refuses a collection or slug that is not a plain GraphQL name", () => {
    expect(
      parse({ id: "hygraph", collections: { pages: { collection: "pages { id }" } } }).success,
    ).toBe(false);
    expect(
      parse({ id: "hygraph", collections: { pages: { collection: "pages", slug: "a-b" } } })
        .success,
    ).toBe(false);
  });

  it("refuses them for another adapter", () => {
    expect(parse({ id: "wix", collections: HYGRAPH_COLLECTIONS }).success).toBe(false);
    expect(parse({ id: "wix", readDraftStage: true }).success).toBe(false);
  });

  it("the fixture's content has the unpublished entry the tests rely on", () => {
    const pages = HYGRAPH_CONTENT.find((c) => c.type === "pages");
    expect(pages?.entries.filter((e) => !e.published)).toHaveLength(1);
  });
});
