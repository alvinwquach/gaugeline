import { describe, expect, it } from "vitest";
import { createCraftAdapter } from "../../adapters/craft.js";
import { readCraft, type CraftReading } from "../../adapters/craft-read.js";
import {
  ATELIER_SITE,
  CRAFT_ENDPOINT,
  CRAFT_MARKERS,
  PAGES_DRIFT,
  PAGES_HEALTHY,
  STUDIO_SITE,
  craftTransport,
  type CraftFixtureOptions,
  type FixtureEntry,
  CRAFT_CONTENT,
} from "../../adapters/__tests__/craft-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { CRAFT_CHECKS, createCraftRegistry } from "../craft.js";

const KEY = testKey("craft-checks");
const SETTINGS = { id: "craft", fingerprint: { projects: [], journal: [], team: [] } };

async function reading(
  pages: Readonly<Record<string, number>>,
  options: {
    site?: string;
    craftSite?: string;
    content?: readonly FixtureEntry[];
    fixture?: CraftFixtureOptions;
    settings?: object;
    maxPages?: number;
  } = {},
): Promise<{ reading: CraftReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: craftTransport(options.content ?? CRAFT_CONTENT, {
      token: KEY,
      pages,
      onRequest: (method, url) => seen.push(`${method} ${url.href}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createCraftAdapter({
    env: { CRAFT_URL: CRAFT_ENDPOINT, CRAFT_TOKEN: KEY },
    fetcher,
    settings: (options.settings ?? SETTINGS) as never,
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readCraft({
      adapter,
      fetcher,
      site: options.site ?? STUDIO_SITE,
      ...(options.craftSite !== undefined ? { craftSite: options.craftSite } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: CraftReading) => runChecks(r, createCraftRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>): string[] =>
  r.findings.filter((f) => f.checkId === "craft-entry-no-page").map((f) => f.evidence);

describe("Craft check: an architecture studio on a two-site install", () => {
  it("is registered once", () => {
    expect(CRAFT_CHECKS.map((c) => c.id)).toEqual(["craft-entry-no-page"]);
  });

  it("a healthy install has no finding", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["craft-entry-no-page"]);
  });

  it("finds the entry that is live in Craft and has no page, and nothing else", async () => {
    const { reading: r } = await reading(PAGES_DRIFT);
    const out = await run(r);
    expect(evidence(out)).toEqual([
      "journal: award-shortlist is live in Craft for the studio site and /journal/award-shortlist answers 404",
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.findings[0]?.url).toBe(`${STUDIO_SITE}/journal/award-shortlist`);
  });

  it("a page on the other site's domain is not counted for this site, and is not asked for", async () => {
    const { reading: r, seen } = await reading({
      ...PAGES_HEALTHY,
      [`${ATELIER_SITE}/projets/bibliotheque-du-port`]: 404,
    });
    expect(r.otherSites).toBe(1);
    expect(seen.some((s) => s.includes("fernlight-atelier"))).toBe(false);
    expect((await run(r)).findings).toEqual([]);
  });

  it("checking the other site counts only its own entries", async () => {
    const { reading: r } = await reading(
      { ...PAGES_HEALTHY, [`${ATELIER_SITE}/projets/bibliotheque-du-port`]: 404 },
      { site: ATELIER_SITE },
    );
    expect(r.pages.map((p) => p.siteHandle)).toEqual(["atelier"]);
    expect(r.otherSites).toBe(6);
    expect(evidence(await run(r))).toEqual([
      "projects: bibliotheque-du-port is live in Craft for the atelier site and /projets/bibliotheque-du-port answers 404",
    ]);
  });

  it("an entry switched off for a site is not live there: its page is never asked for", async () => {
    const { seen } = await reading(PAGES_HEALTHY, { site: ATELIER_SITE });
    expect(seen.some((s) => s.includes("bains-de-maree"))).toBe(false);
  });

  it("with the Craft site handle given, only that site is read", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, { craftSite: "studio" });
    expect(r.otherSites).toBe(0);
    const asked = decodeURIComponent(seen.join("\n").replace(/\+/g, " "));
    expect(asked).toContain('site: "studio"');
    expect(asked).not.toContain('site: "*"');
  });

  it("a key lacking permission for one section is could-not-check for that section only", async () => {
    const { reading: r } = await reading(PAGES_DRIFT, { fixture: { forbidden: ["team"] } });
    expect(r.unreadable.map((u) => u.type)).toEqual(["team"]);
    const out = await run(r);
    expect(evidence(out)).toHaveLength(1);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /team: Craft would not give this section/,
    );
  });

  it("a token whose schema can write stops the read before any content is asked for", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, { fixture: { mutationType: true } });
    expect(r.keyRefused).toMatch(/allows mutations/);
    expect(seen).toHaveLength(1);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /will not use a key that can write/,
    );
  });

  it("no section named is could-not-check, never a clean pass, and asks for nothing", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, { settings: { id: "craft" } });
    expect(r.nothingNamed).toBe(true);
    expect(seen).toEqual([]);
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/No section is named/);
  });

  it("a section that returns no live entry is could-not-check: it may be closed to this key", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      content: CRAFT_CONTENT.filter((e) => e.section !== "team"),
    });
    expect(r.empty).toEqual(["team"]);
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /team: Craft returned no live entry/,
    );
  });

  it("a page the live site answers 500 for is could-not-check, not a finding", async () => {
    const { reading: r } = await reading({ ...PAGES_HEALTHY, [`${STUDIO_SITE}/team/ben`]: 500 });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/the page was not read/);
  });

  it("a rate limit that stays marks the reading partial, so what is listed is not taken for everything", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, { fixture: { limitAfter: 2 } });
    expect(r.partial?.reason).toBe("rate-limited");
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/slow down/);
  });

  it("a headless section with no address of its own uses the settings' pattern, and a section with neither is could-not-check", async () => {
    const headless = CRAFT_CONTENT.map((e) => ({ ...e, uri: null }));
    const { reading: r } = await reading(PAGES_HEALTHY, {
      content: headless,
      settings: { id: "craft", urls: { journal: "/journal/{slug}" }, fingerprint: { team: [] } },
      craftSite: "studio",
    });
    expect(r.pages.map((p) => p.path).sort()).toEqual([
      "/journal/award-shortlist",
      "/journal/site-visit-notes",
    ]);
    expect(r.unaddressed.map((u) => u.type)).toEqual(["team", "team"]);
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/Craft gave it no address/);
  });

  it("a pattern that points at another domain is not asked", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      settings: { id: "craft", urls: { journal: "https://elsewhere.example/{slug}" } },
    });
    expect(r.pages).toEqual([]);
    expect(r.unaddressed).toHaveLength(2);
    expect(seen.some((s) => s.includes("elsewhere.example"))).toBe(false);
  });

  it("asks for at most the page budget and says how many it left out", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, { maxPages: 2 });
    expect(r.pages).toHaveLength(2);
    expect(r.pagesSkipped).toBe(4);
    expect((await run(r)).couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /4 pages were not asked for/,
    );
  });

  it("every live entry on another site is could-not-check, never a clean pass (a staging address checked against production URLs)", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      site: "https://staging.fernlight-studio.example",
    });
    expect(r.pages).toEqual([]);
    expect(seen.some((s) => s.includes("staging.fernlight-studio.example/"))).toBe(false);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    const text = out.couldNotCheck.map((c) => c.reason).join("\n");
    expect(text).toMatch(/journal: none of its 2 live entries has a page on this site/);
    expect(text).toContain("fernlight-studio.example");
  });

  it("a headless Craft whose entry addresses are the CMS host, with no urls pattern, is could-not-check by section", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      fixture: { patch: (n) => ({ ...n, url: `https://cms.fernlight.example/${String(n.uri)}` }) },
    });
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /team: none of its 2 live entries has a page on this site.*cms\.fernlight\.example/,
    );
  });

  it("a section with some entries on this site and some on another is counted, not could-not-check", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY);
    expect(r.onOtherSites.map((o) => o.type)).toEqual([]);
  });

  it("a urls pattern on an install with several sites and no site handle is could-not-check, never a false 404", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      settings: { id: "craft", urls: { projects: "/projects/{slug}" } },
    });
    expect(r.patternNeedsSite).toEqual(["projects"]);
    expect(seen.some((s) => s.includes("bibliotheque-du-port"))).toBe(false);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /projects: .*urls pattern.*several sites/,
    );
  });

  it("the same pattern with the Craft site handle given is asked for that site only", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      settings: { id: "craft", urls: { projects: "/projects/{slug}" } },
      craftSite: "studio",
    });
    expect(r.patternNeedsSite).toEqual([]);
    expect(r.pages.map((p) => p.path).sort()).toEqual([
      "/projects/harbour-library",
      "/projects/tidal-baths",
    ]);
    expect((await run(r)).findings).toEqual([]);
  });

  it("a token whose write capability could not be confirmed is a visible could-not-check, not a pass", async () => {
    const { reading: r } = await reading(PAGES_DRIFT, { fixture: { noIntrospection: true } });
    expect(r.keyUnconfirmed).toBe(true);
    const out = await run(r);
    expect(evidence(out)).toHaveLength(1);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /could not confirm this token cannot write.*make the schema query-only/,
    );
    const healthy = await reading(PAGES_HEALTHY);
    expect(healthy.reading.keyUnconfirmed).toBeUndefined();
  });

  it("never puts the client's text in a finding, the reading or the key anywhere", async () => {
    const { reading: r } = await reading(PAGES_DRIFT);
    const text = JSON.stringify([r, await run(r)]);
    for (const m of Object.values(CRAFT_MARKERS)) expect(text).not.toContain(m);
    expect(text).not.toContain(KEY);
  });
});
