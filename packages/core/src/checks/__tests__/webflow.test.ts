import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createWebflowAdapter } from "../../adapters/webflow.js";
import { readWebflow, type WebflowReading } from "../../adapters/webflow-read.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import {
  COLLECTION_IDS,
  PAGES_DRIFT,
  PAGES_HEALTHY,
  SALTMARSH,
  SALTMARSH_SETTLED,
  SALTMARSH_SITE,
  SITE_ID,
  WEBFLOW_MARKERS,
  webflowTransport,
  type FixtureCollection,
  type WebflowFixtureOptions,
} from "../../adapters/__tests__/webflow-fixture.js";
import { WEBFLOW_CHECKS, createWebflowRegistry } from "../webflow.js";

const KEY = testKey("webflow-checks");
const URLS = {
  events: "/events/{slug}",
  "menu-items": "/menu/{slug}",
  testimonials: "/testimonials/{slug}",
};
/** The testimonials have pages in these tests, so a clean site really is clean. */
const TESTIMONIAL_PAGES = { "/testimonials/a-regular": 200, "/testimonials/a-first-timer": 200 };

async function reading(
  content: readonly FixtureCollection[],
  pages: Readonly<Record<string, number>>,
  options: { fixture?: WebflowFixtureOptions; urls?: Record<string, string>; site?: string } = {},
): Promise<{ reading: WebflowReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: webflowTransport(content, {
      token: KEY,
      pages: { ...TESTIMONIAL_PAGES, ...pages },
      onRequest: (method, url) => seen.push(`${method} ${url.href}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createWebflowAdapter({
    env: { WEBFLOW_TOKEN: KEY, WEBFLOW_SITE_ID: SITE_ID },
    fetcher,
    settings: { id: "webflow", urls: options.urls ?? URLS },
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readWebflow({ adapter, fetcher, site: options.site ?? SALTMARSH_SITE }),
    seen,
  };
}

const run = (r: WebflowReading) => runChecks(r, createWebflowRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);

describe("Webflow checks: a pop-up supper club whose CMS and live site have drifted", () => {
  it("finds the staged event, the staged menu edit and the published event with no page, and nothing else", async () => {
    const { reading: r } = await reading(SALTMARSH, PAGES_DRIFT);
    const out = await run(r);
    expect(evidence(out, "webflow-item-staged")).toEqual([
      "events: winter-warmer is saved and has never been published (last saved 2026-11-08)",
      "menu-items: smoked-trout was saved on 2026-11-09 after it was last published on 2026-10-20",
    ]);
    expect(evidence(out, "webflow-item-no-page")).toEqual([
      "events: oyster-night is published in the CMS and /events/oyster-night answers 404",
    ]);
    expect(out.findings).toHaveLength(3);
    expect(out.findings.map((f) => [f.checkId, f.severity])).toEqual([
      ["webflow-item-no-page", "high"],
      ["webflow-item-staged", "medium"],
      ["webflow-item-staged", "medium"],
    ]);
  });

  it("the findings carry the address the item would have on the live site", async () => {
    const { reading: r } = await reading(SALTMARSH, PAGES_DRIFT);
    const out = await run(r);
    expect(out.findings.map((f) => f.url).sort()).toEqual([
      `${SALTMARSH_SITE}/events/oyster-night`,
      `${SALTMARSH_SITE}/events/winter-warmer`,
      `${SALTMARSH_SITE}/menu/smoked-trout`,
    ]);
  });

  it("a draft and an archived item are never findings", async () => {
    const { reading: r } = await reading(SALTMARSH, PAGES_DRIFT);
    const text = JSON.stringify(await run(r));
    expect(text).not.toContain("new-year-feast");
    expect(text).not.toContain("summer-supper");
  });

  it("never prints the client's words: names, summaries and prices stay out", async () => {
    const { reading: r } = await reading(SALTMARSH, PAGES_DRIFT);
    const text = JSON.stringify([r, await run(r)]);
    for (const marker of Object.values(WEBFLOW_MARKERS)) expect(text).not.toContain(marker);
  });

  it("is deterministic: the same site gives the same findings", async () => {
    const a = await run((await reading(SALTMARSH, PAGES_DRIFT)).reading);
    const b = await run((await reading(SALTMARSH, PAGES_DRIFT)).reading);
    expect(b.findings).toEqual(a.findings);
  });
});

describe("webflow-item-staged: a positive and a negative fixture", () => {
  it("positive: staged work with every page live is found by this check alone", async () => {
    const out = await run((await reading(SALTMARSH, PAGES_HEALTHY)).reading);
    expect(out.findings.every((f) => f.checkId === "webflow-item-staged")).toBe(true);
    expect(out.findings).toHaveLength(2);
    expect(out.passed).toContain("webflow-item-no-page");
    expect(out.passed).not.toContain("webflow-item-staged");
  });

  it("negative: everything published, only a draft and an archived item left, nothing found and both checks pass", async () => {
    const out = await run((await reading(SALTMARSH_SETTLED, PAGES_HEALTHY)).reading);
    expect(out.findings).toEqual([]);
    expect(out.passed.sort()).toEqual(WEBFLOW_CHECKS.map((c) => c.id).sort());
    expect(out.couldNotCheck).toEqual([]);
  });
});

describe("webflow-item-no-page: a positive and a negative fixture", () => {
  it("positive: a published item whose page is gone is found by this check alone", async () => {
    const out = await run((await reading(SALTMARSH_SETTLED, PAGES_DRIFT)).reading);
    expect(out.findings.map((f) => f.checkId)).toEqual(["webflow-item-no-page"]);
  });

  it("a 410 is a missing page too", async () => {
    const out = await run(
      (await reading(SALTMARSH_SETTLED, { ...PAGES_HEALTHY, "/menu/burnt-leek": 410 })).reading,
    );
    expect(evidence(out, "webflow-item-no-page")).toEqual([
      "menu-items: burnt-leek is published in the CMS and /menu/burnt-leek answers 410",
    ]);
  });

  it("negative: a page that answers 200 is not a finding", async () => {
    const out = await run((await reading(SALTMARSH_SETTLED, PAGES_HEALTHY)).reading);
    expect(evidence(out, "webflow-item-no-page")).toEqual([]);
  });

  it("a page that cannot be read (a 503) is could-not-check, not a pass and not a finding", async () => {
    const r = (await reading(SALTMARSH_SETTLED, { ...PAGES_HEALTHY, "/menu/burnt-leek": 503 }))
      .reading;
    const out = await run(r);
    expect(evidence(out, "webflow-item-no-page")).toEqual([]);
    expect(out.passed).not.toContain("webflow-item-no-page");
    const gap = out.couldNotCheck.find((c) => c.reason.includes("503"));
    expect(gap?.id).toBe("webflow-item-no-page");
    expect(gap?.url).toBe(`${SALTMARSH_SITE}/menu/burnt-leek`);
  });

  it("a collection with published items and no address pattern is not asked, and is could-not-check by name, never silence", async () => {
    const { reading: r, seen } = await reading(SALTMARSH_SETTLED, PAGES_HEALTHY, {
      urls: { events: "/events/{slug}" },
    });
    expect(r.withoutPattern).toEqual(["menu-items", "testimonials"]);
    expect(seen.some((s) => s.includes("/menu/"))).toBe(false);
    const out = await run(r);
    expect(out.passed).not.toContain("webflow-item-no-page");
    const gaps = out.couldNotCheck.filter((c) => c.id === "webflow-item-no-page");
    expect(gaps.map((g) => g.reason.split(":")[0])).toEqual(["menu-items", "testimonials"]);
    expect(gaps[0]?.reason).toMatch(/urls/);
    // a collection with a pattern and no published items does not hide the others
    const empty = SALTMARSH_SETTLED.map((c) => (c.slug === "events" ? { ...c, items: [] } : c));
    const again = await run(
      (await reading(empty, PAGES_HEALTHY, { urls: { events: "/events/{slug}" } })).reading,
    );
    expect(again.couldNotCheck.map((g) => g.reason.split(":")[0])).toEqual([
      "menu-items",
      "testimonials",
    ]);
  });

  it("with no address pattern at all there is nothing to check: could-not-check naming `urls`, never a pass", async () => {
    const { reading: r, seen } = await reading(SALTMARSH_SETTLED, PAGES_HEALTHY, { urls: {} });
    expect(seen.some((s) => s.startsWith(`GET ${SALTMARSH_SITE}`))).toBe(false);
    const out = await run(r);
    expect(out.passed).not.toContain("webflow-item-no-page");
    const gap = out.couldNotCheck.find((c) => c.id === "webflow-item-no-page");
    expect(gap?.reason).toMatch(/urls/);
    expect(gap?.reason).toMatch(/gaugeline\.adapters\.json/);
    // staged work needs no address: that check still runs and passes
    expect(out.passed).toContain("webflow-item-staged");
  });
});

describe("Webflow checks: where the platform will not say", () => {
  it("a collection the token may not read is could-not-check for both checks, for that collection only", async () => {
    const { reading: r } = await reading(SALTMARSH, PAGES_DRIFT, {
      fixture: { denied: [COLLECTION_IDS.menu] },
    });
    const out = await run(r);
    // events still read: the staged event and the missing page are found
    expect(evidence(out, "webflow-item-staged")).toHaveLength(1);
    expect(evidence(out, "webflow-item-no-page")).toHaveLength(1);
    const gaps = out.couldNotCheck.filter((c) => c.reason.includes("menu-items"));
    expect(gaps.map((g) => g.id).sort()).toEqual(["webflow-item-no-page", "webflow-item-staged"]);
    expect(out.passed).toEqual([]);
  });

  it("a token with no cms:read stops the whole read with the reason, never a clean result", async () => {
    await expect(
      reading(SALTMARSH, PAGES_HEALTHY, { fixture: { scopes: ["sites:read"] } }),
    ).rejects.toThrow(/cms:read/);
  });

  it("a rate limit that stays marks the reading partial and neither check passes", async () => {
    const seen: string[] = [];
    const fetcher = createFetcher({
      transport: (url, req) => {
        seen.push(url.pathname);
        if (/\/collections\/[^/]+\/items/.test(url.pathname) && seen.length > 3)
          return Promise.resolve({
            status: 429,
            headers: { "retry-after": "3600" },
            body: Readable.from([Buffer.from("{}")]),
          }) as ReturnType<Transport>;
        return webflowTransport(SALTMARSH, { token: KEY, pages: PAGES_HEALTHY })(url, req);
      },
      timeoutMs: 5000,
    });
    const adapter = createWebflowAdapter({
      env: { WEBFLOW_TOKEN: KEY, WEBFLOW_SITE_ID: SITE_ID },
      fetcher,
      settings: { id: "webflow", urls: URLS },
      sleep: () => Promise.resolve(),
    });
    const r = await readWebflow({ adapter, fetcher, site: SALTMARSH_SITE });
    expect(r.partial).toBeDefined();
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.some((c) => /slow down/.test(c.reason))).toBe(true);
  });

  it("only the pages of this site are asked: an address pattern on another host is could-not-check", async () => {
    const { reading: r, seen } = await reading(SALTMARSH_SETTLED, PAGES_HEALTHY, {
      urls: { events: "https://other-host.example/events/{slug}", "menu-items": "/menu/{slug}" },
    });
    expect(seen.some((s) => s.includes("other-host.example"))).toBe(false);
    const out = await run(r);
    expect(out.couldNotCheck.some((c) => /another site/.test(c.reason))).toBe(true);
  });

  it("the page budget is kept: more items than the budget leaves the rest could-not-check", async () => {
    const seen: string[] = [];
    const fetcher = createFetcher({
      transport: webflowTransport(SALTMARSH_SETTLED, {
        token: KEY,
        pages: { ...TESTIMONIAL_PAGES, ...PAGES_HEALTHY },
        onRequest: (m, u) => seen.push(u.href),
      }),
      timeoutMs: 5000,
    });
    const adapter = createWebflowAdapter({
      env: { WEBFLOW_TOKEN: KEY, WEBFLOW_SITE_ID: SITE_ID },
      fetcher,
      settings: { id: "webflow", urls: URLS },
    });
    const r = await readWebflow({ adapter, fetcher, site: SALTMARSH_SITE, maxPages: 2 });
    expect(seen.filter((s) => s.startsWith(SALTMARSH_SITE))).toHaveLength(2);
    expect(r.pagesSkipped).toBe(5);
    const out = await run(r);
    expect(out.passed).not.toContain("webflow-item-no-page");
  });
});

describe("Webflow checks: read only", () => {
  it("asks with GET only, and only the Data API and the pages the CMS says exist", async () => {
    const { seen } = await reading(SALTMARSH, PAGES_DRIFT);
    expect(new Set(seen.map((s) => s.split(" ")[0]))).toEqual(new Set(["GET"]));
    const pages = seen
      .filter((s) => s.includes(SALTMARSH_SITE))
      .map((s) => new URL(s.split(" ")[1] ?? "").pathname);
    expect(pages.sort()).toEqual([
      "/events/harvest-table",
      "/events/oyster-night",
      "/menu/burnt-leek",
      "/menu/smoked-trout",
      "/testimonials/a-first-timer",
      "/testimonials/a-regular",
    ]);
    for (const s of seen) expect(s).not.toContain(KEY);
  });
});

describe("Webflow checks: reads that fall short are reported, never dropped", () => {
  it("a rate limit on the very first call is a partial reading, not a thrown error", async () => {
    const fetcher = createFetcher({
      transport: () =>
        Promise.resolve({
          status: 429,
          headers: { "retry-after": "3600" },
          body: Readable.from([Buffer.from("{}")]),
        }) as ReturnType<Transport>,
      timeoutMs: 5000,
    });
    const adapter = createWebflowAdapter({
      env: { WEBFLOW_TOKEN: KEY, WEBFLOW_SITE_ID: SITE_ID },
      fetcher,
      settings: { id: "webflow", urls: URLS },
      sleep: () => Promise.resolve(),
    });
    const r = await readWebflow({ adapter, fetcher, site: SALTMARSH_SITE });
    expect(r.partial?.reason).toBe("rate-limited");
    expect(r.staged).toEqual([]);
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.some((c) => /slow down/.test(c.reason))).toBe(true);
  });

  it("a pattern that cannot make an address (a host built from an odd slug) is a missing address for that item, and the read goes on", async () => {
    const odd = SALTMARSH.map((c) =>
      c.slug === "events"
        ? {
            ...c,
            items: c.items.map((i) =>
              i.id === "e-winter" || i.id === "e-oyster"
                ? { ...i, fieldData: { ...i.fieldData, slug: "bad slug" } }
                : i,
            ),
          }
        : c,
    );
    const { reading: r } = await reading(odd, PAGES_HEALTHY, {
      urls: { events: "https://{slug}.example/", "menu-items": "/menu/{slug}" },
    });
    const out = await run(r);
    // the staged event is still reported, with the site as its address
    expect(evidence(out, "webflow-item-staged").some((e) => e.includes("bad slug"))).toBe(true);
    expect(out.findings.every((f) => f.url.startsWith(SALTMARSH_SITE))).toBe(true);
    // the published one has no usable address: could-not-check for that item
    const gap = out.couldNotCheck.find((c) => c.reason.includes("e-oyster"));
    expect(gap?.id).toBe("webflow-item-no-page");
    expect(gap?.reason).toMatch(/address/);
  });

  it("a staged finding never carries an address on another site", async () => {
    const { reading: r } = await reading(SALTMARSH, PAGES_HEALTHY, {
      urls: { events: "https://other-host.example/events/{slug}", "menu-items": "/menu/{slug}" },
    });
    const out = await run(r);
    expect(out.findings.every((f) => new URL(f.url).host === new URL(SALTMARSH_SITE).host)).toBe(
      true,
    );
  });

  it("a published item with no slug, where the pattern needs one, is could-not-check for that item", async () => {
    const noSlug = SALTMARSH_SETTLED.map((c) =>
      c.slug === "menu-items"
        ? {
            ...c,
            items: c.items.map((i) => {
              if (i.id !== "m-leek") return i;
              const { slug: _slug, ...rest } = i.fieldData;
              return { ...i, fieldData: rest };
            }),
          }
        : c,
    );
    const { reading: r } = await reading(noSlug, PAGES_HEALTHY);
    const out = await run(r);
    const gap = out.couldNotCheck.find((c) => c.reason.includes("m-leek"));
    expect(gap?.id).toBe("webflow-item-no-page");
    expect(gap?.reason).toMatch(/no slug/);
    expect(out.passed).not.toContain("webflow-item-no-page");
  });
});

describe("Webflow checks: the definitions", () => {
  it("have the four lines the reference prints and are in the registry", () => {
    expect(WEBFLOW_CHECKS.map((c) => c.id)).toEqual([
      "webflow-item-staged",
      "webflow-item-no-page",
    ]);
    const registry = createWebflowRegistry();
    for (const c of WEBFLOW_CHECKS) {
      expect(registry.has(c.id)).toBe(true);
      for (const f of ["what", "why", "fix", "tech"] as const) expect(c[f].trim()).not.toBe("");
    }
  });
});
