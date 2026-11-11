import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createJoomlaAdapter } from "../../adapters/joomla.js";
import { readJoomla, type JoomlaReading } from "../../adapters/joomla-read.js";
import {
  JOOMLA_ARTICLES,
  JOOMLA_MARKERS,
  JOOMLA_NOW,
  JOOMLA_SITE,
  joomlaTransport,
  type JoomlaFixtureOptions,
} from "../../adapters/__tests__/joomla-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { JOOMLA_CHECKS, createJoomlaRegistry } from "../joomla.js";

const KEY = testKey("joomla-checks");
const URLS = { articles: "/studio/{slug}" };

async function reading(
  options: {
    fixture?: JoomlaFixtureOptions;
    env?: Record<string, string>;
    settings?: { urls?: Record<string, string>; expectPrivate?: boolean };
    ownerConsent?: boolean;
    maxPages?: number;
    articles?: typeof JOOMLA_ARTICLES;
  } = {},
): Promise<{ reading: JoomlaReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: joomlaTransport(options.articles, {
      token: KEY,
      onRequest: (method, url, headers) =>
        seen.push(`${method} ${url.pathname} token=${headers["x-joomla-token"] !== undefined}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createJoomlaAdapter({
    env: options.env ?? { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: KEY },
    fetcher,
    settings: { id: "joomla", urls: URLS, ...options.settings },
    sleep: () => Promise.resolve(),
    now: () => JOOMLA_NOW,
  });
  return {
    reading: await readJoomla({
      adapter,
      fetcher,
      site: JOOMLA_SITE,
      ...(options.ownerConsent !== undefined ? { ownerConsent: options.ownerConsent } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: JoomlaReading) => runChecks(r, createJoomlaRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("Joomla checks: article published but no page", () => {
  it("a healthy site has no finding from either check", async () => {
    const { reading: r } = await reading({ ownerConsent: true, settings: { expectPrivate: true } });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    // Articles in another language are could-not-check, so the first check does not pass; the second does.
    expect(out.passed).toEqual(["joomla-api-public"]);
    expect(reasons(out)).toMatch(/1 published article is in one language/);
  });

  it("drift between the CMS and the live site: the published article with no page, and nothing else", async () => {
    const { reading: r } = await reading({
      fixture: { missingPages: ["/studio/evening-stretch"] },
    });
    const out = await run(r);
    expect(evidence(out, "joomla-article-no-page")).toEqual([
      "article evening-stretch is published in Joomla and /studio/evening-stretch answers 404",
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.findings[0]?.url).toBe(`${JOOMLA_SITE}/studio/evening-stretch`);
  });

  it("a draft, a Registered-only, a scheduled and an expired article are not asked about", async () => {
    const { reading: r, seen } = await reading({
      fixture: {
        missingPages: [
          "/studio/autumn-retreat",
          "/studio/members-timetable",
          "/studio/spring-open-day",
          "/studio/summer-timetable",
        ],
      },
    });
    expect(r.pages.map((p) => p.path)).toEqual([
      "/studio/morning-flow",
      "/studio/evening-stretch",
      "/studio/closed-last-friday",
    ]);
    expect(r.skipped).toEqual({ notPublic: 1, scheduled: 1, expired: 1, otherLanguage: 1 });
    expect((await run(r)).findings).toEqual([]);
    expect(seen.some((s) => s.includes("autumn-retreat"))).toBe(false);
  });

  it("with no address pattern nothing is asked of the live site, and it is could-not-check, never a pass", async () => {
    const { reading: r, seen } = await reading({ settings: { urls: {} } });
    expect(r.noPattern).toBe(true);
    expect(r.pages).toEqual([]);
    const out = await run(r);
    expect(out.passed).not.toContain("joomla-article-no-page");
    expect(reasons(out)).toMatch(/no address pattern for articles/);
    expect(seen.every((s) => s.includes("/api/index.php/v1/content/articles"))).toBe(true);
  });

  it("a site with no published article reads nothing and passes nothing", async () => {
    const { reading: r } = await reading({
      articles: JOOMLA_ARTICLES.filter((a) => a.state !== 1),
    });
    expect(r.noArticles).toBe(true);
    const out = await run(r);
    expect(out.passed).not.toContain("joomla-article-no-page");
    expect(reasons(out)).toMatch(/no published article was read/);
  });

  it("a token Joomla refuses is could-not-check with the reason, and no page is asked", async () => {
    const { reading: r, seen } = await reading({ fixture: { denied: true } });
    expect(r.unreadable).toMatch(/Access API/);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).not.toContain("joomla-article-no-page");
    expect(reasons(out)).toMatch(/would not give its articles/);
    expect(seen.some((s) => s.includes("/studio/"))).toBe(false);
  });

  it("a page that answers something that is not 200 or 404 is could-not-check for that page", async () => {
    const base = joomlaTransport(undefined, { token: KEY });
    const fetcher = createFetcher({
      transport: (url, req) =>
        url.pathname === "/studio/morning-flow"
          ? (Promise.resolve({
              status: 503,
              headers: {},
              body: Readable.from([]),
            }) as ReturnType<typeof base>)
          : base(url, req),
      timeoutMs: 5000,
    });
    const adapter = createJoomlaAdapter({
      env: { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: KEY },
      fetcher,
      settings: { id: "joomla", urls: URLS },
      sleep: () => Promise.resolve(),
      now: () => JOOMLA_NOW,
    });
    const out = await run(await readJoomla({ adapter, fetcher, site: JOOMLA_SITE }));
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/the site answered 503/);
  });

  it("an address pattern that points at another site is not asked", async () => {
    const { reading: r, seen } = await reading({
      settings: { urls: { articles: "https://other.example/{slug}" } },
    });
    expect(r.pages.every((p) => p.answer.kind === "unread")).toBe(true);
    expect(seen.some((s) => s.includes("other.example"))).toBe(false);
    expect(reasons(await run(r))).toMatch(/points to another site/);
  });

  it("a page budget that runs out is could-not-check by count", async () => {
    const { reading: r } = await reading({ maxPages: 2 });
    expect(r.pagesSkipped).toBe(1);
    expect(reasons(await run(r))).toMatch(
      /1 page was not asked for, because a run asks for at most 2/,
    );
  });

  it("when every published article is left out, no page is asked and nothing passes", async () => {
    const { reading: r } = await reading({
      articles: JOOMLA_ARTICLES.filter((a) => a.id === 5 || a.id === 6 || a.id === 7),
    });
    expect(r.pages).toEqual([]);
    expect(r.noArticles).toBe(false);
    const out = await run(r);
    expect(out.passed).not.toContain("joomla-article-no-page");
    expect(reasons(out)).toMatch(/no article was eligible for a page check \(3 left out: /);
  });

  it("a name in the settings that is not articles is said to be unread", async () => {
    const { reading: r } = await reading({
      settings: { urls: { ...URLS, categories: "/c/{slug}" } },
    });
    expect(reasons(await run(r))).toMatch(/"categories" in gaugeline.adapters.json is not read/);
  });

  it("a rate limit that stays is a partial read, said plainly", async () => {
    const base = joomlaTransport(undefined, { token: KEY });
    let n = 0;
    const fetcher = createFetcher({
      transport: (url, req) =>
        url.pathname.startsWith("/api") && n++ >= 3
          ? (Promise.resolve({
              status: 429,
              headers: { "retry-after": "3600" },
              body: Readable.from([]),
            }) as ReturnType<typeof base>)
          : base(url, req),
      timeoutMs: 5000,
    });
    const adapter = createJoomlaAdapter({
      env: { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: KEY },
      fetcher,
      settings: { id: "joomla", urls: URLS },
      sleep: () => Promise.resolve(),
      now: () => JOOMLA_NOW,
      pageSize: 1,
    });
    const r = await readJoomla({ adapter, fetcher, site: JOOMLA_SITE });
    expect(r.partial?.reason).toBe("rate-limited");
    const out = await run(r);
    expect(out.passed).not.toContain("joomla-article-no-page");
    expect(reasons(out)).toMatch(/asked Gaugeline to slow down/);
  });

  it("reports no title or text of the client's, only ids, aliases, paths and counts", async () => {
    const { reading: r } = await reading({
      fixture: { missingPages: ["/studio/morning-flow"] },
      ownerConsent: true,
      settings: { expectPrivate: true },
    });
    const text = JSON.stringify({ r, out: await run(r) });
    for (const marker of Object.values(JOOMLA_MARKERS)) expect(text).not.toContain(marker);
    expect(text).not.toContain(KEY);
  });
});

describe("Joomla checks: the API answers visitors with no token (probing)", () => {
  it("without owner consent nothing is asked of the API as a visitor, and the check says so", async () => {
    const { reading: r, seen } = await reading({
      settings: { expectPrivate: true },
      fixture: { protectedApi: false },
    });
    expect(r.publicApi).toBeUndefined();
    expect(seen.every((s) => s.includes("token=true") || !s.includes("/api/"))).toBe(true);
    expect(reasons(await run(r))).toMatch(/joomla-api-public: not asked.*--owner-consent/);
  });

  it("positive: a public list with the owner's word that it is private is a finding with a count and nothing else", async () => {
    const { reading: r } = await reading({
      ownerConsent: true,
      settings: { expectPrivate: true },
      fixture: { protectedApi: false },
    });
    const out = await run(r);
    expect(evidence(out, "joomla-api-public")).toEqual([
      "a request with no token to /api/index.php/v1/content/articles was answered with a list of 8 articles, and gaugeline.adapters.json says the API is private (expectPrivate)",
    ]);
    expect(out.findings.find((f) => f.checkId === "joomla-api-public")?.severity).toBe("high");
  });

  it("negative: a route that needs a token answers 401 to a visitor, and there is no finding", async () => {
    const { reading: r } = await reading({ ownerConsent: true, settings: { expectPrivate: true } });
    expect(r.publicApi).toEqual({ state: "protected" });
    expect(evidence(await run(r), "joomla-api-public")).toEqual([]);
  });

  it("negative: an API that is off (404) is no finding", async () => {
    const { reading: r } = await reading({
      ownerConsent: true,
      settings: { expectPrivate: true },
      fixture: { off: true },
    });
    expect(evidence(await run(r), "joomla-api-public")).toEqual([]);
  });

  it("a 429 on the visitor read is reported by joomla-api-public only, not by the page check", async () => {
    const base = joomlaTransport(undefined, { token: KEY });
    const fetcher = createFetcher({
      transport: (url, req) =>
        url.pathname.startsWith("/api") && req.headers["x-joomla-token"] === undefined
          ? (Promise.resolve({
              status: 429,
              headers: { "retry-after": "3600" },
              body: Readable.from([]),
            }) as ReturnType<typeof base>)
          : base(url, req),
      timeoutMs: 5000,
    });
    const adapter = createJoomlaAdapter({
      env: { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: KEY },
      fetcher,
      settings: { id: "joomla", urls: URLS, expectPrivate: true },
      sleep: () => Promise.resolve(),
      now: () => JOOMLA_NOW,
    });
    const r = await readJoomla({ adapter, fetcher, site: JOOMLA_SITE, ownerConsent: true });
    expect(r.partial).toBeUndefined();
    expect(r.publicApiPartial?.reason).toBe("rate-limited");
    const out = await run(r);
    const slow = out.couldNotCheck.filter((c) => /slow down/.test(c.reason));
    expect(slow.map((c) => c.id)).toHaveLength(1);
    expect(reasons(out)).toMatch(/slow down/);
    // The page check still has its own say, and nothing says its list was cut short.
    expect(out.findings).toEqual([]);
  });

  it("a page that answers every path with 200 is could-not-check, never a finding", async () => {
    const { reading: r } = await reading({
      ownerConsent: true,
      settings: { expectPrivate: true },
      fixture: { catchAll: true },
    });
    const out = await run(r);
    expect(evidence(out, "joomla-api-public")).toEqual([]);
    expect(reasons(out)).toMatch(/the Web Services API was not read/);
  });

  it("a public API and no stated expectation is NOT a finding: could-not-check, and no visitor request", async () => {
    const { reading: r, seen } = await reading({
      ownerConsent: true,
      fixture: { protectedApi: false },
    });
    expect(r.publicApi).toBeUndefined();
    const out = await run(r);
    expect(evidence(out, "joomla-api-public")).toEqual([]);
    expect(reasons(out)).toMatch(/no privacy expectation given/);
    expect(seen.every((s) => !s.includes("/api/") || s.includes("token=true"))).toBe(true);
  });

  it("the visitor request carries no token and no cookie", async () => {
    const headers: Record<string, string>[] = [];
    const fetcher = createFetcher({
      transport: joomlaTransport(undefined, {
        token: KEY,
        protectedApi: false,
        onRequest: (_m, _u, h) => headers.push(h),
      }),
      timeoutMs: 5000,
    });
    const adapter = createJoomlaAdapter({
      env: { JOOMLA_URL: JOOMLA_SITE, JOOMLA_TOKEN: KEY },
      fetcher,
      sleep: () => Promise.resolve(),
    });
    await adapter.publicApi();
    expect(headers).toHaveLength(1);
    expect(Object.keys(headers[0] ?? {}).sort()).not.toEqual(
      expect.arrayContaining(["x-joomla-token"]),
    );
    expect(headers[0]?.cookie).toBeUndefined();
    expect(headers[0]?.authorization).toBeUndefined();
  });
});

describe("the Joomla checks are registered and documented", () => {
  it("each has a title, a fix and a technical line, and the probing one says it needs consent", () => {
    expect(JOOMLA_CHECKS.map((c) => c.id)).toEqual(["joomla-article-no-page", "joomla-api-public"]);
    for (const c of JOOMLA_CHECKS) {
      expect(c.title).not.toBe("");
      expect(c.fix).not.toBe("");
      expect(c.tech).not.toBe("");
    }
    expect(JOOMLA_CHECKS[1]?.tech).toContain("--owner-consent");
    // The sentences brief.test.ts holds to: plain, one line, no backticks or angle brackets, a full stop.
    for (const c of JOOMLA_CHECKS) {
      expect(c.done).not.toMatch(/[`<>\n]/);
      expect(c.done).toMatch(/\.$/);
    }
    expect(JOOMLA_CHECKS[1]?.done).toBe(
      "A visitor who sends no token is refused by the Joomla article list, because you said the API is private.",
    );
    expect(JOOMLA_CHECKS[1]?.fix).not.toMatch(/remove (the )?token/i);
  });
});
