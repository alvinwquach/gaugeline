import { describe, expect, it } from "vitest";
import { createUmbracoAdapter } from "../../adapters/umbraco.js";
import { readUmbraco, type UmbracoReading } from "../../adapters/umbraco-read.js";
import {
  UMBRACO_CONTENT,
  UMBRACO_MARKERS,
  UMBRACO_SITE,
  umbracoTransport,
  type UmbracoFixtureOptions,
} from "../../adapters/__tests__/umbraco-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { UMBRACO_CHECKS, createUmbracoRegistry } from "../umbraco.js";

const KEY = testKey("umbraco-checks");
const URLS = { show: "/whats-on/{slug}", notice: "/news/{slug}", castMember: "/company/{slug}" };

async function reading(
  options: {
    fixture?: UmbracoFixtureOptions;
    env?: Record<string, string>;
    settings?: { urls?: Record<string, string>; fingerprint?: Record<string, string[]> };
    ownerConsent?: boolean;
    maxPages?: number;
  } = {},
): Promise<{ reading: UmbracoReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: umbracoTransport(undefined, {
      apiKey: KEY,
      onRequest: (method, url, headers) =>
        seen.push(`${method} ${url.pathname} key=${headers["api-key"] !== undefined}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createUmbracoAdapter({
    env: options.env ?? { UMBRACO_URL: UMBRACO_SITE, UMBRACO_API_KEY: KEY },
    fetcher,
    settings: { id: "umbraco", urls: URLS, ...options.settings },
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readUmbraco({
      adapter,
      fetcher,
      site: UMBRACO_SITE,
      ...(options.ownerConsent !== undefined ? { ownerConsent: options.ownerConsent } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: UmbracoReading) => runChecks(r, createUmbracoRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("Umbraco checks: node published but no page", () => {
  it("a healthy site has no finding from either check", async () => {
    const { reading: r } = await reading({ ownerConsent: true, fixture: { protectedApi: true } });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed.sort()).toEqual(["umbraco-delivery-api-public", "umbraco-node-no-page"]);
  });

  it("drift between the CMS and the live site: the published show with no page, and nothing else", async () => {
    const { reading: r } = await reading({
      fixture: { missingPages: ["/whats-on/winter-panto"], protectedApi: true },
    });
    const out = await run(r);
    expect(evidence(out, "umbraco-node-no-page")).toEqual([
      "show: winter-panto is published in Umbraco and /whats-on/winter-panto answers 404",
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.findings[0]?.url).toBe(`${UMBRACO_SITE}/whats-on/winter-panto`);
  });

  it("a draft with no page is not reported: only published nodes are asked about", async () => {
    const { reading: r, seen } = await reading({
      fixture: { missingPages: ["/whats-on/spring-show"], protectedApi: true },
    });
    expect(r.pages.map((p) => p.path)).not.toContain("/whats-on/spring-show");
    expect((await run(r)).findings).toEqual([]);
    expect(seen.some((s) => s.includes("/whats-on/spring-show"))).toBe(false);
  });

  it("uses the route the API gave when the settings have no pattern for a type", async () => {
    const { reading: r } = await reading({
      settings: { urls: {}, fingerprint: { show: ["title"] } },
      fixture: { missingPages: ["/whats-on/winter-panto/"], protectedApi: true },
    });
    const out = await run(r);
    expect(evidence(out, "umbraco-node-no-page")).toEqual([
      "show: winter-panto is published in Umbraco and /whats-on/winter-panto/ answers 404",
    ]);
  });

  it("a node with no route and no pattern is could-not-check by id, and is not asked", async () => {
    const content = structuredClone(UMBRACO_CONTENT);
    const first = content[0]?.nodes[0];
    if (first) first.routePath = undefined;
    const fetcher = createFetcher({
      transport: umbracoTransport(content, { apiKey: KEY }),
      timeoutMs: 5000,
    });
    const adapter = createUmbracoAdapter({
      env: { UMBRACO_URL: UMBRACO_SITE, UMBRACO_API_KEY: KEY },
      fetcher,
      settings: { id: "umbraco", fingerprint: { show: ["title"] } },
      sleep: () => Promise.resolve(),
    });
    const r = await readUmbraco({ adapter, fetcher, site: UMBRACO_SITE });
    expect(r.unaddressed.map((u) => u.id)).toEqual(["3f6c8a10-5b7e-4c21-9d34-a1b2c3d4e5f6"]);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/node 3f6c8a10-5b7e-4c21-9d34-a1b2c3d4e5f6 was not checked/);
    expect(out.passed).not.toContain("umbraco-node-no-page");
  });

  it("a key lacking permission on one content type is could-not-check for that type only", async () => {
    const { reading: r } = await reading({
      fixture: { denied: ["show"], missingPages: ["/company/tomas"] },
    });
    expect(r.unreadable.map((u) => u.type)).toEqual(["show"]);
    const out = await run(r);
    expect(evidence(out, "umbraco-node-no-page")).toEqual([
      "castMember: tomas is published in Umbraco and /company/tomas answers 404",
    ]);
    expect(reasons(out)).toMatch(/show: Umbraco would not give this content type \(.*HTTP 403/);
  });

  it("no content type named is could-not-check for both checks, never a clean pass, and asks nothing", async () => {
    const { reading: r, seen } = await reading({ settings: { urls: {} }, ownerConsent: true });
    expect(r.nothingNamed).toBe(true);
    expect(seen).toEqual([]);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/umbraco-node-no-page: .*No content type is named/);
    expect(reasons(out)).toMatch(/umbraco-delivery-api-public: .*No content type is named/);
  });

  it("a page budget that runs out is could-not-check by count", async () => {
    const { reading: r } = await reading({ maxPages: 1 });
    expect(r.pagesSkipped).toBeGreaterThan(0);
    expect(reasons(await run(r))).toMatch(
      /pages were not asked for, because a run asks for at most 1/,
    );
  });

  it("a rate limit that stays is a partial read, said plainly", async () => {
    let n = 0;
    const base = umbracoTransport(undefined, { apiKey: KEY });
    const fetcher = createFetcher({
      transport: (url, req) =>
        n++ >= 1 && url.pathname.startsWith("/umbraco")
          ? Promise.resolve({
              status: 429,
              headers: { "retry-after": "3600" },
              body: (async function* () {
                yield Buffer.from("{}");
              })() as never,
            })
          : base(url, req),
      timeoutMs: 5000,
    });
    const adapter = createUmbracoAdapter({
      env: { UMBRACO_URL: UMBRACO_SITE, UMBRACO_API_KEY: KEY },
      fetcher,
      settings: { id: "umbraco", urls: URLS },
      sleep: () => Promise.resolve(),
    });
    const r = await readUmbraco({ adapter, fetcher, site: UMBRACO_SITE });
    expect(r.partial?.reason).toBe("rate-limited");
    expect(reasons(await run(r))).toMatch(/asked Gaugeline to slow down/);
  });

  it("reports no name or property of the client's, only ids, slugs, paths and counts", async () => {
    const { reading: r } = await reading({
      ownerConsent: true,
      settings: { fingerprint: { show: ["title"] } },
      fixture: { missingPages: ["/whats-on/winter-panto"], protectedApi: true },
    });
    const text = JSON.stringify([r, await run(r)]);
    for (const m of Object.values(UMBRACO_MARKERS)) expect(text).not.toContain(m);
    expect(text).not.toContain(KEY);
  });
});

describe("Umbraco checks: the Delivery API answers visitors with no key (probing)", () => {
  it("without owner consent nothing is asked of the API as a visitor, and the check says so", async () => {
    const { reading: r, seen } = await reading({ fixture: { protectedApi: false } });
    expect(r.publicApi).toBeUndefined();
    const out = await run(r);
    expect(evidence(out, "umbraco-delivery-api-public")).toEqual([]);
    expect(reasons(out)).toMatch(/umbraco-delivery-api-public: .*not asked: .*--owner-consent/);
    expect(out.passed).not.toContain("umbraco-delivery-api-public");
    expect(seen.every((s) => s.endsWith("key=true") || !s.includes("/umbraco/"))).toBe(true);
  });

  it("positive: a public API with a key configured is a finding with a count and nothing else", async () => {
    const { reading: r, seen } = await reading({
      ownerConsent: true,
      fixture: { protectedApi: false },
    });
    expect(r.publicApi).toEqual({ state: "public", total: 5 });
    const out = await run(r);
    expect(evidence(out, "umbraco-delivery-api-public")).toEqual([
      "a request with no key to /umbraco/delivery/api/v2/content was answered with a list of 5 nodes, and UMBRACO_API_KEY says the API is private",
    ]);
    expect(out.findings.find((f) => f.checkId === "umbraco-delivery-api-public")?.severity).toBe(
      "high",
    );
    // The visitor's request is the only one with no key.
    expect(seen.filter((s) => s.includes("/umbraco/") && s.endsWith("key=false"))).toHaveLength(1);
  });

  it("negative: a protected API answers 401 to a visitor, and there is no finding", async () => {
    const { reading: r } = await reading({ ownerConsent: true, fixture: { protectedApi: true } });
    expect(r.publicApi).toEqual({ state: "protected" });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toContain("umbraco-delivery-api-public");
  });

  it("negative: an API that is off (404) is no finding", async () => {
    const { reading: r } = await reading({ ownerConsent: true, fixture: { off: true } });
    expect(r.unreadable.length).toBeGreaterThan(0);
    expect(r.publicApi).toEqual({ state: "closed" });
    expect(evidence(await run(r), "umbraco-delivery-api-public")).toEqual([]);
  });

  it("a page that answers every path with 200 is could-not-check, never a finding", async () => {
    const { reading: r } = await reading({ ownerConsent: true, fixture: { catchAll: true } });
    const out = await run(r);
    expect(evidence(out, "umbraco-delivery-api-public")).toEqual([]);
    expect(reasons(out)).toMatch(
      /the Delivery API was not read \(Umbraco answered with something that is not JSON/,
    );
  });

  it("with no key set, the owner has not said the API is private: could-not-check, no visitor request", async () => {
    const { reading: r, seen } = await reading({
      env: { UMBRACO_URL: UMBRACO_SITE },
      ownerConsent: true,
      fixture: { protectedApi: false },
    });
    expect(r.expectedPrivate).toBe(false);
    expect(r.publicApi).toBeUndefined();
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/UMBRACO_API_KEY is not set, so Gaugeline cannot know/);
    // The published lists were read with no key at all.
    expect(seen.filter((s) => s.includes("/umbraco/")).every((s) => s.endsWith("key=false"))).toBe(
      true,
    );
  });

  it("the visitor request carries no key, no cookie and no preview header", async () => {
    const headers: Record<string, string>[] = [];
    const base = umbracoTransport(undefined, { apiKey: KEY, protectedApi: false });
    const fetcher = createFetcher({
      transport: (url, req) => {
        if (url.pathname.startsWith("/umbraco") && req.headers["api-key"] === undefined)
          headers.push(req.headers);
        return base(url, req);
      },
      timeoutMs: 5000,
    });
    const adapter = createUmbracoAdapter({
      env: { UMBRACO_URL: UMBRACO_SITE, UMBRACO_API_KEY: KEY },
      fetcher,
      settings: { id: "umbraco", urls: URLS },
      sleep: () => Promise.resolve(),
    });
    await adapter.publicApi();
    expect(headers).toHaveLength(1);
    const names = Object.keys(headers[0] ?? {}).map((h) => h.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("preview");
    expect(names).not.toContain("authorization");
  });
});

describe("the Umbraco checks are registered and documented", () => {
  it("each has a title, a fix and a technical line, and the probing one says it needs consent", () => {
    for (const c of UMBRACO_CHECKS) {
      expect(c.title.length).toBeGreaterThan(10);
      expect(c.fix.length).toBeGreaterThan(20);
      expect(c.tech.length).toBeGreaterThan(20);
    }
    const probing = UMBRACO_CHECKS.find((c) => c.id === "umbraco-delivery-api-public");
    expect(probing?.tech).toContain("--owner-consent");
    expect(probing?.tech).toContain("sites you own or have permission to test");
  });
});
