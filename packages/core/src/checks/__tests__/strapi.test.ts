import { describe, expect, it } from "vitest";
import { createStrapiAdapter } from "../../adapters/strapi.js";
import { readStrapi, type StrapiReading } from "../../adapters/strapi-read.js";
import {
  BRASS,
  BRASS_SETTLED,
  BRASS_SITE,
  BRASS_URLS,
  CMS_URL,
  PAGES_DRIFT,
  PAGES_HEALTHY,
  STRAPI_MARKERS,
  strapiTransport,
  type StrapiFixtureCollection,
  type StrapiFixtureOptions,
} from "../../adapters/__tests__/strapi-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { STRAPI_CHECKS, createStrapiRegistry } from "../strapi.js";

const KEY = testKey("strapi-checks");
const URLS = { ...BRASS_URLS, reviews: "/reviews/{slug}" };
/** The reviews have pages in these tests, so a clean site really is clean. */
const REVIEW_PAGES = { "/reviews/a-regular": 200, "/reviews/a-first-timer": 200 };

async function reading(
  content: readonly StrapiFixtureCollection[],
  pages: Readonly<Record<string, number>>,
  options: {
    fixture?: StrapiFixtureOptions;
    urls?: Record<string, string>;
    ownerConsent?: boolean;
  } = {},
): Promise<{ reading: StrapiReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: strapiTransport(content, {
      token: KEY,
      pages: { ...REVIEW_PAGES, ...pages },
      onRequest: (method, url) => seen.push(`${method} ${url.href}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createStrapiAdapter({
    env: { STRAPI_URL: CMS_URL, STRAPI_TOKEN: KEY },
    fetcher,
    settings: { id: "strapi", urls: options.urls ?? URLS },
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readStrapi({
      adapter,
      fetcher,
      site: BRASS_SITE,
      ...(options.ownerConsent !== undefined ? { ownerConsent: options.ownerConsent } : {}),
    }),
    seen,
  };
}

const run = (r: StrapiReading) => runChecks(r, createStrapiRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);

describe("Strapi checks: a bar whose CMS and front end have drifted", () => {
  it("finds the published event with no page, and nothing else", async () => {
    const { reading: r } = await reading(BRASS, PAGES_DRIFT, { ownerConsent: true });
    const out = await run(r);
    expect(evidence(out, "strapi-entry-no-page")).toEqual([
      "events: pub-quiz is published in Strapi and /events/pub-quiz answers 404",
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.findings[0]?.url).toBe(`${BRASS_SITE}/events/pub-quiz`);
  });

  it("a healthy site has no finding from either check", async () => {
    const { reading: r } = await reading(
      BRASS_SETTLED,
      { ...PAGES_HEALTHY, "/events/new-year-lock-in": 200 },
      { ownerConsent: true },
    );
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed.sort()).toEqual(["strapi-drafts-public", "strapi-entry-no-page"]);
  });

  it("a collection the settings do not name is not read at all", async () => {
    const { reading: r, seen } = await reading(BRASS, PAGES_HEALTHY, {
      urls: { events: "/events/{slug}", "menu-items": "/menu/{slug}" },
    });
    expect(r.withoutPattern).toEqual([]);
    expect(seen.some((s) => s.includes("/api/reviews"))).toBe(false);
  });

  it("a collection fingerprinted and given no pattern lists as could not check", async () => {
    const fetcher = createFetcher({
      transport: strapiTransport(BRASS, { token: KEY, pages: PAGES_HEALTHY }),
      timeoutMs: 5000,
    });
    const adapter = createStrapiAdapter({
      env: { STRAPI_URL: CMS_URL, STRAPI_TOKEN: KEY },
      fetcher,
      settings: { id: "strapi", urls: BRASS_URLS, fingerprint: { reviews: ["author"] } },
      sleep: () => Promise.resolve(),
    });
    const r = await readStrapi({ adapter, fetcher, site: BRASS_SITE });
    expect(r.withoutPattern).toEqual(["reviews"]);
    const out = await run(r);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /reviews: its pages were not checked/,
    );
    expect(out.passed).not.toContain("strapi-entry-no-page");
  });

  it("a key lacking permission on one collection is could-not-check for that collection only", async () => {
    const { reading: r } = await reading(BRASS, PAGES_DRIFT, { fixture: { denied: ["events"] } });
    expect(r.unreadable.map((u) => u.type)).toEqual(["events"]);
    const out = await run(r);
    // The other collections are still checked and have no finding; events gives no pass.
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /events: Strapi would not give this collection \(.*find and findOne/,
    );
    expect(out.passed).not.toContain("strapi-entry-no-page");
    expect(r.pages.map((p) => p.type).sort()).toEqual([
      "menu-items",
      "menu-items",
      "reviews",
      "reviews",
    ]);
  });

  it("never shows a field, a draft or the token", async () => {
    const { reading: r } = await reading(BRASS, PAGES_DRIFT, {
      ownerConsent: true,
      fixture: { publicPublished: ["events"], publicDrafts: ["events"] },
    });
    const text = JSON.stringify([r, await run(r)]);
    for (const marker of Object.values(STRAPI_MARKERS)) expect(text).not.toContain(marker);
    expect(text).not.toContain(KEY);
  });

  it("a page that answers 503 is could-not-check for that page, not a finding", async () => {
    const { reading: r } = await reading(BRASS, { ...PAGES_HEALTHY, "/menu/anchor-stout": 503 });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/the site answered 503/);
  });

  it("an address pattern that points to another site is not asked", async () => {
    const { reading: r, seen } = await reading(BRASS, PAGES_HEALTHY, {
      urls: { events: "https://other-bar.example/events/{slug}" },
    });
    expect(r.pages.every((p) => p.answer.kind === "unread")).toBe(true);
    expect(seen.some((s) => s.includes("other-bar.example"))).toBe(false);
  });
});

describe("strapi-drafts-public: the extra check, a probing check", () => {
  it("positive: a Public role that lists drafts is a finding with a count and ids", async () => {
    const { reading: r } = await reading(BRASS, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { publicPublished: ["events", "menu-items"], publicDrafts: ["events"] },
    });
    const out = await run(r);
    expect(evidence(out, "strapi-drafts-public")).toEqual([
      "events: 1 entry that is not published can be listed with no token: evt-new-year",
    ]);
    expect(out.findings.find((f) => f.checkId === "strapi-drafts-public")?.severity).toBe("high");
  });

  it("negative: a Public role that shows published entries and refuses drafts passes", async () => {
    const { reading: r } = await reading(BRASS, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { publicPublished: ["events", "menu-items", "reviews"] },
    });
    const out = await run(r);
    expect(evidence(out, "strapi-drafts-public")).toEqual([]);
    expect(out.passed).toContain("strapi-drafts-public");
  });

  it("negative: a Strapi that shows visitors nothing at all passes", async () => {
    const { reading: r } = await reading(BRASS, PAGES_HEALTHY, { ownerConsent: true });
    expect(r.publicDrafts.map((d) => d.state)).toEqual(["private", "private", "private"]);
    expect(evidence(await run(r), "strapi-drafts-public")).toEqual([]);
  });

  it("without owner consent no draft route is asked and the check says so", async () => {
    const anonymous: string[] = [];
    const { reading: r } = await reading(BRASS, PAGES_HEALTHY, {
      fixture: {
        publicPublished: ["events"],
        publicDrafts: ["events"],
        onRequest: (_m, url, h) => {
          if (url.host.startsWith("cms.") && h.authorization === undefined)
            anonymous.push(url.href);
        },
      },
    });
    expect(r.publicDrafts).toEqual([]);
    // Every request to the CMS carries the token: no visitor-style request was made.
    expect(anonymous).toEqual([]);
    const out = await run(r);
    expect(out.findings.filter((f) => f.checkId === "strapi-drafts-public")).toEqual([]);
    expect(out.passed).not.toContain("strapi-drafts-public");
    expect(out.couldNotCheck.find((c) => c.id === "strapi-drafts-public")?.reason).toMatch(
      /--owner-consent/,
    );
  });

  it("with consent, every request it makes is a GET and none carries the token", async () => {
    const headers: Array<string | undefined> = [];
    const { reading: r } = await reading(BRASS, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: {
        publicPublished: ["events"],
        publicDrafts: ["events"],
        onRequest: (method, url, h) => {
          expect(method).toBe("GET");
          // The reading makes no token-carrying draft request, so every draft request is a visitor's.
          if (url.searchParams.has("status") || url.searchParams.has("publicationState"))
            headers.push(h.authorization);
        },
      },
    });
    expect(r.publicDrafts[0]?.state).toBe("reachable");
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h === undefined)).toBe(true);
  });

  it("is declared a probing check in its text, and both checks are registered in order", () => {
    const check = STRAPI_CHECKS[1];
    expect(check.tech).toMatch(/^probing check, off without --owner-consent/);
    expect(STRAPI_CHECKS.map((c) => c.id)).toEqual([
      "strapi-entry-no-page",
      "strapi-drafts-public",
    ]);
  });
});
