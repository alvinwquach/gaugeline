import { createReadStream, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import {
  checkCoverage,
  coverageKey,
  detectLiveFormat,
  globToRegExp,
  ignored,
  readLive,
  type LiveRead,
  type LiveUrl,
} from "../coverage.js";
import { readPlan, type PlanRow } from "../read.js";

const PLANS = `${SITES_DIR}../plans/`;
const row = (line: number, path: string, legacyUrl?: string): PlanRow => ({
  line,
  url: path,
  path,
  raw: {},
  ...(legacyUrl ? { legacyUrl } : {}),
});
const all = async (stream: Readable) => {
  const out: LiveUrl[] = [];
  let format: LiveRead | undefined;
  for await (const u of readLive(stream, (f) => (format = f))) out.push(u);
  return { urls: out, format };
};

describe("pages with nowhere to go: unit", () => {
  it("format detection: a crawl CSV, a sitemap, a Search Console CSV, a plain list", async () => {
    expect(detectLiveFormat('"Address","Content Type","Status Code"')).toEqual({ format: "crawl" });
    expect(detectLiveFormat('<?xml version="1.0"?>\n<urlset>')).toEqual({ format: "sitemap" });
    expect(detectLiveFormat("Top pages,Clicks,Impressions,CTR,Position")).toEqual({
      format: "search-console",
      metric: "clicks",
    });
    expect(detectLiveFormat("https://x.example/a")).toEqual({ format: "list" });

    const crawl = await all(createReadStream(`${PLANS}live/crawl.csv`));
    expect(crawl.format?.format).toBe("crawl");
    // The 404 row is dropped (not a page today); the stylesheet is left to the ignore rules.
    expect(crawl.urls.map((u) => u.url)).toEqual([
      "https://www.harbourline.example/",
      "https://www.harbourline.example/specialties/wound-care-billing",
      "https://www.harbourline.example/assets/site.css",
    ]);
    const gsc = await all(createReadStream(`${PLANS}live/search-console.csv`));
    expect(gsc.urls.map((u) => u.metric)).toEqual([1240, 310, 12]);
    const sitemap = await all(createReadStream(`${PLANS}live/sitemap.xml`));
    expect(sitemap.urls).toHaveLength(3);
    const list = await all(createReadStream(`${PLANS}live/list.txt`));
    expect(list.urls.map((u) => u.url)).toEqual([
      "https://www.harbourline.example/",
      "/contact-sales",
      "https://www.harbourline.example/feed/",
    ]);
  });

  it("the set difference ignores a trailing slash, case and the query", async () => {
    expect(coverageKey("https://x.example/About/Team/?ref=nav#top")).toBe("/about/team");
    expect(coverageKey("/")).toBe("/");
    const out = await checkCoverage(
      [row(2, "/about/team"), row(3, "/")],
      [
        { url: "https://x.example/About/Team/" },
        { url: "https://x.example/?utm_source=x" },
        { url: "https://x.example/new" },
      ],
    );
    expect(out.findings.map((f) => f.group?.key)).toEqual(["/new"]);
  });

  it("assets, feeds, paginated pages and --ignore globs are not pages", () => {
    for (const u of [
      "/a.css",
      "/img/x.WEBP",
      "/feed/",
      "/blog/rss",
      "/blog?page=3",
      "/blog/page/2",
    ])
      expect(ignored(u), u).toBe(true);
    expect(ignored("/pricing")).toBe(false);
    expect(ignored("/tag/billing", [globToRegExp("/tag/*")])).toBe(true);
    expect(ignored("/tag/a/b", [globToRegExp("/tag/*")])).toBe(false);
    expect(ignored("/tag/a/b", [globToRegExp("/tag/**")])).toBe(true);
  });
});

describe("pages with nowhere to go: integration (the invented keyword map against today's navigation)", () => {
  it("51 live addresses: 18 uncovered, among them wound care billing and outsourced operations", async () => {
    const plan = readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));
    const out = await checkCoverage(plan.rows, readLive(createReadStream(`${PLANS}live-nav.txt`)), {
      file: "keyword-map.csv",
    });
    expect(out.live).toBe(51);
    expect(out.findings).toHaveLength(18);
    const keys = out.findings.map((f) => f.group?.key);
    expect(keys).toContain("/specialties/wound-care-billing");
    expect(keys).toContain("/outsourced-healthcare-operations");
    expect(out.findings[0]).toMatchObject({
      checkId: "plan-uncovered-page",
      severity: "high",
      url: "keyword-map.csv",
    });
  });
});

describe("pages with nowhere to go: edge cases", () => {
  it("the file is closed when the caller stops reading early", async () => {
    const stream = new Readable({ read() {} });
    stream.push("/a\n/b\n/c\n");
    for await (const u of readLive(stream)) if (u.url === "/a") break;
    expect(stream.closed).toBe(true);
  });

  it("a live address covered only by a row's Legacy URL is covered", async () => {
    const out = await checkCoverage(
      [row(2, "/new", "/old\n/older")],
      [{ url: "/old" }, { url: "/older/" }],
    );
    expect(out.findings).toEqual([]);
  });

  it("the plan uses /resources/blog/… and the site /blog/…: one grouped finding, not 101", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => row(i + 2, `/resources/blog/post-${i + 1}`));
    const live = rows.map((r) => ({ url: `https://x.example${r.path.replace("/resources", "")}` }));
    const out = await checkCoverage(rows, [...live, { url: "https://x.example/pricing" }]);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "101 rows assume a path prefix that does not exist today: the plan has /resources/…, the site has none (101 pages, e.g. /blog/post-1)",
      "/pricing exists today and has no row or redirect in the plan",
    ]);
    expect(out.findings[0]?.group?.lines).toHaveLength(101);
  });

  it("sorted by clicks when the export has them, with the number in the evidence", async () => {
    const gsc = readLive(createReadStream(`${PLANS}live/search-console.csv`));
    const out = await checkCoverage([row(2, "/")], gsc, { metric: "clicks" });
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "/outsourced-healthcare-operations exists today and has no row or redirect in the plan (1,240 clicks)",
      "/specialties/wound-care-billing exists today and has no row or redirect in the plan (310 clicks)",
      "/company/press exists today and has no row or redirect in the plan (12 clicks)",
    ]);
  });

  it("200,000 live addresses read as a stream: memory stays flat", async () => {
    const total = 200_000;
    let i = 0;
    // A stream that makes its lines as it is read: the file never exists whole in memory.
    const stream = new Readable({
      read() {
        if (i >= total) return this.push(null);
        const batch: string[] = [];
        for (let n = 0; n < 1000 && i < total; n++, i++)
          batch.push(`https://x.example/${i % 10 === 0 ? `orphan-${i}` : `page-${i % 50}`}`);
        this.push(`${batch.join("\n")}\n`);
      },
    });
    const rows = Array.from({ length: 50 }, (_, n) => row(n + 2, `/page-${n}`));
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const out = await checkCoverage(rows, readLive(stream));
    expect(out.live).toBe(total);
    expect(out.findings).toHaveLength(total / 10);
    // The findings themselves are kept (20,000 of them); the 200,000 lines are not.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(120 * 1024 * 1024);
  }, 30_000);
});
