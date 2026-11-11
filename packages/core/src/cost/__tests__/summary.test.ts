import { describe, expect, it } from "vitest";
import type { Observation, PageRead } from "../judge.js";
import { buildCostSummary, formatCostSummary } from "../summary.js";
import type { UsageRead } from "../usage.js";

const NOW = new Date("2026-11-11T09:00:00Z");

const obs = (body: string, headers: Record<string, string> = {}, status = 200): Observation => ({
  status,
  headers: { "content-type": "text/html", ...headers },
  body,
});

const readOf = (path: string, a: Observation, b: Observation, markedStatic = false): PageRead => ({
  ok: true,
  url: `https://marlowe-bar.example${path}`,
  path,
  markedStatic,
  first: a,
  second: b,
  gapMs: 3000,
});

const hit = obs("<p>Home</p>", {
  "x-vercel-cache": "HIT",
  "cache-control": "public, s-maxage=3600",
});
const reads: PageRead[] = [
  readOf("/", hit, hit, true),
  readOf(
    "/menu",
    obs("<p>m</p>", { "x-vercel-cache": "STALE", "cache-control": "public, s-maxage=1" }),
    obs("<p>m</p>", { "x-vercel-cache": "STALE", "cache-control": "public, s-maxage=1" }),
    true,
  ),
  readOf(
    "/events",
    obs("<p>e</p>", { "x-vercel-cache": "MISS" }),
    obs("<p>e</p>", { "x-vercel-cache": "MISS" }),
    true,
  ),
  readOf(
    "/specials",
    obs("<p>Updated 2026-11-11T09:00:03Z</p>"),
    obs("<p>Updated 2026-11-11T09:00:08Z</p>"),
  ),
  {
    ok: false,
    url: "https://marlowe-bar.example/boom",
    path: "/boom",
    reason: "the connection was reset",
  },
];

const usage: UsageRead = {
  providers: [
    {
      ok: true,
      provider: "Vercel",
      metrics: [
        { name: "Edge Requests", unit: "Requests", daily: new Map([["2026-11-10", 90_000_000]]) },
      ],
    },
    {
      ok: false,
      provider: "Sanity",
      asked: false,
      configured: false,
      reason: "SANITY_TOKEN is not set, so Sanity was not asked",
    },
  ],
};

const base = {
  site: "marlowe-bar.example",
  now: NOW,
  minimumSeconds: 60,
  usageSettings: { window: 14, multiple: 2 },
};

describe("buildCostSummary: top pages by likely cost cause", () => {
  const summary = buildCostSummary({ ...base, reads, usage });

  it("lists the pages with a cause, the likeliest cause first, then by path", () => {
    expect(summary.pages.map((p) => [p.path, p.causes.map((c) => c.id)])).toEqual([
      ["/specials", ["output-changes-every-request"]],
      ["/events", ["never-cached"]],
      ["/menu", ["revalidate-too-often"]],
    ]);
  });

  it("says what is fine and what could not be read", () => {
    expect(summary.fine).toEqual(["/"]);
    expect(summary.unread).toEqual([{ path: "/boom", reason: "the connection was reset" }]);
  });

  it("is deterministic: the same reads in another order give the same summary", () => {
    expect(buildCostSummary({ ...base, reads: [...reads].reverse(), usage })).toEqual(summary);
  });
});

describe("formatCostSummary", () => {
  it("writes plain sentences a client could read", () => {
    const lines = formatCostSummary(buildCostSummary({ ...base, reads, usage }));
    expect(lines).toEqual([
      "Hosting cost for marlowe-bar.example",
      "Pages, likeliest cause of cost first",
      "  /specials  This page changes on every visit because it prints the current time; caching can't help it.",
      "  /events    This page is marked static but it is never served from the CDN's cache, so the host builds it again for every visitor.",
      "  /menu      This page is marked static, but its cache lifetime is 1 second, so the host rebuilds it about every second instead of keeping the last copy.",
      "  Fine: /",
      "  Not read: /boom (the connection was reset)",
      "Account usage",
      "  Vercel: no jump over the 14 days before 10 Nov 2026 (1 metric read)",
      "  Sanity: could not check: SANITY_TOKEN is not set, so Sanity was not asked",
    ]);
  });

  it("a site on a hosted builder is not applicable: fixed plan, not could-not-check", () => {
    const lines = formatCostSummary(
      buildCostSummary({
        ...base,
        reads: [reads[0] as PageRead],
        usage,
        builder: { id: "wix", name: "Wix" },
      }),
    );
    expect(lines).toContain(
      "  Not applicable: fixed plan. Wix charges one plan price, so there is no usage to watch. The page checks above still apply: a page that rebuilds on every visit is slow as well.",
    );
    expect(lines.join("\n")).not.toMatch(/could not check/);
  });

  it("with no problem pages says so", () => {
    const lines = formatCostSummary(
      buildCostSummary({ ...base, reads: [reads[0] as PageRead], usage: { providers: [] } }),
    );
    expect(lines).toContain("  Nothing found: no page changes on every visit or misses the cache.");
  });

  it("with no page marked static says what to set", () => {
    const lines = formatCostSummary(
      buildCostSummary({
        ...base,
        reads: [reads[3] as PageRead],
        usage: { providers: [] },
        staticListed: false,
      }),
    );
    expect(lines.join("\n")).toContain('"static"');
  });

  it("reports a jump with the figures", () => {
    const day = (i: number) => new Date(Date.UTC(2026, 9, 27 + i)).toISOString().slice(0, 10);
    const lines = formatCostSummary(
      buildCostSummary({
        ...base,
        reads: [],
        usage: {
          providers: [
            {
              ok: true,
              provider: "Vercel",
              metrics: [
                {
                  name: "Fast Data Transfer",
                  unit: "GB",
                  daily: new Map(
                    Array.from(
                      { length: 15 },
                      (_, i) => [day(i), i === 14 ? 41_000 : 12_000] as const,
                    ),
                  ),
                },
              ],
            },
          ],
        },
      }),
    );
    expect(lines).toContain(
      "  Vercel: Fast Data Transfer was 41 GB on 10 Nov 2026, 3.4 times its average of 12 GB over the 14 days before",
    );
  });

  it("shows at most five pages and counts the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      readOf(`/p${i}`, obs(`<p>${i}a</p>`), obs(`<p>${i}b</p>`)),
    );
    const lines = formatCostSummary(
      buildCostSummary({ ...base, reads: many, usage: { providers: [] } }),
    );
    expect(lines.filter((l) => l.startsWith("  /p"))).toHaveLength(5);
    expect(lines).toContain("  and 3 more");
  });
});
