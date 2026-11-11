import { describe, expect, it } from "vitest";
import { createSitecoreAdapter } from "../../adapters/sitecore.js";
import { readSitecore, type SitecoreReading } from "../../adapters/sitecore-read.js";
import { SITECORE_SETTINGS } from "../../adapters/__tests__/sitecore.contract.js";
import {
  LARKSPUR_SITE,
  PAGES_DRIFT,
  PAGES_HEALTHY,
  SITECORE_MARKERS,
  sitecoreTransport,
  type SitecoreFixtureOptions,
} from "../../adapters/__tests__/sitecore-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { SITECORE_CHECKS, createSitecoreRegistry } from "../sitecore.js";

const KEY = testKey("sitecore-checks");

async function reading(
  pages: Readonly<Record<string, number>>,
  options: {
    fixture?: SitecoreFixtureOptions;
    settings?: object;
    env?: Record<string, string>;
    ownerConsent?: boolean;
    maxPages?: number;
    site?: string;
  } = {},
): Promise<{ reading: SitecoreReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: sitecoreTransport(undefined, {
      token: KEY,
      pages,
      onRequest: (method, url, headers) =>
        seen.push(`${method} ${url.host}${url.pathname} key=${headers["sc_apikey"] !== undefined}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createSitecoreAdapter({
    env: options.env ?? { SITECORE_API_KEY: KEY },
    fetcher,
    settings: (options.settings ?? SITECORE_SETTINGS) as never,
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readSitecore({
      adapter,
      fetcher,
      site: options.site ?? LARKSPUR_SITE,
      ...(options.ownerConsent !== undefined ? { ownerConsent: options.ownerConsent } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: SitecoreReading) => runChecks(r, createSitecoreRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("Sitecore checks: route published to Edge but no page on the live site", () => {
  it("are registered once each", () => {
    expect(SITECORE_CHECKS.map((c) => c.id)).toEqual([
      "sitecore-route-no-page",
      "sitecore-preview-public",
    ]);
  });

  it("a healthy site has no finding, and the probing check is not asked without consent", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["sitecore-route-no-page"]);
    expect(seen.some((s) => s.includes("/sitecore/api/graph/edge"))).toBe(false);
  });

  it("finds each route that is on Edge and has no page, and nothing else", async () => {
    const { reading: r } = await reading(PAGES_DRIFT);
    const out = await run(r);
    expect(evidence(out, "sitecore-route-no-page")).toEqual([
      "en: /classes/evening-stretch is published to Experience Edge and answers 404 on the live site",
      "fr-CA: /classes/morning-flow is published to Experience Edge and its page /fr-ca/classes/morning-flow answers 410 on the live site",
    ]);
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.findings[0]?.url).toBe(`${LARKSPUR_SITE}/classes/evening-stretch`);
  });

  it("a page that answers something other than 404 or 410 is could-not-check, not a finding", async () => {
    const { reading: r } = await reading({
      ...PAGES_HEALTHY,
      [`${LARKSPUR_SITE}/teachers/ana`]: 500,
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/the page was not read \(the site answered 500\)/);
  });

  it("a language with no urls prefix that is not the first is named could-not-check and its pages are not asked", async () => {
    const { reading: r, seen } = await reading(PAGES_DRIFT, {
      settings: { ...SITECORE_SETTINGS, urls: {} },
    });
    expect(r.unaddressed).toHaveLength(3);
    expect(seen.some((s) => s.includes("/fr-ca"))).toBe(false);
    const out = await run(r);
    expect(reasons(out)).toMatch(
      /fr-CA: route \/classes was not checked, because its address in this language is not known/,
    );
    expect(evidence(out, "sitecore-route-no-page")).toHaveLength(1);
  });

  it("a urls prefix on another site is not asked and says so", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      settings: { ...SITECORE_SETTINGS, urls: { "fr-CA": "https://fr.other.example" } },
    });
    expect(seen.some((s) => s.includes("fr.other.example"))).toBe(false);
    expect(reasons(await run(r))).toMatch(/points to another site \(fr\.other\.example\)/);
  });

  it("a language Edge gives nothing for is could-not-check, never a pass", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      settings: { ...SITECORE_SETTINGS, languages: ["en", "de-DE"], urls: {} },
    });
    expect(r.emptyLanguages).toEqual(["de-DE"]);
    const out = await run(r);
    expect(reasons(out)).toMatch(/de-DE: Experience Edge returned no published route/);
    expect(out.findings).toEqual([]);
  });

  it("a site name Edge does not know is could-not-check for every language, once", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      settings: { ...SITECORE_SETTINGS, siteName: "nothere" },
    });
    expect(r.unreadable).toHaveLength(1);
    expect(r.unreadable[0]?.type).toBe("en, fr-CA");
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(
      /en, fr-CA: Experience Edge would not give the routes \(Experience Edge has no site named "nothere"/,
    );
    expect(out.passed).toEqual(["sitecore-route-no-page"].filter(() => false));
  });

  it("no token, a refused token and no site name are could-not-check with the reason, and the token is never in a note", async () => {
    for (const [env, says] of [
      [{}, /SITECORE_API_KEY is not set/],
      [
        { SITECORE_API_KEY: "wrong-token-0123456789" },
        /did not accept SITECORE_API_KEY \(HTTP 401\)/,
      ],
    ] as const) {
      const { reading: r } = await reading(PAGES_HEALTHY, { env: { ...env } });
      const out = await run(r);
      expect(out.findings).toEqual([]);
      expect(reasons(out)).toMatch(says);
      expect(JSON.stringify(out)).not.toContain("wrong-token-0123456789");
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  });

  it("a rate limit that stays marks the read partial, with what was read", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      fixture: {
        respond: (_c, n) =>
          n >= 1 ? { status: 429, body: {}, headers: { "retry-after": "3600" } } : undefined,
      },
    });
    expect(r.partial?.reason).toBe("rate-limited");
    expect(reasons(await run(r))).toMatch(/slow down/);
  });

  it("a run asks for at most the page budget, and says how many were left", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, { maxPages: 4 });
    expect(seen.filter((s) => s.startsWith("GET larkspur-yoga.example/")).length).toBe(4);
    expect(r.pagesSkipped).toBe(5);
    expect(reasons(await run(r))).toMatch(
      /5 pages were not asked for, because a run asks for at most 4/,
    );
  });

  it("a route's page is asked on the checked site's own origin, whatever the route says", async () => {
    const { seen } = await reading(PAGES_HEALTHY);
    for (const s of seen)
      expect(
        ["POST edge.sitecorecloud.io", "GET larkspur-yoga.example"].some((p) => s.startsWith(p)),
      ).toBe(true);
  });

  it("the key goes to Experience Edge only, never to the live site", async () => {
    const { seen } = await reading(PAGES_HEALTHY, {
      ownerConsent: true,
      settings: { ...SITECORE_SETTINGS, expectPrivate: true },
    });
    for (const s of seen) if (s.includes("larkspur-yoga.example")) expect(s).toContain("key=false");
    expect(
      seen.filter((s) => s.includes("key=true")).every((s) => s.includes("edge.sitecorecloud.io")),
    ).toBe(true);
  });

  it("shows no text from the site's content", async () => {
    const { reading: r } = await reading(PAGES_DRIFT, {
      ownerConsent: true,
      settings: { ...SITECORE_SETTINGS, expectPrivate: true },
      fixture: { preview: "graphql" },
    });
    const text = JSON.stringify({ r, out: await run(r) });
    for (const marker of Object.values(SITECORE_MARKERS)) expect(text).not.toContain(marker);
  });

  it("is the same twice", async () => {
    const a = await run((await reading(PAGES_DRIFT)).reading);
    const b = await run((await reading(PAGES_DRIFT)).reading);
    expect(a).toEqual(b);
  });
});

describe("Sitecore checks: the preview endpoint answers on the public site (probing)", () => {
  const SETTINGS = { ...SITECORE_SETTINGS, expectPrivate: true };
  const asked = (seen: string[]): boolean =>
    seen.some((s) => s.includes("/sitecore/api/graph/edge"));

  it("is not asked without consent: could-not-check says why, and nothing is requested", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      settings: SETTINGS,
      fixture: { preview: "graphql" },
    });
    expect(asked(seen)).toBe(false);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(
      /sitecore-preview-public: not asked: this check asks the preview endpoint's path.*--owner-consent.*on sites you own or have permission to test/,
    );
  });

  it("with consent but no expectPrivate in the settings, it says so and asks nothing", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { preview: "graphql" },
    });
    expect(asked(seen)).toBe(false);
    expect(reasons(await run(r))).toMatch(/no privacy expectation given/);
  });

  it("a GraphQL server answering a visitor with no key is a finding, with the status and no content", async () => {
    for (const [preview, status] of [
      ["graphql", 200],
      ["graphql-bad-request", 400],
    ] as const) {
      const { reading: r } = await reading(PAGES_HEALTHY, {
        ownerConsent: true,
        settings: SETTINGS,
        fixture: { preview },
      });
      const out = await run(r);
      expect(evidence(out, "sitecore-preview-public")).toEqual([
        `a request with no key to /sitecore/api/graph/edge on the public site was answered by a GraphQL server (HTTP ${status}), and gaugeline.adapters.json says it should not be reachable there (expectPrivate)`,
      ]);
      expect(out.findings[0]?.severity).toBe("medium");
      expect(out.findings[0]?.url).toBe(LARKSPUR_SITE);
    }
  });

  it("a protected endpoint and a path that is not there are no finding", async () => {
    for (const preview of ["protected", "absent"] as const) {
      const { reading: r } = await reading(PAGES_HEALTHY, {
        ownerConsent: true,
        settings: SETTINGS,
        fixture: { preview },
      });
      const out = await run(r);
      expect(out.findings).toEqual([]);
      expect(out.passed).toContain("sitecore-preview-public");
    }
  });

  it("a page that answers every path, and a server error, are could-not-check, never a pass and never a finding", async () => {
    for (const [preview, says] of [
      ["soft-200", /not like a GraphQL endpoint/],
      ["error", /HTTP 503/],
    ] as const) {
      const { reading: r } = await reading(PAGES_HEALTHY, {
        ownerConsent: true,
        settings: SETTINGS,
        fixture: { preview },
      });
      const out = await run(r);
      expect(out.findings).toEqual([]);
      expect(out.passed).not.toContain("sitecore-preview-public");
      expect(reasons(out)).toMatch(says);
    }
  });

  it("is a GET with no key, no cookie and no redirect followed, to the public host only", async () => {
    const calls: { method: string; headers: Record<string, string> }[] = [];
    await reading(PAGES_HEALTHY, {
      ownerConsent: true,
      settings: SETTINGS,
      fixture: {
        preview: "graphql",
        onRequest: (method, url, headers) => {
          if (url.pathname === "/sitecore/api/graph/edge") calls.push({ method, headers });
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["sc_apikey"]).toBeUndefined();
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[0]?.headers.cookie).toBeUndefined();
  });
});
