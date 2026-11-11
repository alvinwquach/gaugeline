import { describe, expect, it } from "vitest";
import type { Finding } from "../../model.js";
import { createPageRegistry } from "../index.js";
import { addPublishedChecks } from "../../published/registry.js";
import {
  SITE,
  barSite,
  context,
  fakeCms,
  fakeSitemap,
  homePage,
  reader,
  type FixturePage,
} from "../../published/__tests__/world.js";
import {
  livePageMissing,
  publishedNotLive,
  unpublishedStillLive,
  PUBLISHED_CHECKS,
} from "../published-not-live.js";

const CACHED = { age: "3540", "cache-control": "s-maxage=31536000", "x-vercel-cache": "HIT" };
const oldMenu = (over: Partial<FixturePage> = {}): FixturePage => ({
  status: 200,
  title: "Summer menu",
  headers: CACHED,
  ...over,
});

async function runAll(
  published: ReturnType<typeof reader>,
  path = "/",
): Promise<{ byId: Record<string, Finding[]>; notes: { url: string; reason: string }[] }> {
  const { ctx, notes } = context(published);
  const byId: Record<string, Finding[]> = {};
  for (const check of PUBLISHED_CHECKS) byId[check.id] = await check.run(homePage(path), ctx);
  return { byId, notes };
}

describe("published-not-live: integration", () => {
  it("is in sync: no finding when every changed item shows on its page", async () => {
    const { fetcher } = barSite({
      "/menu/autumn": { status: 200, title: "Autumn menu | Lantern & Ladle" },
    });
    const cms = fakeCms([{ slug: "autumn", title: "Autumn menu", minutesAgo: 120 }]);
    const { byId, notes } = await runAll(reader([cms], fetcher));
    expect(byId["published-not-live"]).toEqual([]);
    expect(byId["live-page-missing"]).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("stale by an hour: one high finding with the update time, the cache headers and the field name", async () => {
    const { fetcher } = barSite({ "/menu/autumn": oldMenu() });
    const cms = fakeCms([{ slug: "autumn", title: "Autumn menu", minutesAgo: 62 }]);
    const { byId } = await runAll(reader([cms], fetcher));
    const found = byId["published-not-live"] ?? [];
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("high");
    expect(found[0]?.url).toBe(`${SITE}/menu/autumn`);
    const evidence = found[0]?.evidence ?? "";
    expect(evidence).toContain("2026-11-11T10:58:00.000Z");
    expect(evidence).toContain("62 minutes ago");
    expect(evidence).toContain("differs in: title");
    expect(evidence).toContain("age 3540");
    expect(evidence).toContain("cache-control s-maxage=31536000");
    expect(evidence).toContain("x-vercel-cache HIT");
    // the client's words, from the CMS or from the page, are not in a finding
    expect(evidence).not.toMatch(/Autumn menu|Summer menu/);
  });

  it("the grace period edge: exactly 15 minutes is allowed, 16 is not", async () => {
    const { fetcher } = barSite({ "/menu/a": oldMenu(), "/menu/b": oldMenu() });
    const cms = fakeCms([
      { slug: "a", title: "Autumn menu", minutesAgo: 15 },
      { slug: "b", title: "Autumn menu", minutesAgo: 16 },
    ]);
    const { byId } = await runAll(reader([cms], fetcher));
    expect((byId["published-not-live"] ?? []).map((f) => f.url)).toEqual([`${SITE}/menu/b`]);
  });

  it("a longer grace period from the settings is used", async () => {
    const { fetcher } = barSite({ "/menu/a": oldMenu() });
    const cms = fakeCms([{ slug: "a", title: "Autumn menu", minutesAgo: 62 }]);
    const { byId } = await runAll(reader([cms], fetcher, { graceMinutes: 120 }));
    expect(byId["published-not-live"]).toEqual([]);
  });

  it("a page that shows the title transformed (case, entities) is still a match", async () => {
    const { fetcher } = barSite({
      "/menu/a": { status: 200, title: "FISH &amp; CHIPS NIGHT" },
    });
    const cms = fakeCms([{ slug: "a", title: "Fish & Chips Night", minutesAgo: 600 }]);
    const { byId } = await runAll(reader([cms], fetcher));
    expect(byId["published-not-live"]).toEqual([]);
  });

  it("a 404 on an item changed past the grace period is live-page-missing (high), and not published-not-live", async () => {
    const { fetcher } = barSite({});
    const cms = fakeCms([
      { slug: "gone", title: "Autumn menu", minutesAgo: 90 },
      { slug: "fresh", title: "Winter menu", minutesAgo: 5 },
    ]);
    const { byId } = await runAll(reader([cms], fetcher));
    expect(byId["published-not-live"]).toEqual([]);
    const missing = byId["live-page-missing"] ?? [];
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe("high");
    expect(missing[0]?.url).toBe(`${SITE}/menu/gone`);
    expect(missing[0]?.evidence).toContain("answers 404");
  });

  it("an unpublished item whose page still serves 200 is unpublished-still-live; a 404 is fine", async () => {
    const { fetcher } = barSite({
      "/menu/autumn": { status: 200, title: "Autumn menu", headers: { age: "10" } },
      "/menu/old-cocktails": { status: 200, title: "Old cocktails", headers: { age: "86400" } },
    });
    const cms = fakeCms([{ slug: "autumn", title: "Autumn menu", minutesAgo: 3000 }]);
    const sitemap = fakeSitemap([
      "/menu/autumn",
      "/menu/old-cocktails",
      "/menu/removed-already",
      "/about",
    ]);
    const { byId } = await runAll(reader([cms, sitemap], fetcher));
    const live = byId["unpublished-still-live"] ?? [];
    expect(live).toHaveLength(1);
    expect(live[0]?.severity).toBe("medium");
    expect(live[0]?.url).toBe(`${SITE}/menu/old-cocktails`);
    expect(live[0]?.evidence).toContain("age 86400");
    expect(live[0]?.evidence).not.toContain("Old cocktails");
  });

  it("every request is a GET, and only to the checked site", async () => {
    const { fetcher, seen } = barSite({
      "/menu/a": oldMenu(),
      "/menu/old": { status: 200, title: "Old" },
    });
    const cms = fakeCms([
      { slug: "a", title: "Autumn menu", minutesAgo: 90 },
      {
        slug: "elsewhere",
        title: "Other",
        minutesAgo: 90,
        url: "https://other-site.example/menu/x",
      },
    ]);
    const { notes } = await runAll(reader([cms, fakeSitemap(["/menu/old"])], fetcher));
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
    expect(seen.sort()).toEqual(["GET /menu/a", "GET /menu/old"]);
    expect(notes.map((n) => n.reason).join("\n")).toContain("no address on this site");
  });

  it("asks for at most the page budget, and says how many were left", async () => {
    const { fetcher, seen } = barSite({});
    const cms = fakeCms([
      { slug: "a", title: "A", minutesAgo: 100 },
      { slug: "b", title: "B", minutesAgo: 200 },
      { slug: "c", title: "C", minutesAgo: 300 },
    ]);
    const { notes } = await runAll(reader([cms], fetcher, { maxPages: 2 }));
    expect(seen.sort()).toEqual(["GET /menu/a", "GET /menu/b"]);
    expect(notes.map((n) => n.reason).join("\n")).toContain("1 page was not asked for");
  });

  it("only items changed in the last N days are asked for", async () => {
    const { fetcher, seen } = barSite({});
    const cms = fakeCms([
      { slug: "recent", title: "A", minutesAgo: 60 * 24 * 6 },
      { slug: "old", title: "B", minutesAgo: 60 * 24 * 8 },
    ]);
    await runAll(reader([cms], fetcher));
    expect(seen).toEqual(["GET /menu/recent"]);
  });

  it("a content system that would not answer is could-not-check with its reason, never a pass", async () => {
    const { fetcher } = barSite({});
    const cms = fakeCms([], { failWith: "The key may not read this dataset." });
    const { byId, notes } = await runAll(reader([cms], fetcher));
    expect(byId["published-not-live"]).toEqual([]);
    expect(notes).toEqual([{ url: SITE, reason: "fake-cms: The key may not read this dataset." }]);
  });

  it("a page that answers 500 is could-not-check, not a finding", async () => {
    const { fetcher } = barSite({ "/menu/a": { status: 500, title: "Error" } });
    const cms = fakeCms([{ slug: "a", title: "A", minutesAgo: 100 }]);
    const { byId, notes } = await runAll(reader([cms], fetcher));
    expect(byId["published-not-live"]).toEqual([]);
    expect(byId["live-page-missing"]).toEqual([]);
    expect(notes[0]?.reason).toContain("the page was not read (the site answered 500)");
  });

  it("the same input and clock give the same findings", async () => {
    const make = async () => {
      const { fetcher } = barSite({ "/menu/autumn": oldMenu() });
      const cms = fakeCms([{ slug: "autumn", title: "Autumn menu", minutesAgo: 62 }]);
      return (await runAll(reader([cms], fetcher))).byId;
    };
    expect(await make()).toEqual(await make());
  });

  it("reports once for the site, however many pages the run checks", async () => {
    const { fetcher, seen } = barSite({ "/menu/autumn": oldMenu() });
    const cms = fakeCms([{ slug: "autumn", title: "Autumn menu", minutesAgo: 62 }]);
    const published = reader([cms], fetcher);
    const first = await runAll(published, "/");
    const second = await runAll(published, "/about");
    expect(first.byId["published-not-live"]).toHaveLength(1);
    expect(second.byId["published-not-live"]).toEqual([]);
    expect(seen).toEqual(["GET /menu/autumn"]);
  });
});

describe("published-not-live: unit", () => {
  it("does nothing without --published", async () => {
    const { ctx } = context();
    for (const c of PUBLISHED_CHECKS) expect(await c.run(homePage(), ctx)).toEqual([]);
  });

  it("the three checks have the severities the entry asks for", () => {
    expect(
      [publishedNotLive, livePageMissing, unpublishedStillLive].map((c) => c.severity),
    ).toEqual(["high", "high", "medium"]);
  });

  it("are not in the default registry, and addPublishedChecks adds them once", () => {
    const registry = createPageRegistry();
    for (const c of PUBLISHED_CHECKS) expect(registry.has(c.id)).toBe(false);
    addPublishedChecks(registry);
    addPublishedChecks(registry);
    for (const c of PUBLISHED_CHECKS) expect(registry.has(c.id)).toBe(true);
  });
});
