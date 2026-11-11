import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { adaptersConfigSchema } from "../config.js";
import { collectPublished } from "../collect.js";
import { createDatocmsAdapter, DATOCMS_CDA_QUERY, type DatocmsAdapter } from "../datocms.js";
import { AdapterCouldNotCheck, type AdapterSettings } from "../types.js";
import {
  DATOCMS_COLLECTIONS,
  DATOCMS_CONTENT,
  datocmsTransport,
  type DatocmsFixtureOptions,
} from "./datocms-fixture.js";

/**
 * What is particular to the DatoCMS adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but an allowlisted query, a refused key is could-not-check, a rate limit is waited out
 * once) are in the contract suite, which runs over this adapter's entry in entries.ts: no test here repeats them.
 */
const noWait = () => Promise.resolve();
const KEY = ["datocms", "adapter", "test0123456789abcdef"].join("_");

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
    fixture?: DatocmsFixtureOptions;
    sent?: Sent[];
  } = {},
): DatocmsAdapter {
  const sent = over.sent;
  return createDatocmsAdapter({
    env: { DATOCMS_TOKEN: KEY, ...over.env },
    fetcher: createFetcher({
      transport: datocmsTransport(undefined, {
        token: KEY,
        ...over.fixture,
        onRequest: (r) => {
          sent?.push({ method: r.method, url: r.url.href, headers: r.headers, body: r.body });
          over.fixture?.onRequest?.(r);
        },
      }),
      timeoutMs: 5000,
    }),
    settings: { id: "datocms", collections: DATOCMS_COLLECTIONS, ...over.settings },
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

describe("the DatoCMS adapter: the requests it builds", () => {
  it("sends one POSTed GraphQL query to the Content Delivery API, with the token in a header only", async () => {
    const sent: Sent[] = [];
    await collectPublished(make({ sent }), { types: ["classes"] });
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(r.method).toBe("POST");
      expect(r.url).toBe("https://graphql.datocms.com/");
      expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(r.headers["x-include-drafts"]).toBeUndefined();
      expect(r.headers["x-environment"]).toBeUndefined();
      expect(r.url).not.toContain(KEY);
      expect(r.body).not.toContain(KEY);
      const asked = JSON.parse(r.body) as { query: string };
      expect(asked.query.trimStart()).toMatch(/^query\b/);
      expect(asked.query).not.toMatch(/\b(mutation|subscription|__schema|__type)\b/);
    }
  });

  it("asks only the names the settings give, and a dotted field becomes a nested selection", async () => {
    const sent: Sent[] = [];
    const docs = (
      await collectPublished(
        make({
          sent,
          settings: { fingerprint: { classes: ["name", "seo.title"] } },
        }),
        { types: ["classes"] },
      )
    ).docs;
    const query = (JSON.parse(sent[0]?.body ?? "{}") as { query: string }).query;
    expect(query).toMatch(/allClasses\(first: 100, skip: 0, orderBy: \[id_ASC\]\)/);
    expect(query).toMatch(/seo\s*\{\s*title\s*\}/);
    expect(query).not.toContain("summary");
    expect(Object.keys(docs[0]?.fieldHashes ?? {}).sort()).toEqual(["name", "seo.title"]);
    expect(Object.keys(docs[1]?.fieldHashes ?? {})).toEqual(["name"]);
  });

  it("never asks for more than 500 records in a page, whatever page size is given", async () => {
    const sent: Sent[] = [];
    await make({ sent, pageSize: 5000 }).types();
    for (const r of sent)
      for (const m of (JSON.parse(r.body) as { query: string }).query.matchAll(/first: (\d+)/g))
        expect(Number(m[1])).toBeLessThanOrEqual(500);
  });

  it("only the registered allowlist entry is ever used, and it names the one host and path", () => {
    expect(DATOCMS_CDA_QUERY.host).toBe("graphql.datocms.com");
    expect(DATOCMS_CDA_QUERY.path).toBe("/");
    expect(DATOCMS_CDA_QUERY.body.kind).toBe("graphql-query");
    expect(Object.isFrozen(DATOCMS_CDA_QUERY)).toBe(true);
  });

  it("sends X-Environment only when DATOCMS_ENVIRONMENT names a sandbox, and refuses a name that is not plain", async () => {
    const sent: Sent[] = [];
    await make({ sent, env: { DATOCMS_ENVIRONMENT: "staging" } }).types();
    expect(sent[0]?.headers["x-environment"]).toBe("staging");
    const seen: Sent[] = [];
    const reason = await reasonOf(
      make({
        sent: seen,
        env: { DATOCMS_ENVIRONMENT: "staging\r\nX-Include-Drafts: true" },
      }).types(),
    );
    expect(reason).toContain("DATOCMS_ENVIRONMENT");
    expect(seen).toEqual([]);
  });
});

describe("the DatoCMS adapter: reading", () => {
  it("reads a list a page at a time and gives the same records as one big page", async () => {
    const small = (await collectPublished(make({ pageSize: 1 }), { types: ["classes"] })).docs;
    const big = (await collectPublished(make(), { types: ["classes"] })).docs;
    expect(small.map((d) => d.id)).toEqual(["1001", "1002"]);
    expect(small).toEqual(big);
  });

  it("gives a record's id, slug and times, and a url from the settings pattern", async () => {
    const { docs } = await collectPublished(
      make({ settings: { urls: { classes: "/classes/{slug}" } } }),
      { types: ["classes"] },
    );
    expect(docs[0]).toMatchObject({
      id: "1001",
      type: "classes",
      slug: "morning-flow",
      url: "/classes/morning-flow",
      publishedAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-20T08:30:00.000Z",
    });
  });

  it("lists the types the settings name, sorted, and nothing else: DatoCMS has no list of types to ask", async () => {
    expect((await make().types()).map((t) => t.name)).toEqual(["classes", "notices", "teachers"]);
  });

  it("only gives records changed since the time asked for", async () => {
    const { docs } = await collectPublished(make(), {
      types: ["classes"],
      since: "2026-11-01T00:00:00Z",
    });
    expect(docs.map((d) => d.id)).toEqual(["1002"]);
  });

  it("a type bigger than the bound is could-not-check, never a count of part of it", async () => {
    expect(await reasonOf(make({ maxItemsPerType: 1 }).fieldCounts("classes", ["name"]))).toMatch(
      /more than 1 record/,
    );
    expect(await reasonOf(make({ maxItemsPerType: 1 }).types())).toMatch(/more than 1 record/);
  });

  it("a page that is full is not the end: it asks for the next and stops at the first short one", async () => {
    const sent: Sent[] = [];
    await make({ sent, pageSize: 2 }).fieldCounts("classes", ["name"]);
    const skips = sent.map((r) => /skip: (\d+)/.exec(r.body)?.[1]);
    expect(skips).toEqual(["0", "2"]);
  });

  it("a record that appears on two pages is could-not-check: the list moved while it was read", async () => {
    const reason = await reasonOf(
      make({
        pageSize: 1,
        fixture: {
          override: (collection, skip) =>
            collection === "allClasses"
              ? [{ id: "1001", _updatedAt: "2026-10-20T08:30:00Z", skip }]
              : undefined,
        },
      }).fieldCounts("classes", ["name"]),
    );
    expect(reason).toMatch(/more than once/);
  });

  it("a record with no id or no update time is could-not-check, never made up", async () => {
    const reason = await reasonOf(
      collectPublished(make({ fixture: { override: () => [{ id: "7", name: "x" }] } }), {
        types: ["classes"],
      }),
    );
    expect(reason).toMatch(/no id or no update time/);
  });

  it("an answer with GraphQL errors is could-not-check and does not repeat the messages", async () => {
    const reason = await reasonOf(
      make({
        settings: { collections: { classes: { collection: "allNothing" } } },
      }).types(),
    );
    expect(reason).toMatch(/1 error/);
    expect(reason).not.toContain("Cannot query field");
  });

  it("a type the settings do not name is could-not-check and names the setting", async () => {
    expect(await reasonOf(make().fieldCounts("events", ["name"]))).toContain("collections");
  });

  it("with no collections in the settings it says what to add and asks for nothing", async () => {
    const sent: Sent[] = [];
    const adapter = make({ sent, settings: { collections: undefined } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("collections");
    expect(sent).toEqual([]);
  });

  it("a collection name that is not a plain GraphQL name is never put into a query", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(
      make({
        sent,
        settings: { collections: { classes: { collection: "allClasses { id } mutation { x" } } },
      }).types(),
    );
    expect(reason).toMatch(/not a plain GraphQL name/);
    expect(sent).toEqual([]);
  });

  it("with no key set it says which variable to set and asks for nothing", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(make({ sent, env: { DATOCMS_TOKEN: "" } }).types());
    expect(reason).toContain("DATOCMS_TOKEN");
    expect(sent).toEqual([]);
  });

  it("a token that is not accepted is could-not-check and says to check the token", async () => {
    const reason = await reasonOf(
      make({ env: { DATOCMS_TOKEN: "wrong-token-value-12345" } }).types(),
    );
    expect(reason).toMatch(/did not accept DATOCMS_TOKEN/);
    expect(reason).not.toContain("wrong-token-value-12345");
  });
});

describe("the DatoCMS adapter: can the token read drafts", () => {
  it("is true when a request that asks for drafts gets a record the published list does not have", async () => {
    const adapter = make();
    expect(await adapter.draftsReachable()).toBe(true);
    const read = await adapter.draftReading();
    expect(read.find((r) => r.type === "classes")).toMatchObject({
      state: "reachable",
      published: 2,
      extra: 1,
      extraIds: [],
    });
    expect(read.find((r) => r.type === "teachers")?.state).toBe("accepted-no-drafts");
  });

  it("sends X-Include-Drafts only on the draft read, and still only POSTs a query", async () => {
    const sent: Sent[] = [];
    await make({ sent }).draftsReachable();
    const withDrafts = sent.filter((r) => r.headers["x-include-drafts"] === "true");
    expect(withDrafts.length).toBeGreaterThan(0);
    expect(withDrafts.length).toBeLessThan(sent.length);
    for (const r of sent) expect(r.method).toBe("POST");
  });

  it("is false when DatoCMS refuses a request that asks for drafts (the token may not preview)", async () => {
    const adapter = make({ fixture: { drafts: "refused" } });
    expect(await adapter.draftsReachable()).toBe(false);
    expect((await adapter.draftReading()).every((r) => r.state === "refused")).toBe(true);
  });

  it("is could-not-check when drafts were accepted and nothing is unpublished: that is not a pass", async () => {
    const reason = await reasonOf(make({ fixture: { drafts: "ignored" } }).draftsReachable());
    expect(reason).toMatch(/no record that is not published/);
  });

  it("ids are held in a Set to subtract the published list from the draft list, so order and repeats do not matter", async () => {
    const reading = await make({
      pageSize: 1,
      settings: { showDraftIds: true },
    }).draftReading();
    expect(reading.find((r) => r.type === "classes")).toMatchObject({
      extra: 1,
      extraIds: ["1003"],
    });
  });

  it("never reads a draft's field values: the draft read asks for ids only", async () => {
    const sent: Sent[] = [];
    await make({
      sent,
      settings: { fingerprint: { classes: ["name", "summary"] } },
    }).draftsReachable();
    for (const r of sent.filter((x) => x.headers["x-include-drafts"] === "true")) {
      const query = (JSON.parse(r.body) as { query: string }).query;
      expect(query).not.toContain("name");
      expect(query).not.toContain("summary");
    }
  });
});

describe("the DatoCMS adapter: what the read must get right", () => {
  it("the first page asks for the collection's count, every page asks for an explicit order, and later pages ask no count", async () => {
    const sent: Sent[] = [];
    await make({ sent, pageSize: 1 }).fieldCounts("classes", ["name"]);
    const queries = sent.map((r) => (JSON.parse(r.body) as { query: string }).query);
    expect(queries[0]).toMatch(/_allClassesMeta\s*\{\s*count\s*\}/);
    for (const q of queries) expect(q).toMatch(/orderBy: \[id_ASC\]/);
    for (const q of queries.slice(1)) expect(q).not.toContain("_allClassesMeta");
  });

  it("a count that is not the number of records read is could-not-check", async () => {
    const reason = await reasonOf(
      make({ fixture: { countOverride: () => 5 } }).fieldCounts("classes", ["name"]),
    );
    expect(reason).toMatch(/has 5 records and 2 were read/);
  });

  it("a count that is not a whole number is could-not-check", async () => {
    const reason = await reasonOf(
      make({ fixture: { countOverride: () => -1 } }).fieldCounts("classes", ["name"]),
    );
    expect(reason).toMatch(/not a count of records/);
  });

  it("a count over the bound fails on the first page, before the rest is read", async () => {
    const sent: Sent[] = [];
    const reason = await reasonOf(
      make({
        sent,
        pageSize: 1,
        maxItemsPerType: 100,
        fixture: { countOverride: () => 10_000_000 },
      }).fieldCounts("classes", ["name"]),
    );
    expect(reason).toMatch(/more than 100 records/);
    expect(sent).toHaveLength(1);
  });

  it("records scanned count against the bound even when a limit and a since filter mean none is delivered", async () => {
    const reason = await reasonOf(
      collectPublished(make({ maxItemsPerType: 1 }), {
        types: ["classes"],
        limit: 5,
        since: "2030-01-01T00:00:00Z",
      }),
    );
    expect(reason).toMatch(/more than 1 record/);
  });

  it("a refusal of the draft list after its first page is could-not-check, never 'the token cannot read drafts'", async () => {
    const adapter = make({ pageSize: 1, fixture: { drafts: "refused-after-first-page" } });
    const read = await adapter.draftReading();
    const classes = read.find((r) => r.type === "classes");
    expect(classes?.state).toBe("unread");
    expect(classes?.reason).toMatch(/refused the draft read after answering its first page/);
    expect(read.some((r) => r.state === "refused")).toBe(false);
    expect(await reasonOf(adapter.draftsReachable())).toMatch(/refused the draft read after/);
  });

  it("a refusal of the first draft page is still the token that cannot read drafts", async () => {
    const read = await make({ pageSize: 1, fixture: { drafts: "refused" } }).draftReading();
    expect(read.every((r) => r.state === "refused")).toBe(true);
  });

  it("when drafts are found, the published list is read again; a list that changed in between is could-not-check", async () => {
    const records = DATOCMS_CONTENT.map((c) => ({
      ...c,
      records: c.records.map((r) => ({ ...r })),
    }));
    const adapter = createDatocmsAdapter({
      env: { DATOCMS_TOKEN: KEY },
      fetcher: createFetcher({
        transport: datocmsTransport(records, {
          token: KEY,
          onRequest: (r) => {
            // The retreat is published while the draft list is being read.
            if (r.headers["x-include-drafts"] === "true")
              for (const c of records)
                for (const rec of c.records) if (rec.id === "1003") rec.published = true;
          },
        }),
        timeoutMs: 5000,
      }),
      settings: { id: "datocms", collections: DATOCMS_COLLECTIONS },
      sleep: noWait,
    });
    const classes = (await adapter.draftReading()).find((r) => r.type === "classes");
    expect(classes?.state).toBe("unread");
    expect(classes?.reason).toMatch(/list changed during the read/);
  });

  it("a stable list is read again once when drafts are found, and not at all when there are none", async () => {
    const sent: Sent[] = [];
    await make({
      sent,
      settings: { collections: { classes: DATOCMS_COLLECTIONS.classes } },
    }).draftReading();
    // published, drafts, published again.
    expect(sent).toHaveLength(3);
    const none: Sent[] = [];
    await make({
      sent: none,
      settings: { collections: { teachers: DATOCMS_COLLECTIONS.teachers } },
    }).draftReading();
    expect(none).toHaveLength(2);
  });
});

describe("the DatoCMS settings", () => {
  const parse = (entry: Record<string, unknown>) =>
    adaptersConfigSchema.safeParse({ adapters: [entry] });

  it("accepts collections, expectPublishedOnly and showDraftIds for datocms", () => {
    expect(
      parse({
        id: "datocms",
        collections: { classes: { collection: "allClasses", slug: "slug" } },
        expectPublishedOnly: true,
        showDraftIds: true,
      }).success,
    ).toBe(true);
  });

  it("refuses a collection or slug that is not a plain GraphQL name", () => {
    expect(
      parse({ id: "datocms", collections: { a: { collection: "all Classes" } } }).success,
    ).toBe(false);
    expect(
      parse({ id: "datocms", collections: { a: { collection: "allA", slug: "a{b}" } } }).success,
    ).toBe(false);
  });

  it("refuses them for another adapter", () => {
    expect(parse({ id: "sanity", collections: { a: { collection: "allA" } } }).success).toBe(false);
    expect(parse({ id: "sanity", expectPublishedOnly: true }).success).toBe(false);
    expect(parse({ id: "sanity", showDraftIds: true }).success).toBe(false);
  });

  it("the fixture's content has the draft the tests rely on", () => {
    expect(DATOCMS_CONTENT[0]?.records.filter((r) => !r.published)).toHaveLength(1);
  });
});
