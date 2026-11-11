import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { collectPublished } from "../collect.js";
import { createStrapiAdapter } from "../strapi.js";
import { AdapterCouldNotCheck } from "../types.js";
import { recording, type Seen } from "./contract.js";
import {
  CMS_URL,
  strapiTransport,
  type StrapiFixtureCollection,
  type StrapiFixtureOptions,
} from "./strapi-fixture.js";

/** Cases an independent review of the Strapi adapter raised: a server that clamps the page size, one that ignores a parameter, and a hostile one. */
const KEY = testKey("strapi-review");
const ENV = { STRAPI_URL: CMS_URL, STRAPI_TOKEN: KEY };

/** `published` entries that went out, then `drafts` that never did, ids in order. */
function bar(published: number, drafts = 0): StrapiFixtureCollection[] {
  const entries = Array.from({ length: published + drafts }, (_, i) => ({
    id: i + 1,
    documentId: `doc-${String(i + 1).padStart(3, "0")}`,
    fields: { title: `Entry ${i + 1}`, slug: `entry-${i + 1}` },
    publishedAt: i < published ? "2026-10-01T09:00:00.000Z" : null,
    updatedAt: "2026-10-01T09:00:00.000Z",
  }));
  return [{ name: "events", entries }];
}

function over(
  content: readonly StrapiFixtureCollection[],
  fixture: StrapiFixtureOptions = {},
  settings: { fingerprint?: Record<string, string[]> } = {},
  transport?: Transport,
  headersFor?: (url: URL) => Record<string, string> | undefined,
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(transport ?? strapiTransport(content, { token: KEY, ...fixture }), seen),
    timeoutMs: 5000,
    ...(headersFor ? { headersFor } : {}),
  });
  const adapter = createStrapiAdapter({
    env: ENV,
    fetcher,
    settings: { id: "strapi", urls: { events: "/events/{slug}" }, ...settings },
    sleep: () => Promise.resolve(),
  });
  return { adapter, seen };
}

const json = (body: unknown) =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  }) as ReturnType<Transport>;

describe("a Strapi whose maxLimit is below the page size asked for", () => {
  it("published() reads every entry, stepping by the page size the answer reports", async () => {
    const { adapter } = over(bar(60), { maxPageSize: 25 });
    const { docs } = await collectPublished(adapter, { types: ["events"] });
    expect(docs).toHaveLength(60);
    expect(new Set(docs.map((d) => d.id)).size).toBe(60);
  });

  it("fieldCounts() counts all of them", async () => {
    const { adapter } = over(bar(60), { maxPageSize: 25 });
    expect(await adapter.fieldCounts("events", ["title"])).toEqual({ title: 60 });
  });

  it("publicDrafts() names exactly the entries that were never published, not published ones", async () => {
    const { adapter } = over(bar(60, 3), {
      maxPageSize: 25,
      publicPublished: ["events"],
      publicDrafts: ["events"],
    });
    const [got] = await adapter.publicDrafts();
    expect(got).toMatchObject({ state: "reachable", unpublished: 3 });
    expect(got?.ids).toEqual(["doc-061", "doc-062", "doc-063"]);
  });
});

describe("a Strapi 4 that ignores the parameter it does not know", () => {
  const leaky = { version: 4, ignoreUnknown: true, publicPublished: ["events"] } as const;

  it("the second spelling is tried when the first gives nothing extra: the leak is found", async () => {
    const { adapter, seen } = over(bar(2, 1), { ...leaky, publicDrafts: ["events"] });
    const [got] = await adapter.publicDrafts();
    expect(got).toMatchObject({ state: "reachable", unpublished: 1, ids: ["3"] });
    expect(seen.some((s) => s.url.includes("publicationState=preview"))).toBe(true);
    for (const s of seen) expect(s.headers.authorization).toBeUndefined();
  });

  it("with the token, unpublished work is reachable too", async () => {
    expect(await over(bar(2, 1), leaky).adapter.draftsReachable()).toBe(true);
  });

  it("a refusal of the spelling that works is 'refused', and a Strapi with nothing unpublished is 'nothing' with both spellings asked", async () => {
    const { adapter, seen } = over(bar(2, 1), { ...leaky, publicDrafts: [] });
    const [got] = await adapter.publicDrafts();
    expect(got?.state).toBe("refused");
    const { adapter: settled, seen: seen2 } = over(bar(2, 0), {
      ...leaky,
      publicDrafts: ["events"],
    });
    expect((await settled.publicDrafts())[0]?.state).toBe("nothing");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen2.some((s) => s.url.includes("status=draft"))).toBe(true);
    expect(seen2.some((s) => s.url.includes("publicationState=preview"))).toBe(true);
  });
});

describe("the visitor's requests", () => {
  it("a typo in a collection name is could-not-check, not 'private'", async () => {
    const typo = createStrapiAdapter({
      env: ENV,
      fetcher: createFetcher({
        transport: strapiTransport(bar(2), { token: KEY, publicPublished: ["evnts"] }),
        timeoutMs: 5000,
      }),
      settings: { id: "strapi", urls: { evnts: "/e/{slug}" } },
      sleep: () => Promise.resolve(),
    });
    const [got] = await typo.publicDrafts();
    expect(got?.state).toBe("unread");
    expect(got?.reason).toMatch(/404|no such collection/);
  });

  it("are sent as a visitor: nothing the fetcher adds per address (a preview secret) goes with them", async () => {
    const { adapter, seen } = over(
      bar(2, 1),
      { publicPublished: ["events"], publicDrafts: ["events"] },
      {},
      undefined,
      () => ({ "x-preview-secret": "not-for-visitors" }),
    );
    await adapter.publicDrafts();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.headers.authorization).toBeUndefined();
      expect(Object.keys(s.headers)).not.toContain("x-preview-secret");
    }
  });
});

describe("what published() asks Strapi for", () => {
  it("only the id, slug, dates and the fields to hash", async () => {
    const { adapter, seen } = over(bar(2), {}, { fingerprint: { events: ["title"] } });
    await collectPublished(adapter, { types: ["events"] });
    const params = new URL(seen[0]?.url ?? "").searchParams;
    const fields = [...params.entries()].filter(([k]) => k.startsWith("fields[")).map(([, v]) => v);
    expect(fields.sort()).toEqual(["publishedAt", "slug", "title", "updatedAt"]);
  });

  it("a field Strapi refuses (400) falls back to the whole row once, and the read still works", async () => {
    const { adapter, seen } = over(
      bar(2),
      { strictFields: true },
      { fingerprint: { events: ["title", "subtitle"] } },
    );
    const { docs } = await collectPublished(adapter, { types: ["events"] });
    expect(docs.map((d) => Object.keys(d.fieldHashes))).toEqual([["title"], ["title"]]);
    expect(seen).toHaveLength(2);
  });

  it("fieldCounts() asks for the fields it counts and the dates", async () => {
    const { adapter, seen } = over(bar(2));
    expect(await adapter.fieldCounts("events", ["title"])).toEqual({ title: 2 });
    const fields = [...new URL(seen[0]?.url ?? "").searchParams.entries()]
      .filter(([k]) => k.startsWith("fields["))
      .map(([, v]) => v);
    expect(fields.sort()).toEqual(["publishedAt", "title", "updatedAt"]);
  });
});

describe("a server that lies about its size", () => {
  const rows = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: from + i,
      documentId: `h-${from + i}`,
      updatedAt: "2026-10-01T09:00:00.000Z",
      slug: `h-${from + i}`,
    }));

  it("a total that grows with every page ends the read with could-not-check, in a bounded number of requests", async () => {
    let asked = 0;
    const endless: Transport = (url) => {
      asked++;
      const page = Number(url.searchParams.get("pagination[page]") ?? "1");
      return json({
        data: rows((page - 1) * 100, 100),
        meta: { pagination: { page, pageSize: 100, pageCount: page + 1, total: page * 100 + 50 } },
      });
    };
    const { adapter } = over([], {}, {}, endless);
    const err: unknown = await adapter.fieldCounts("events", ["slug"]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterCouldNotCheck);
    expect(asked).toBeLessThanOrEqual(110);
  });

  it("the draft check reads at most 500 ids from a list, however long the server makes it", async () => {
    let lists = 0;
    const hostile: Transport = (url) => {
      const q = url.searchParams;
      const drafts = q.has("status");
      if (q.get("pagination[pageSize]") === "1")
        return json({ data: rows(1, 1), meta: { pagination: { total: drafts ? 450 : 400 } } });
      lists++;
      const page = Number(q.get("pagination[page]") ?? "1");
      return json({
        data: rows((page - 1) * 100, 100),
        meta: { pagination: { page, pageSize: 100, pageCount: 9999, total: 450 + page * 100 } },
      });
    };
    const { adapter } = over([], {}, {}, hostile);
    const [got] = await adapter.publicDrafts();
    expect(got).toMatchObject({ state: "reachable", unpublished: 50, ids: [] });
    expect(lists).toBeLessThanOrEqual(14);
  });
});
