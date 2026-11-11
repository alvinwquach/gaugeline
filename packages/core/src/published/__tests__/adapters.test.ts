import { describe, expect, it } from "vitest";
import { ENTRIES } from "../../adapters/__tests__/entries.js";
import { recording, type Seen } from "../../adapters/__tests__/contract.js";
import { TIDEWATER } from "../../adapters/__tests__/builders-fixture.js";
import { LANTERN } from "../../adapters/__tests__/framer-fixture.js";
import { OAKLINE } from "../../adapters/__tests__/sitemap-feed-fixture.js";
import { MARLOW } from "../../adapters/__tests__/wix-fixture.js";
import type { AdaptersConfig } from "../../adapters/config.js";
import { createFetcher } from "../../fetcher.js";
import { PUBLISHED_CHECKS } from "../../checks/published-not-live.js";
import type { CheckContext, Finding } from "../../model.js";
import { page } from "../../checks/__tests__/helpers.js";
import { createPublished } from "../reader.js";

/**
 * --published against every adapter on main, over the contract suite's own recorded answers (one entry per
 * adapter in adapters/__tests__/entries.ts, so a new adapter is covered here as soon as it has its entry).
 * Each content system is asked for what changed "lately" (the window is made wide enough to take in the
 * invented fixtures' dates), each changed item's page is asked for with GET, and the three checks run.
 */
const SITES: Readonly<Record<string, string>> = {
  "sitemap-feed": OAKLINE,
  framer: LANTERN,
  wix: MARLOW,
  squarespace: TIDEWATER,
  duda: TIDEWATER,
  tilda: TIDEWATER,
  godaddy: TIDEWATER,
  weebly: TIDEWATER,
  carrd: TIDEWATER,
  strikingly: TIDEWATER,
};
const PAGE_READERS = new Set(Object.keys(SITES));
const DEFAULT_SITE = "https://fernhill-coaching.example";
const NOW = new Date("2026-11-11T12:00:00.000Z");
const WIDE = 100 * 365;

describe.each(ENTRIES.map((e) => [e.id, e] as const))(
  "--published over the %s adapter",
  (_id, entry) => {
    const site = SITES[entry.id] ?? DEFAULT_SITE;

    async function run() {
      const seen: Seen[] = [];
      const fetcher = createFetcher({
        transport: recording(entry.transport(), seen),
        timeoutMs: 5000,
      });
      const adapter = entry.make({ fetcher, sleep: () => Promise.resolve() });
      const config: AdaptersConfig = {
        adapters: [{ id: adapter.id }],
        live: { days: 1, maxPages: 200 },
      };
      // The window is widened past the schema's own cap: the fixtures' dates are older than 90 days.
      const wide: AdaptersConfig = { ...config, live: { ...config.live, days: WIDE } };
      const published = createPublished(wide, { env: {}, fetcher }, fetcher, () => [adapter]);
      const notes: { url: string; reason: string }[] = [];
      const ctx: CheckContext = {
        warn: () => undefined,
        now: () => NOW,
        couldNotCheck: (url, reason) => void notes.push({ url, reason }),
        published,
      };
      const findings: Finding[] = [];
      for (const check of PUBLISHED_CHECKS)
        findings.push(...(await check.run(page({ finalUrl: `${site}/` }), ctx)));
      const reading = await published.read(site, NOW);
      return { seen, findings, notes, reading };
    }

    it("reads without throwing, and every item has an answer or a reason", async () => {
      const { reading } = await run();
      // A page reader lists the site's own pages, each with a date, so something is always compared.
      if (PAGE_READERS.has(entry.id)) expect(reading.items.length).toBeGreaterThan(0);
      for (const item of reading.items) {
        expect(["page", "missing", "unread"]).toContain(item.outcome.kind);
        expect(item.adapter).toBe(entry.id);
        expect(new URL(item.url).origin).toBe(site);
      }
    });

    it("sends only GET or HEAD", async () => {
      const { seen } = await run();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
    });

    it("never puts the key or a secret text of the content system into a finding or a note", async () => {
      const { findings, notes, reading } = await run();
      const out = JSON.stringify({ findings, notes, reading });
      for (const secret of [...entry.secrets, ...(entry.key ? [entry.key] : [])])
        expect(out).not.toContain(secret);
    });

    it("is the same twice: the same input and clock give the same findings", async () => {
      const a = await run();
      const b = await run();
      expect(JSON.stringify(b.findings)).toBe(JSON.stringify(a.findings));
      expect(JSON.stringify(b.reading)).toBe(JSON.stringify(a.reading));
    });
  },
);

describe("--published over a page reader: what its pages say", () => {
  it("compares the pages a sitemap lists with the site, and finds nothing to compare by field", async () => {
    const entry = ENTRIES.find((e) => e.id === "framer");
    expect(entry).toBeDefined();
    const fetcher = createFetcher({ transport: entry!.transport(), timeoutMs: 5000 });
    const adapter = entry!.make({ fetcher, sleep: () => Promise.resolve() });
    const published = createPublished(
      { adapters: [{ id: "framer" }], live: { days: WIDE } },
      { env: {}, fetcher },
      fetcher,
      () => [adapter],
    );
    const reading = await published.read(LANTERN, NOW);
    // A page reader has no fields: nothing is compared by field, so no page is reported stale for its text.
    for (const item of reading.items) expect(item.compared).toEqual([]);
    for (const item of reading.items)
      if (item.outcome.kind === "page") expect(item.outcome.differing).toEqual([]);
  });
});
