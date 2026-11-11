import { describe, expect, it } from "vitest";
import {
  AEM_ENV,
  AEM_MARKERS,
  AEM_SITE,
  aemTransport,
} from "../../adapters/__tests__/aem-fixture.js";
import { createAemAdapter } from "../../adapters/aem.js";
import type { AdapterSettings } from "../../adapters/types.js";
import { createFetcher } from "../../fetcher.js";
import { PUBLISHED_CHECKS } from "../../checks/published-not-live.js";
import { page } from "../../checks/__tests__/helpers.js";
import type { CheckContext, Finding } from "../../model.js";
import { createPublished } from "../reader.js";
import { barSite, NOW } from "./world.js";

/**
 * C-30's first extra check: Content Fragments published to the publish tier that are missing from the live site.
 * It is the generic live-page-missing check (F-05) over the AEM adapter, so this is the proof that the adapter
 * gives it what it needs: addresses from the settings' patterns, the fragment's time, and fingerprints of a field.
 */
const SETTINGS: AdapterSettings = {
  id: "aem",
  fingerprint: { rooms: ["name"], offers: ["name"], venues: ["name"] },
  urls: { rooms: "/rooms/{slug}", offers: "/offers/{slug}", venues: "/venues/{slug}" },
};

async function run(pages: Parameters<typeof barSite>[0], refuse: Record<string, number> = {}) {
  const cms = createFetcher({ transport: aemTransport(undefined, { refuse }), timeoutMs: 5000 });
  const adapter = createAemAdapter({
    env: AEM_ENV,
    fetcher: cms,
    sleep: () => Promise.resolve(),
    settings: SETTINGS,
  });
  const site = barSite(pages);
  const published = createPublished(
    { adapters: [SETTINGS], live: { days: 365 } },
    { env: {}, fetcher: site.fetcher },
    site.fetcher,
    () => [adapter],
  );
  const ctx: CheckContext = {
    warn: () => undefined,
    now: () => NOW,
    couldNotCheck: () => undefined,
    published,
  };
  const findings: Finding[] = [];
  for (const check of PUBLISHED_CHECKS)
    findings.push(...(await check.run(page({ finalUrl: `${AEM_SITE}/` }), ctx)));
  return { findings, reading: await published.read(AEM_SITE, NOW), site };
}

const ok = (title: string) => ({ status: 200, title });

describe("--published over an AEM publish tier", () => {
  it("a healthy site: every published fragment that has a page answers and shows its field", async () => {
    const { findings, reading } = await run({
      "/rooms/harbour-view": ok(AEM_MARKERS.harbour),
      "/rooms/garden": ok(AEM_MARKERS.garden),
      "/offers/winter-stay": ok(AEM_MARKERS.winter),
      "/venues/terrace": ok("Terrace"),
      "/venues/cellar": ok("Cellar"),
    });
    expect(findings).toEqual([]);
    expect(reading.items.filter((i) => i.outcome.kind === "page").length).toBe(5);
  });

  it("drift: a published fragment whose page answers 404 is live-page-missing, by slug and never by text", async () => {
    const { findings, site } = await run({
      "/rooms/harbour-view": ok(AEM_MARKERS.harbour),
      "/offers/winter-stay": ok(AEM_MARKERS.winter),
      "/venues/terrace": ok("Terrace"),
      "/venues/cellar": ok("Cellar"),
    });
    const missing = findings.filter((f) => f.checkId === "live-page-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.evidence).toContain("garden");
    expect(missing[0]?.url).toBe(`${AEM_SITE}/rooms/garden`);
    expect(JSON.stringify(findings)).not.toContain(AEM_MARKERS.garden);
    // A draft is not in the publish tier's answer, so its page is never asked for.
    expect(site.seen.join("\n")).not.toContain("winter-suite");
  });

  it("drift: a page whose title no longer matches the fragment's field is published-not-live, naming the field only", async () => {
    const { findings } = await run({
      "/rooms/harbour-view": ok("An older title"),
      "/rooms/garden": ok(AEM_MARKERS.garden),
      "/offers/winter-stay": ok(AEM_MARKERS.winter),
      "/venues/terrace": ok("Terrace"),
      "/venues/cellar": ok("Cellar"),
    });
    const stale = findings.filter((f) => f.checkId === "published-not-live");
    expect(stale).toHaveLength(1);
    expect(stale[0]?.evidence).toContain("name");
    expect(JSON.stringify(findings)).not.toContain(AEM_MARKERS.harbour);
  });

  it("a persisted query the publish tier protects is a note that says so, not 'nothing published'", async () => {
    const { reading, findings } = await run({}, { offers: 401 });
    expect(reading.notes.join("\n")).toMatch(/aem: .*asked for a login \(HTTP 401\)/);
    expect(findings.filter((f) => f.checkId === "live-page-missing")).toEqual([]);
  });
});
