import { describe, expect, it } from "vitest";
import { crawlExport } from "../../../../fixtures/src/crawl-export.js";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, DEFAULT_USER_AGENT } from "../../fetcher.js";
import { readCrawlExport, summarise } from "../classify.js";
import {
  formatRecheck,
  judge,
  parseVary,
  recheck,
  selectPages,
  varyCoversRsc,
  viewPage,
  type CrawlerView,
} from "../recheck.js";

const view = (
  over: Partial<CrawlerView> & { normalType?: string; prefetchType?: string; words?: number },
): CrawlerView => ({
  url: "https://fernkiln.example/a",
  normal: { status: 200, contentType: over.normalType ?? "text/html", words: over.words ?? 120 },
  prefetch: { status: 200, contentType: over.prefetchType ?? "text/x-component" },
  vary: over.vary ?? ["rsc"],
  exportLines: [],
  ...(over.cdn ? { cdn: over.cdn } : {}),
});

describe("recheck: unit", () => {
  it("Vary parsing: a list, lower case, a repeated header (joined), and *", () => {
    expect(parseVary("RSC, Next-Router-State-Tree")).toEqual(["rsc", "next-router-state-tree"]);
    expect(parseVary("rsc")).toEqual(["rsc"]);
    expect(parseVary("Accept-Encoding, RSC, accept-encoding")).toEqual(["accept-encoding", "rsc"]);
    expect(parseVary(undefined)).toEqual([]);
    expect(varyCoversRsc(parseVary("*"))).toBe(true);
    expect(varyCoversRsc(parseVary("Accept-Encoding"))).toBe(false);
  });

  it("the decision table: both checks and the clean case", () => {
    const ids = (v: CrawlerView) => judge(v).map((f) => f.checkId);
    const table: [Parameters<typeof view>[0], string[]][] = [
      [{}, []],
      [{ vary: [] }, ["rsc-vary-missing"]],
      [{ vary: ["*"] }, []],
      [{ normalType: "text/x-component" }, ["rsc-served-as-page"]],
      [{ normalType: "text/x-component", vary: [] }, ["rsc-served-as-page"]],
      [{ words: 0 }, ["rsc-served-as-page"]],
      [{ words: 0, vary: [] }, ["rsc-served-as-page", "rsc-vary-missing"]],
      [{ words: 0, prefetchType: "text/html" }, []],
      [{ prefetchType: "text/html", vary: [] }, []],
    ];
    for (const [over, want] of table) expect(ids(view(over)), JSON.stringify(over)).toEqual(want);
  });

  it("a CDN in front: rsc-vary-missing says the CDN may be stripping Vary", () => {
    expect(judge(view({ vary: [], cdn: ["x-cache", "via"] }))[0]?.evidence).toContain(
      "A CDN answered (x-cache, via): if the origin sends Vary: RSC, the CDN may be stripping it",
    );
  });

  it("selection order is the same for the same export: most rows first, then by address", () => {
    const pages = summarise(readCrawlExport(crawlExport()).rows).pages;
    const a = selectPages(pages, 5).map((p) => p.url);
    const b = selectPages(new Map([...pages].reverse()), 5).map((p) => p.url);
    expect(a).toEqual(b);
    expect(a.slice(0, 3)).toEqual([
      "https://fernkiln.example/",
      "https://fernkiln.example/about",
      "https://fernkiln.example/classes",
    ]);
    expect(selectPages(pages, 0)).toEqual([]);
  });
});

const withSite = async <T>(
  fn: (
    origin: string,
    fetcher: ReturnType<typeof createFetcher>,
    site: Awaited<ReturnType<typeof startFixture>>,
  ) => Promise<T>,
) => {
  const site = await startFixture("rsc-app");
  try {
    return await fn(site.origin, createFetcher({ hosts: site.hosts }), site);
  } finally {
    await site.close();
  }
};
const ids = async (path: string) =>
  withSite(async (o, f) => {
    const v = await viewPage(f, `${o}${path}`);
    return "reason" in v ? v.reason : judge(v).map((x) => x.checkId);
  });

describe("recheck: integration (the rsc-app fixture)", () => {
  it("text/x-component to the RSC header with Vary: RSC is clean", async () => {
    expect(await ids("/about")).toEqual([]);
  });
  it("the same route without Vary gives exactly rsc-vary-missing", async () => {
    expect(await ids("/classes")).toEqual(["rsc-vary-missing"]);
  });
  it("text/x-component to a normal request gives exactly rsc-served-as-page", async () => {
    expect(await ids("/journal")).toEqual(["rsc-served-as-page"]);
  });
  it("an empty shell while the prefetch works is rsc-served-as-page", async () => {
    expect(await ids("/press")).toEqual(["rsc-served-as-page"]);
  });

  it("--limit 40 makes at most 80 requests, never more than 5 in flight", async () => {
    await withSite(async (_o, f, site) => {
      const pages = selectPages(summarise(readCrawlExport(crawlExport()).rows).pages, 40);
      expect(pages).toHaveLength(40);
      await recheck(pages, { fetcher: f, limit: 40 });
      expect(site.total).toBeLessThanOrEqual(80);
      expect(site.maxConcurrent).toBeLessThanOrEqual(5);
    });
  });

  it("GET only, the run's user agent, and RSC: 1 is the only header added", async () => {
    await withSite(async (o, f, site) => {
      await viewPage(f, `${o}/classes`);
      expect([...site.methods.keys()]).toEqual(["GET"]);
      const [normal, pre] = site.requests.filter((r) => r.path === "/classes");
      expect(normal?.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
      const added = Object.keys(pre?.headers ?? {}).filter((h) => !(h in (normal?.headers ?? {})));
      expect(added).toEqual(["rsc"]);
      expect(pre?.headers.rsc).toBe("1");
    });
  });
});

describe("recheck: edge cases", () => {
  it("a CDN that strips Vary: rsc-vary-missing with the note", async () => {
    const r = await (async () => {
      const site = await startFixture("rsc-app");
      try {
        const v = await viewPage(createFetcher({ hosts: site.hosts }), `${site.origin}/cdn`);
        return "reason" in v ? [] : judge(v);
      } finally {
        await site.close();
      }
    })();
    expect(r.map((f) => f.checkId)).toEqual(["rsc-vary-missing"]);
    expect(r[0]?.evidence).toContain("the CDN may be stripping it");
  });

  it("a static HTML site: the prefetch request returns the same HTML, both checks pass", async () => {
    expect(await ids("/")).toEqual([]);
  });

  it("a redirect is followed, the final address is checked, and RSC goes to same-origin hops only", async () => {
    await withSite(async (o, f, site) => {
      const v = await viewPage(f, `${o}/old-shop`);
      expect("reason" in v ? v.reason : [v.url, judge(v)]).toEqual([`${o}/about`, []]);
      await viewPage(f, `${o}/elsewhere`);
      const other = site.requests.filter(
        (r) => r.path === "/" && r.host === site.hosts["other.example"],
      );
      expect(other.length).toBeGreaterThan(0);
      expect(other.every((r) => r.headers.rsc === undefined)).toBe(true);
    });
  });

  it("429 or 503 is could not check for that page, never a finding", async () => {
    await withSite(async (o, f) => {
      const r = await recheck(
        [
          { url: `${o}/busy`, rows: { lines: [2], payloads: 1 } },
          { url: `${o}/slow-down`, rows: { lines: [3], payloads: 1 } },
        ],
        { fetcher: f },
      );
      expect(r.findings).toEqual([]);
      expect(r.couldNotCheck.map((u) => u.reason)).toEqual(["answered 503", "answered 429"]);
    });
  });

  it("an export with fewer pages than --limit: all are checked, and the line says how many", async () => {
    await withSite(async (o, f) => {
      const pages = [{ url: `${o}/about`, rows: { lines: [2], payloads: 1 } }];
      const r = await recheck(pages, { fetcher: f, limit: 40 });
      expect(formatRecheck(r, { asked: 40, available: 1 })).toBe(
        [
          "Re-checked all 1 page (the export has fewer than --limit 40):",
          "  ✓ /about  47 words; explains 1 export row",
          "1 page re-checked: 1 returns a readable page, 0 need a fix. 1 export row explained.",
        ].join("\n"),
      );
    });
  });
});

describe("recheck: the two checks in a plain site check", () => {
  const RSC_IDS = ["rsc-served-as-page", "rsc-vary-missing"];
  const site = async (path: string) => {
    const s = await startFixture("rsc-app");
    try {
      const { checkSite } = await import("../../site.js");
      const r = await checkSite({
        address: `${s.origin}${path}`,
        fetcher: createFetcher({ hosts: s.hosts }),
        only: RSC_IDS,
      });
      return {
        findings: r.result.findings.map((f) => f.checkId),
        rscRequests: s.requests.filter((q) => q.headers.rsc === "1").length,
      };
    } finally {
      await s.close();
    }
  };

  it("a Next.js page without Vary: exactly rsc-vary-missing, with one extra request", async () => {
    expect(await site("/classes")).toEqual({ findings: ["rsc-vary-missing"], rscRequests: 1 });
  });

  it("a page with no framework signals: nothing, and no extra request", async () => {
    expect(await site("/")).toEqual({ findings: [], rscRequests: 0 });
  });
});
