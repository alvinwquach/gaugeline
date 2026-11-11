import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createContentfulRegistry } from "../../checks/contentful.js";
import { runChecks } from "../../run.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import {
  CONTENTFUL_CDA,
  CONTENTFUL_CPA,
  CONTENTFUL_DESCRIPTION,
  createContentfulAdapter,
  type ContentfulAdapterOptions,
} from "../contentful.js";
import { readContentful } from "../contentful-read.js";
import { hashValue } from "../fingerprint.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapters } from "../registry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  ASH,
  ASH_SITE,
  ASH_URLS,
  CONTENTFUL_MARKERS,
  PAGES_DRIFT,
  PAGES_HEALTHY,
  SPACE_ID,
  contentfulTransport,
  type ContentfulFixtureOptions,
} from "./contentful-fixture.js";

const KEY = testKey("contentful-unit");
const PREVIEW_KEY = testKey("contentful-preview-unit");
const ENV = { CONTENTFUL_SPACE_ID: SPACE_ID, CONTENTFUL_DELIVERY_TOKEN: KEY };
const SETTINGS = { id: "contentful", urls: ASH_URLS, fingerprint: { event: ["title", "summary"] } };

function over(
  options: {
    fixture?: ContentfulFixtureOptions;
    adapter?: Partial<ContentfulAdapterOptions>;
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(
      options.transport ?? contentfulTransport(ASH, { token: KEY, ...options.fixture }),
      seen,
    ),
    timeoutMs: 5000,
  });
  const adapter = createContentfulAdapter({
    env: ENV,
    fetcher,
    settings: SETTINGS,
    sleep: () => Promise.resolve(),
    ...options.adapter,
  });
  return { adapter, fetcher, seen };
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

async function findings(pages: Readonly<Record<string, number>>) {
  const { adapter, fetcher } = over({ fixture: { pages } });
  const reading = await readContentful({ adapter, fetcher, site: ASH_SITE });
  return { reading, result: await runChecks(reading, createContentfulRegistry()) };
}

describe("the Contentful adapter: what it asks and how", () => {
  it("is registered, described as read-only, and no longer planned", () => {
    expect(BUILT_ADAPTERS.get("contentful")?.describe).toEqual(CONTENTFUL_DESCRIPTION);
    expect(PLANNED_ADAPTERS.some((p) => p.id === "contentful")).toBe(false);
    expect(CONTENTFUL_DESCRIPTION.keyKind).toBe("read-only");
    expect(adapterHeader(CONTENTFUL_DESCRIPTION)).toContain("a read-only key");
    const config = adaptersConfigSchema.parse({ adapters: [SETTINGS] });
    const [adapter] = createAdapters(config, { env: ENV, fetcher: over().fetcher });
    expect(adapter?.id).toBe("contentful");
  });

  it("asks only the Delivery API, only with GET, with the token in a header and never in an address", async () => {
    const { adapter, seen } = over();
    await adapter.types();
    await adapter.fieldCounts("event", ["title"]);
    await collectPublished(adapter);
    await adapter.draftsReachable();
    expect(seen.length).toBeGreaterThan(5);
    expect(requestProblems(seen)).toEqual([]);
    for (const s of seen) {
      expect(s.url.startsWith(`${CONTENTFUL_CDA}/spaces/${SPACE_ID}/environments/master/`)).toBe(
        true,
      );
      expect(s.url).not.toContain(KEY);
      expect(s.url.toLowerCase()).not.toContain("access_token");
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it("asks for the system part and only the fields it needs, never a field the type does not have", async () => {
    const { adapter, seen } = over();
    const docs = (await collectPublished(adapter, { types: ["event"] })).docs;
    const urls = seen.map((s) => decodeURIComponent(s.url));
    const entries = urls.find((u) => u.includes("/entries?content_type=event"));
    expect(entries).toContain("select=sys,fields.title,fields.summary,fields.slug");
    expect(entries).toContain("order=sys.createdAt");
    // The fixture answers 400 to a select of a field the type lacks: the read above would have failed.
    expect(docs.map((d) => d.slug)).toEqual(["quiz-night", "brewers-dinner"]);
    expect(docs.map((d) => d.url)).toEqual(["/events/quiz-night", "/events/brewers-dinner"]);
    // A content type with no `slug` field gives no slug and no address, not a made-up one.
    const t = (await collectPublished(adapter, { types: ["testimonial"] })).docs;
    expect(t.every((d) => d.slug === undefined && d.url === undefined)).toBe(true);
  });

  it("gives fingerprints: ids, update times and field hashes, never the words", async () => {
    const { adapter } = over();
    const docs = (await collectPublished(adapter, { types: ["event"] })).docs;
    expect(docs[0]).toEqual({
      id: "ev-trivia",
      type: "event",
      url: "/events/quiz-night",
      slug: "quiz-night",
      updatedAt: "2026-10-20T09:00:00.000Z",
      fieldHashes: {
        title: hashValue(CONTENTFUL_MARKERS.trivia),
        summary: hashValue(CONTENTFUL_MARKERS.triviaSummary),
      },
    });
    expect(JSON.stringify(docs)).not.toContain("Quiz night");
    expect(Object.keys(docs[1]?.fieldHashes ?? {})).toEqual(["title"]);
  });

  it("reads a long list a page at a time, to its total", async () => {
    const { adapter, seen } = over({ adapter: { pageSize: 2 } });
    const docs = (await collectPublished(adapter, { types: ["beer"] })).docs;
    expect(docs.map((d) => d.id)).toEqual(["beer-amber", "beer-stout", "beer-hazy"]);
    const skips = seen.filter((s) => s.url.includes("content_type=beer")).map((s) => s.url);
    expect(skips.some((u) => u.includes("skip=0") && u.includes("limit=2"))).toBe(true);
    expect(skips.some((u) => u.includes("skip=2"))).toBe(true);
  });

  it("a type with more entries than the bound is could-not-check, never a count of part of it", async () => {
    const { adapter } = over({ adapter: { maxEntriesPerType: 2 } });
    expect(await reasonOf(adapter.fieldCounts("beer", ["title"]))).toContain("3 entries");
  });

  it("since keeps the entries updated at or after it; a bad date is refused", async () => {
    const { adapter } = over();
    const got = (await collectPublished(adapter, { types: ["event"], since: "2026-11-01" })).docs;
    expect(got.map((d) => d.id)).toEqual(["ev-dinner"]);
    await expect(collectPublished(adapter, { since: "not a date" })).rejects.toThrow(TypeError);
  });
});

describe("the Contentful adapter: keys and permissions", () => {
  it("no delivery token or space id: nothing is asked, and the reason names the variable", async () => {
    const none = over({ adapter: { env: { CONTENTFUL_SPACE_ID: SPACE_ID } } });
    expect(await reasonOf(none.adapter.types())).toContain("CONTENTFUL_DELIVERY_TOKEN is not set");
    const noSpace = over({ adapter: { env: { CONTENTFUL_DELIVERY_TOKEN: KEY } } });
    expect(await reasonOf(noSpace.adapter.types())).toContain("CONTENTFUL_SPACE_ID is not set");
    expect(none.seen).toEqual([]);
    expect(noSpace.seen).toEqual([]);
  });

  it("a space id or environment that could change an address is refused before any request", async () => {
    const bad = over({ adapter: { env: { ...ENV, CONTENTFUL_SPACE_ID: "a/../b" } } });
    expect(await reasonOf(bad.adapter.types())).toContain("not a Contentful space id");
    const env = over({ adapter: { env: { ...ENV, CONTENTFUL_ENVIRONMENT: "master/../x" } } });
    expect(await reasonOf(env.adapter.types())).toContain("not a Contentful environment id");
    expect(bad.seen.concat(env.seen)).toEqual([]);
  });

  it("a delivery token the space does not accept: could-not-check, token blanked", async () => {
    const { adapter } = over({ fixture: { token: "some-other-token" } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("did not accept CONTENTFUL_DELIVERY_TOKEN (HTTP 401)");
    expect(reason).not.toContain(KEY);
  });

  it("a token not enabled for the environment (HTTP 404) says so, and names the settings to check", async () => {
    const { adapter } = over({
      adapter: { env: { ...ENV, CONTENTFUL_ENVIRONMENT: "staging" } },
    });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("HTTP 404");
    expect(reason).toContain("CONTENTFUL_ENVIRONMENT");
  });

  it("a preview token that is refused is could-not-check for drafts only; the published reads still work", async () => {
    const { adapter, seen } = over({
      adapter: { env: { ...ENV, CONTENTFUL_PREVIEW_TOKEN: "wrong-preview-token-value" } },
      fixture: { previewToken: PREVIEW_KEY },
    });
    expect((await adapter.types()).map((t) => t.name)).toEqual(["beer", "event", "testimonial"]);
    expect((await collectPublished(adapter, { types: ["event"] })).docs).toHaveLength(2);
    const reason = await reasonOf(adapter.draftsReachable());
    expect(reason).toContain("CONTENTFUL_PREVIEW_TOKEN (HTTP 401)");
    expect(reason).not.toContain("wrong-preview-token-value");
    expect(seen.some((s) => s.url.startsWith(CONTENTFUL_CPA))).toBe(true);
  });

  it("with a preview token, drafts are reachable when the Preview API has more entries than the Delivery API", async () => {
    const { adapter, seen } = over({
      adapter: { env: { ...ENV, CONTENTFUL_PREVIEW_TOKEN: PREVIEW_KEY } },
      fixture: { previewToken: PREVIEW_KEY },
    });
    expect(await adapter.draftsReachable()).toBe(true);
    // Each token goes to its own host only, in a header.
    for (const s of seen) {
      const preview = s.url.startsWith(CONTENTFUL_CPA);
      expect(s.headers.authorization).toBe(`Bearer ${preview ? PREVIEW_KEY : KEY}`);
      expect(s.url).not.toContain(PREVIEW_KEY);
    }
    expect(requestProblems(seen)).toEqual([]);
    const settled = over({
      adapter: { env: { ...ENV, CONTENTFUL_PREVIEW_TOKEN: PREVIEW_KEY } },
      transport: contentfulTransport(
        ASH.map((t) => ({ ...t, drafts: [] })),
        { token: KEY, previewToken: PREVIEW_KEY },
      ),
    });
    expect(await settled.adapter.draftsReachable()).toBe(false);
  });

  it("with no preview token the Preview API is never asked", async () => {
    const { adapter, seen } = over();
    expect(await adapter.draftsReachable()).toBe(false);
    expect(seen.some((s) => s.url.includes("preview.contentful.com"))).toBe(false);
  });

  it("a redirect to another origin carries no Authorization header", async () => {
    const seen: Seen[] = [];
    const inner = contentfulTransport(ASH, { token: KEY });
    const fetcher = createFetcher({
      transport: recording((url, req) => {
        if (url.hostname === "cdn.contentful.com" && url.pathname.endsWith("/content_types"))
          return Promise.resolve({
            status: 302,
            headers: { location: "https://elsewhere.example/types" },
            body: Readable.from([]),
          });
        return url.hostname === "elsewhere.example"
          ? Promise.resolve({
              status: 200,
              headers: { "content-type": "application/json" },
              body: Readable.from([Buffer.from('{"total":0,"skip":0,"limit":1000,"items":[]}')]),
            })
          : inner(url, req);
      }, seen),
      timeoutMs: 5000,
    });
    const adapter = createContentfulAdapter({
      env: ENV,
      fetcher,
      sleep: () => Promise.resolve(),
    });
    await adapter.types();
    const elsewhere = seen.filter((s) => s.url.includes("elsewhere.example"));
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const h of elsewhere) expect(h.headers.authorization).toBeUndefined();
    expect(seen.some((s) => s.url.includes("cdn.contentful.com") && s.headers.authorization)).toBe(
      true,
    );
  });

  it("Contentful names its wait X-Contentful-RateLimit-Reset: a short one is waited out once", async () => {
    const waits: number[] = [];
    let n = 0;
    const inner = contentfulTransport(ASH, { token: KEY });
    const { adapter } = over({
      adapter: {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
      transport: (url, req) =>
        n++ === 0
          ? Promise.resolve({
              status: 429,
              headers: { "x-contentful-ratelimit-reset": "3", "content-type": "application/json" },
              body: Readable.from([Buffer.from("{}")]),
            })
          : inner(url, req),
    });
    expect(await adapter.types()).toHaveLength(3);
    expect(waits).toEqual([3000]);
    // A limit that stays is the adapter's own rate-limit error, carrying what was read.
    const stuck = over({
      transport: (url, req) =>
        url.pathname.endsWith("/content_types")
          ? inner(url, req)
          : Promise.resolve({
              status: 429,
              headers: { "x-contentful-ratelimit-reset": "3600" },
              body: Readable.from([Buffer.from("{}")]),
            }),
    });
    await expect(stuck.adapter.types()).rejects.toBeInstanceOf(AdapterRateLimitedError);
  });
});

describe("Contentful against the live site: a healthy site, and drift between the CMS and the page", () => {
  it("a healthy site: every published entry with an address has its page, and nothing is a finding", async () => {
    const { reading, result } = await findings(PAGES_HEALTHY);
    expect(reading.pages.map((p) => p.path).sort()).toEqual(Object.keys(PAGES_HEALTHY).sort());
    expect(result.findings).toEqual([]);
    // Testimonials have no pattern: named as could-not-check, never a pass.
    expect(result.couldNotCheck.map((c) => c.reason).join("\n")).toContain("testimonial:");
    expect(result.passed).toEqual([]);
  });

  it("drift: an entry published in Contentful whose page is gone is a high finding, with slug and path only", async () => {
    const { result } = await findings(PAGES_DRIFT);
    expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence, f.url])).toEqual([
      [
        "contentful-entry-no-page",
        "high",
        "event: brewers-dinner is published in Contentful and /events/brewers-dinner answers 404",
        `${ASH_SITE}/events/brewers-dinner`,
      ],
    ]);
    const text = JSON.stringify(result);
    for (const v of Object.values(CONTENTFUL_MARKERS)) expect(text).not.toContain(v);
    expect(text).not.toContain(KEY);
  });

  it("an unpublished entry is never read, so it can never be a finding", async () => {
    const { reading } = await findings(PAGES_HEALTHY);
    expect(JSON.stringify(reading)).not.toContain("new-years-eve");
  });

  it("a page that answers 503 is could-not-check for that page, not a finding or a pass", async () => {
    const { result } = await findings({ ...PAGES_HEALTHY, "/beers/oat-stout": 503 });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck.map((c) => c.reason).join("\n")).toContain("the site answered 503");
  });

  it("a token the platform refuses stops the read with the reason; it is never an empty, clean result", async () => {
    const { adapter, fetcher } = over({ fixture: { token: "something-else" } });
    expect(await reasonOf(readContentful({ adapter, fetcher, site: ASH_SITE }))).toContain("401");
  });

  it("a rate limit that stays marks the reading partial, and the check says it is not everything", async () => {
    const inner = contentfulTransport(ASH, { token: KEY });
    const { adapter, fetcher } = over({
      transport: (url, req) =>
        url.pathname.endsWith("/content_types")
          ? inner(url, req)
          : url.hostname === "cdn.contentful.com"
            ? Promise.resolve({
                status: 429,
                headers: { "retry-after": "3600" },
                body: Readable.from([Buffer.from("{}")]),
              })
            : inner(url, req),
    });
    const reading = await readContentful({ adapter, fetcher, site: ASH_SITE });
    expect(reading.partial?.reason).toBe("rate-limited");
    const result = await runChecks(reading, createContentfulRegistry());
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck.map((c) => c.reason).join("\n")).toContain("slow down");
  });
});
