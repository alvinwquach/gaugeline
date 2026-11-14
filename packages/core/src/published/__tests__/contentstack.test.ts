import { describe, expect, it } from "vitest";
import {
  CONTENTSTACK_MARKERS,
  CONTENTSTACK_SITE,
  contentstackTransport,
} from "../../adapters/__tests__/contentstack-fixture.js";
import { createContentstackAdapter } from "../../adapters/contentstack.js";
import { createFetcher } from "../../fetcher.js";
import { PUBLISHED_CHECKS } from "../../checks/published-not-live.js";
import { page } from "../../checks/__tests__/helpers.js";
import type { CheckContext, Finding } from "../../model.js";
import { createPublished } from "../reader.js";
import { barSite, NOW } from "./world.js";

/**
 * C-26's first extra check: entries published to the environment that are missing from the live site. It is
 * the generic live-page-missing check (F-05) over the Contentstack adapter, so this is the proof that the
 * adapter gives it what it needs: addresses from the entries' URL fields, dates, and fingerprints of the title.
 */
const TOKEN = "test-delivery-token-0123456789";
const API_KEY = "test-stack-api-key-0123456789";

async function run(pages: Parameters<typeof barSite>[0], restricted: string[] = []) {
  const cms = createFetcher({
    transport: contentstackTransport(undefined, { token: TOKEN, apiKey: API_KEY, restricted }),
    timeoutMs: 5000,
  });
  const adapter = createContentstackAdapter({
    env: {
      CONTENTSTACK_API_KEY: API_KEY,
      CONTENTSTACK_DELIVERY_TOKEN: TOKEN,
      CONTENTSTACK_ENVIRONMENT: "production",
    },
    fetcher: cms,
    sleep: () => Promise.resolve(),
  });
  const site = barSite(pages);
  const published = createPublished(
    { adapters: [{ id: "contentstack" }], live: { days: 365 } },
    { env: {}, fetcher: site.fetcher },
    site.fetcher,
    () => [adapter],
  );
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    now: () => NOW,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    published,
  };
  const findings: Finding[] = [];
  for (const check of PUBLISHED_CHECKS)
    findings.push(...(await check.run(page({ finalUrl: `${CONTENTSTACK_SITE}/` }), ctx)));
  return { findings, notes, reading: await published.read(CONTENTSTACK_SITE, NOW), site };
}

const ok = (title: string) => ({ status: 200, title });

describe("--published over a Contentstack stack", () => {
  it("a healthy site: every published entry that has a page answers and shows its title", async () => {
    const { findings, reading } = await run({
      "/rooms/harbour-view": ok(CONTENTSTACK_MARKERS.harbour),
      "/rooms/garden": ok(CONTENTSTACK_MARKERS.garden),
      "/offers/winter-stay": ok(CONTENTSTACK_MARKERS.winter),
    });
    expect(findings.filter((f) => f.checkId === "live-page-missing")).toEqual([]);
    expect(reading.items.filter((i) => i.outcome.kind === "page").length).toBe(3);
  });

  it("drift: an entry published to the environment whose page answers 404 is live-page-missing, by slug and never by title", async () => {
    const { findings, site } = await run({
      "/rooms/harbour-view": ok(CONTENTSTACK_MARKERS.harbour),
      "/offers/winter-stay": ok(CONTENTSTACK_MARKERS.winter),
    });
    const missing = findings.filter((f) => f.checkId === "live-page-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.evidence).toContain("rooms garden");
    expect(missing[0]?.url).toBe(`${CONTENTSTACK_SITE}/rooms/garden`);
    expect(JSON.stringify(findings)).not.toContain(CONTENTSTACK_MARKERS.garden);
    // An entry that was never published to the environment is never asked for.
    expect(site.seen.join("\n")).not.toContain("spring-package");
  });

  it("a content type the token cannot read is a note that says so, not 'nothing published'", async () => {
    const { reading, findings } = await run({}, ["rooms"]);
    expect(reading.notes.join("\n")).toMatch(/contentstack: .*HTTP 403/);
    expect(findings.filter((f) => f.checkId === "live-page-missing")).toEqual([]);
  });
});
