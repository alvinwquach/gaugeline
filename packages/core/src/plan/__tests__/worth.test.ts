import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { ConfigError } from "../../errors.js";
import type { Finding } from "../../model.js";
import { checkCoverage, readLive } from "../coverage.js";
import { readPlan } from "../read.js";
import {
  compareWorth,
  parseNumber,
  rankUncovered,
  rankUnknown,
  readRankExport,
  type Worth,
} from "../worth.js";

const PLANS = `${SITES_DIR}../plans/`;
const uncovered = (key: string): Finding => ({
  checkId: "plan-uncovered-page",
  severity: "high",
  title: "A page that exists today has no row in the plan",
  evidence: `${key} exists today and has no row or redirect in the plan`,
  url: "plan.csv",
  group: { key, lines: [] },
});
const w = (clicks?: number, impressions?: number, position?: number): Worth => ({
  source: "search-console",
  ...(clicks !== undefined ? { clicks } : {}),
  ...(impressions !== undefined ? { impressions } : {}),
  ...(position !== undefined ? { position } : {}),
});

describe("worth: unit", () => {
  it("column detection: Search Console English headers, a rank export, headers in another order", async () => {
    const gsc = await readRankExport(
      "Top pages,Clicks,Impressions,CTR,Position\nhttps://x.example/a,5,50,10%,3\n",
    );
    expect([gsc.source, gsc.worth.get("/a")]).toEqual(["search-console", w(5, 50, 3)]);
    const rank = await readRankExport("Keyword,Position,URL\nquiet,4,https://x.example/b\n");
    expect([rank.source, rank.worth.get("/b")]).toEqual([
      "rank-export",
      { source: "rank-export", position: 4 },
    ]);
    const shuffled = await readRankExport("Position,Impressions,Page,Clicks\n2.5,90,/c,7\n");
    expect(shuffled.worth.get("/c")).toEqual(w(7, 90, 2.5));
  });

  it("numbers: 1,240, 12.5%, 3.4, an empty cell, a dash", () => {
    expect(["1,240", "12.5%", "3.4", "", "-", "—", " 7 "].map(parseNumber)).toEqual([
      1240,
      12.5,
      3.4,
      undefined,
      undefined,
      undefined,
      7,
    ]);
  });

  it("sort order: clicks, then impressions, then position, then path; no data last", () => {
    const items: { key: string; worth?: Worth }[] = [
      { key: "/none" },
      { key: "/pos", worth: w(undefined, undefined, 3) },
      { key: "/imp", worth: w(0, 900) },
      { key: "/b", worth: w(10, 100, 5) },
      { key: "/a", worth: w(10, 100, 5) },
      { key: "/c", worth: w(10, 100, 2) },
      { key: "/top", worth: w(50) },
      { key: "/also-none" },
    ];
    expect([...items].sort(compareWorth).map((i) => i.key)).toEqual([
      "/top",
      "/c",
      "/a",
      "/b",
      "/imp",
      "/pos",
      "/also-none",
      "/none",
    ]);
  });

  it("the join: trailing slash, upper case, www and bare host, a query on the export side", async () => {
    const r = await readRankExport(
      "Page,Clicks\nhttps://www.x.example/About/,3\nhttps://x.example/about?utm=1,4\nhttp://x.example/ABOUT,5\n",
    );
    expect(r.worth.get("/about")?.clicks).toBe(12);
    expect(r.worth.size).toBe(1);
  });
});

describe("worth: integration (the 18 uncovered pages of the invented keyword map, joined to a 30-row export)", () => {
  it("highest clicks first, 5 with data, the exact summary; http and https rows summed", async () => {
    const plan = readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));
    const coverage = await checkCoverage(
      plan.rows,
      readLive(createReadStream(`${PLANS}live-nav.txt`)),
    );
    const rank = await readRankExport(createReadStream(`${PLANS}live/gsc-pages.csv`));
    expect(rank.rows).toBe(30);
    expect(rank.range).toBe("1 Sep 2026 – 30 Sep 2026");
    // https://www… and http://… (upper case, trailing slash): one page.
    expect(rank.worth.get("/outsourced-healthcare-operations")).toEqual(w(1240, 18200, 4.1));
    const ranked = rankUncovered(coverage.findings, rank, {
      pages: coverage.pages,
      file: "gsc-pages.csv",
    });
    expect(ranked.summary).toBe(
      "18 live pages have no row in the plan. 5 of them had clicks: 1,661 in total. Numbers from gsc-pages.csv, 1 Sep 2026 – 30 Sep 2026.",
    );
    expect(ranked.findings.slice(0, 5).map((f) => f.evidence)).toEqual([
      "/outsourced-healthcare-operations exists today and has no row or redirect in the plan (1,240 clicks, 18,200 impressions, position 4.1, 1 Sep 2026 – 30 Sep 2026)",
      "/specialties/wound-care-billing exists today and has no row or redirect in the plan (310 clicks, 5,400 impressions, position 7.9, 1 Sep 2026 – 30 Sep 2026)",
      "/services/denial-management exists today and has no row or redirect in the plan (96 clicks, 2,100 impressions, position 9.2, 1 Sep 2026 – 30 Sep 2026)",
      "/company/press exists today and has no row or redirect in the plan (12 clicks, 800 impressions, position 22.3, 1 Sep 2026 – 30 Sep 2026)",
      "/locations/dallas exists today and has no row or redirect in the plan (3 clicks, 410 impressions, position 31, 1 Sep 2026 – 30 Sep 2026)",
    ]);
    // The other 13 have no data: last, by path.
    expect(ranked.findings.slice(5).map((f) => f.group?.key)).toEqual(
      ranked.findings
        .slice(5)
        .map((f) => f.group?.key)
        .sort(),
    );
  });

  it("plan-rank-unknown-address: export pages in neither --live nor the plan, as one low finding", async () => {
    const plan = readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));
    const coverage = await checkCoverage(
      plan.rows,
      readLive(createReadStream(`${PLANS}live-nav.txt`)),
      {
        keepLive: true,
      },
    );
    const rank = await readRankExport(createReadStream(`${PLANS}live/gsc-pages.csv`));
    const planned = new Set(plan.rows.map((r) => r.path.toLowerCase().replace(/\/+$/, "")));
    const out = rankUnknown(
      rank,
      (k) => coverage.liveKeys?.has(k) === true || planned.has(k),
      "gsc-pages.csv",
    );
    expect(out.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
      [
        "plan-rank-unknown-address",
        "low",
        "3 addresses in gsc-pages.csv are in neither --live nor the plan, e.g. /2019/press-release, /de/abrechnung, /old-site/about-us",
      ],
    ]);
  });
});

describe("worth: edge cases", () => {
  it("the Queries tab (no address column) is a ConfigError saying which export to download", async () => {
    const err = await readRankExport(
      "Top queries,Clicks,Impressions,CTR,Position\nbilling help,5,50,10%,3\n",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toBe(
      "--rank: this is a Search Console Queries export; it has no page addresses.",
    );
    expect((err as ConfigError).hint).toBe(
      "In Search Console's Performance report, open the Pages tab and export that.",
    );
  });

  it("the file is closed when reading stops on an error (Windows can't remove an open file)", async () => {
    // A stream that never ends by itself, like a large file still being read.
    const stream = new Readable({ read() {} });
    stream.push("Top queries,Clicks\nbilling,5\n");
    await expect(readRankExport(stream)).rejects.toThrow(ConfigError);
    expect(stream.closed).toBe(true);
  });

  it("a real file is closed by the time the error reaches the caller, not later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-worth-"));
    try {
      writeFileSync(join(dir, "queries.csv"), "Top queries,Clicks\nbilling,5\n");
      const stream = createReadStream(join(dir, "queries.csv"));
      await expect(readRankExport(stream)).rejects.toThrow(ConfigError);
      // destroy() alone closes the file a tick later; on Windows the folder can't be removed then.
      expect(stream.closed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("position 0 or missing while clicks exist: sorted by clicks, shown as unknown", async () => {
    const r = await readRankExport("Page,Clicks,Position\n/a,40,0\n/b,90,\n/c,10,2\n");
    const out = rankUncovered([uncovered("/c"), uncovered("/a"), uncovered("/b")], r);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "/b exists today and has no row or redirect in the plan (90 clicks, position unknown)",
      "/a exists today and has no row or redirect in the plan (40 clicks, position unknown)",
      "/c exists today and has no row or redirect in the plan (10 clicks, position 2)",
    ]);
  });

  it("0 clicks and 900 impressions ranks above a page with no data", async () => {
    const r = await readRankExport("Page,Clicks,Impressions\n/seen,0,900\n");
    expect(
      rankUncovered([uncovered("/none"), uncovered("/seen")], r).findings.map((f) => f.group?.key),
    ).toEqual(["/seen", "/none"]);
  });

  it("an export covering 7 days says so, unscaled", async () => {
    const r = await readRankExport("Date range: Last 7 days\nPage,Clicks\n/a,14\n");
    const out = rankUncovered([uncovered("/a")], r, { file: "week.csv" });
    expect(out.findings[0]?.evidence).toBe(
      "/a exists today and has no row or redirect in the plan (14 clicks, position unknown, Last 7 days)",
    );
    expect(out.summary).toBe(
      "1 live page has no row in the plan. 1 of them had clicks: 14 in total. Numbers from week.csv, Last 7 days.",
    );
  });

  it("--live's own clicks are replaced: --rank wins", async () => {
    const live: Finding = {
      ...uncovered("/a"),
      evidence: "/a exists today and has no row or redirect in the plan (9 clicks)",
    };
    const r = await readRankExport("Page,Clicks\n/a,500\n");
    expect(rankUncovered([live], r).findings[0]?.evidence).toBe(
      "/a exists today and has no row or redirect in the plan (500 clicks, position unknown)",
    );
  });

  it("200,000 export rows read as a stream: memory stays flat apart from the Map", async () => {
    let i = 0;
    const stream = new Readable({
      read() {
        if (i === 0) this.push("Page,Clicks,Impressions\n");
        if (i >= 200_000) return this.push(null);
        const batch: string[] = [];
        for (let k = 0; k < 2000 && i < 200_000; k++, i++)
          batch.push(`/p-${i % 500},${i % 7},${i % 90}`);
        this.push(`${batch.join("\n")}\n`);
      },
    });
    const before = process.memoryUsage().heapUsed;
    const r = await readRankExport(stream);
    expect([r.rows, r.worth.size]).toEqual([200_000, 500]);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(80 * 1024 * 1024);
  }, 30_000);

  it("the same two files give the same order twice, with no request", async () => {
    const plan = readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));
    const once = async () => {
      const coverage = await checkCoverage(
        plan.rows,
        readLive(createReadStream(`${PLANS}live-nav.txt`)),
      );
      const rank = await readRankExport(createReadStream(`${PLANS}live/gsc-pages.csv`));
      return rankUncovered(coverage.findings, rank).findings.map((f) => f.evidence);
    };
    expect(await once()).toEqual(await once());
  });
});
