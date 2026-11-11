import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createHubspotCmsAdapter, liveAddress } from "../hubspot-cms.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import {
  hubspotCmsTransport,
  hubspotData,
  type HubspotCmsFixtureOptions,
  type HubspotFixtureData,
} from "./hubspot-cms-fixture.js";

/**
 * What is particular to the HubSpot CMS adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out
 * once) are in the contract suite, which runs over this adapter's entry: no test here repeats them.
 */
const noWait = () => Promise.resolve();
const KEY = testKey("hubspot-adapter");

const make = (
  over: {
    data?: HubspotFixtureData;
    transport?: Transport;
    fixture?: HubspotCmsFixtureOptions;
    pageSize?: number;
    maxItemsPerType?: number;
    env?: Record<string, string>;
  } = {},
) =>
  createHubspotCmsAdapter({
    env: over.env ?? { HUBSPOT_CMS_TOKEN: KEY },
    fetcher: createFetcher({
      transport:
        over.transport ??
        hubspotCmsTransport(over.data ?? hubspotData(), { token: KEY, ...over.fixture }),
      timeoutMs: 5000,
    }),
    sleep: noWait,
    ...(over.pageSize !== undefined ? { pageSize: over.pageSize } : {}),
    ...(over.maxItemsPerType !== undefined ? { maxItemsPerType: over.maxItemsPerType } : {}),
  });

const body = (status: number, value: unknown) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(value))]),
  });

/** A site-pages list whose answers a test writes by hand. */
const listing =
  (answers: unknown[]): Transport =>
  (url) => {
    if (url.pathname !== "/cms/v3/pages/site-pages") return body(200, { total: 0, results: [] });
    const at = Number((url.searchParams.get("after") ?? "p0").slice(1));
    return body(200, answers[at]);
  };

const item = (id: string) => ({
  id,
  slug: `page-${id}`,
  state: "PUBLISHED",
  updated: "2026-11-01T00:00:00.000Z",
});

describe("the HubSpot CMS adapter: reading", () => {
  it("steps by the cursor and the size the server answers, whatever limit was asked", async () => {
    // The server clamps every page to one item: the list is still read to its real end.
    const clamped = (
      await collectPublished(make({ fixture: { clamp: 1 } }), { types: ["site-pages"] })
    ).docs;
    const normal = (await collectPublished(make(), { types: ["site-pages"] })).docs;
    expect(clamped.map((d) => d.id)).toEqual(["101", "102", "103"]);
    expect(clamped).toEqual(normal);
  });

  it("a list that ends before the total it reported is could-not-check, never a shorter list", async () => {
    const adapter = make({
      transport: listing([{ total: 5, results: [item("1"), item("2")] }]),
    });
    await expect(adapter.fieldCounts("site-pages", ["name"])).rejects.toThrow(AdapterCouldNotCheck);
    await expect(adapter.fieldCounts("site-pages", ["name"])).rejects.toMatchObject({
      reason: expect.stringMatching(/stopped after 2 of 5 items/),
    });
  });

  it("a hostile cursor (repeated, or not plain characters) stops the read", async () => {
    const repeat = make({
      transport: listing([
        { total: 99, results: [item("1")], paging: { next: { after: "p1" } } },
        { total: 99, results: [item("2")], paging: { next: { after: "p1" } } },
      ]),
    });
    await expect(repeat.fieldCounts("site-pages", ["name"])).rejects.toMatchObject({
      reason: expect.stringMatching(/cursor Gaugeline cannot follow/),
    });
    const odd = make({
      transport: listing([
        { total: 99, results: [item("1")], paging: { next: { after: "p1&include=everything" } } },
      ]),
    });
    await expect(odd.fieldCounts("site-pages", ["name"])).rejects.toMatchObject({
      reason: expect.stringMatching(/cursor Gaugeline cannot follow/),
    });
  });

  it("a server that never ends a list is stopped by the bound, whatever total it claims", async () => {
    const endless: Transport = (url) => {
      const n = Number((url.searchParams.get("after") ?? "p0").slice(1));
      return body(200, {
        total: 3,
        results: [item(`${n}a`), item(`${n}b`)],
        paging: { next: { after: `p${n + 1}` } },
      });
    };
    await expect(make({ transport: endless }).fieldCounts("site-pages", ["name"])).rejects.toThrow(
      AdapterCouldNotCheck,
    );
  });

  it("a list bigger than the bound is could-not-check, never a count of part of it", async () => {
    await expect(make({ maxItemsPerType: 1 }).fieldCounts("site-pages", ["name"])).rejects.toThrow(
      /has 4 items, more than 1,/,
    );
  });

  it("an empty page with a next cursor is could-not-check", async () => {
    const adapter = make({
      transport: listing([{ total: 4, results: [], paging: { next: { after: "p1" } } }]),
    });
    await expect(adapter.fieldCounts("site-pages", ["name"])).rejects.toMatchObject({
      reason: expect.stringMatching(/with more to come/),
    });
  });

  it("publishes only PUBLISHED, unarchived pages: a draft, a scheduled page and an archived one are not live", async () => {
    const data = hubspotData();
    const pages = data.pages["site-pages"];
    pages.push(
      {
        id: "105",
        slug: "later",
        state: "SCHEDULED",
        updated: "2026-11-01T00:00:00.000Z",
        fields: {},
      },
      {
        id: "106",
        slug: "old",
        state: "PUBLISHED",
        archived: true,
        updated: "2026-11-01T00:00:00.000Z",
        fields: {},
      },
    );
    const docs = (await collectPublished(make({ data }), { types: ["site-pages"] })).docs;
    expect(docs.map((d) => d.id)).toEqual(["101", "102", "103"]);
  });

  it("gives each page the address HubSpot gives, and a template from the settings wins", async () => {
    const docs = (await collectPublished(make(), { types: ["blog-posts"] })).docs;
    expect(docs.map((d) => d.url)).toEqual([
      "https://brass-whisk.example/blog/new-oven",
      "https://brass-whisk.example/blog/summer-hours",
    ]);
    expect(docs.map((d) => d.slug)).toEqual(["blog/new-oven", "blog/summer-hours"]);
  });

  it("ids, slugs and addresses from a response are checked before they are used", async () => {
    const data = hubspotData();
    const bad = data.pages["site-pages"][0];
    if (bad) bad.slug = "menu/../../admin";
    const odd = data.pages["site-pages"][1];
    if (odd) odd.url = ["https://user", "brass-whisk.example/about"].join("@");
    const docs = (await collectPublished(make({ data }), { types: ["site-pages"] })).docs;
    expect(docs.find((d) => d.id === "101")?.slug).toBeUndefined();
    expect(docs.find((d) => d.id === "102")?.url).toBeUndefined();
    expect(liveAddress("https://ok.example/x")?.href).toBe("https://ok.example/x");
    expect(liveAddress("//evil.example/x")).toBeUndefined();
    expect(liveAddress("http://ok.example/x")).toBeUndefined();
    expect(liveAddress("https://ok.example/\ud800")).toBeDefined();
    expect(liveAddress("\ud800")).toBeUndefined();

    const unsafeId = hubspotData();
    const first = unsafeId.pages["site-pages"][0];
    if (first) first.id = "1/../2";
    await expect(
      collectPublished(make({ data: unsafeId }), { types: ["site-pages"] }),
    ).rejects.toThrow(AdapterCouldNotCheck);
  });

  it("a HubDB table with an unsafe name from the response is could-not-check", async () => {
    const data = hubspotData();
    const table = data.tables[0];
    if (table) table.name = "loaves/../../x";
    await expect(make({ data }).types()).rejects.toThrow(AdapterCouldNotCheck);
  });

  it("an unknown list is could-not-check, never zero items", async () => {
    await expect(make().fieldCounts("hubdb.nothing", ["name"])).rejects.toThrow(
      AdapterCouldNotCheck,
    );
    await expect(collectPublished(make(), { types: ["hubdb.nothing"] })).rejects.toThrow(
      AdapterCouldNotCheck,
    );
    await expect(collectPublished(make(), { types: ["products"] })).rejects.toThrow(
      AdapterCouldNotCheck,
    );
  });

  it("types() leaves out a part the key may not read and still counts the others", async () => {
    const types = await make({ fixture: { denied: ["/cms/v3/hubdb"] } }).types();
    expect(types.map((t) => t.name)).toEqual(["blog-posts", "landing-pages", "site-pages"]);
  });

  it("a key that may read no part at all is could-not-check, not an empty site", async () => {
    const err: unknown = await make({
      fixture: { denied: ["/cms", "/account-info"] },
    })
      .types()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain("HTTP 403");
  });

  it("draftsReachable() finds a draft by seeing one, and says false only after reading the lists", async () => {
    expect(await make().draftsReachable()).toBe(true);
    const data = hubspotData();
    data.pages["site-pages"] = data.pages["site-pages"].filter((p) => p.state === "PUBLISHED");
    expect(await make({ data }).draftsReachable()).toBe(false);
  });

  it("a rate limit during published() carries what was already delivered", async () => {
    let n = 0;
    const inner = hubspotCmsTransport(hubspotData(), { token: KEY });
    const adapter = make({
      transport: (url, req) =>
        n++ >= 1 ? (body(429, {}) as ReturnType<Transport>) : inner(url, req),
    });
    const got = await collectPublished(adapter, { types: ["site-pages", "blog-posts"] });
    expect(got.partial?.reason).toBe("rate-limited");
    expect(got.docs).toHaveLength(3);
    await expect(adapter.types()).rejects.toBeInstanceOf(AdapterRateLimitedError);
  });

  it("asks for no property list, no archived pages and no expansion, whatever fields are named", async () => {
    const seen: string[] = [];
    const adapter = make({
      fixture: { onRequest: (_m, url) => seen.push(url.search) },
    });
    await collectPublished(adapter, {
      types: ["site-pages"],
      fields: { "site-pages": ["name", "metaDescription"] },
    });
    const query = seen.join("&");
    expect(query).not.toMatch(/properties|include|expand|archived|name|metaDescription/);
  });

  it("reads HubDB rows with only the columns asked for", async () => {
    const rows = await make().hubdbRows("loaves", ["price"]);
    expect(rows).toEqual([
      { id: "7001", path: "sourdough", columns: { price: 8.5 }, notCompared: [] },
      { id: "7002", path: "rye", columns: { price: 9.25 }, notCompared: [] },
      { id: "7003", path: "seeded", columns: {}, notCompared: [] },
    ]);
  });

  it("with no key set it says which variable to set and asks for nothing", async () => {
    const seen: string[] = [];
    const adapter = make({
      env: {},
      fixture: { onRequest: (_m, url) => seen.push(url.href) },
    });
    const err: unknown = await adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect((err as AdapterCouldNotCheck).reason).toContain("HUBSPOT_CMS_TOKEN");
    expect(seen).toEqual([]);
  });

  it("a 403 names the scope to add and never the key", async () => {
    const err: unknown = await make({ fixture: { denied: ["/cms"] } })
      .fieldCounts("site-pages", ["name"])
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as AdapterCouldNotCheck).reason).toMatch(/HTTP 403/);
    expect((err as AdapterCouldNotCheck).reason).not.toContain(KEY);
  });
});
