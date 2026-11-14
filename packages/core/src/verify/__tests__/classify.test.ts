import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { crawlExport } from "../../../../fixtures/src/crawl-export.js";
import { parseCsv } from "../../plan/columns.js";
import {
  classify,
  formatSummary,
  NoAddressColumnError,
  readCrawlExport,
  summarise,
  summariseStream,
  type CrawlRow,
} from "../classify.js";
import { createCsvStream } from "../csv-stream.js";

const H = "https://fernkiln.example";

describe("verify: unit", () => {
  it("the classifier table: three frameworks, pages, assets and API routes", () => {
    const table: [string, string, string?, string?][] = [
      // Next.js App Router prefetches
      [`${H}/shop?_rsc=1a2b3`, "prefetch-payload", "next", `${H}/shop`],
      [`${H}/?_rsc=x`, "prefetch-payload", "next", `${H}/`],
      [`${H}/journal/notes-1/?_rsc=abc`, "prefetch-payload", "next", `${H}/journal/notes-1`],
      [`${H}/shop?page=2&_rsc=9f`, "prefetch-payload", "next", `${H}/shop?page=2`],
      // Next.js Pages Router data
      [
        `${H}/_next/data/build123/shop/moon-jar.json`,
        "prefetch-payload",
        "next",
        `${H}/shop/moon-jar`,
      ],
      [`${H}/_next/data/build123/index.json`, "prefetch-payload", "next", `${H}/`],
      [
        `${H}/_next/data/b/journal/index.json?slug=a`,
        "prefetch-payload",
        "next",
        `${H}/journal?slug=a`,
      ],
      // Nuxt payloads
      [`${H}/about/_payload.json`, "prefetch-payload", "nuxt", `${H}/about`],
      [`${H}/_payload.json?7c1d2e`, "prefetch-payload", "nuxt", `${H}/`],
      [`${H}/shop/_payload.json?v=2`, "prefetch-payload", "nuxt", `${H}/shop?v=2`],
      // Astro data under its build directory
      [`${H}/_astro/glazes.Bz1x.json`, "prefetch-payload", "astro"],
      // Assets
      [`${H}/_next/static/chunks/app-1.js`, "asset"],
      [`${H}/_next/static/css/a.css`, "asset"],
      [`${H}/_astro/index.4f2a.css`, "asset"],
      [`${H}/_nuxt/entry.BX12.js`, "asset"],
      [`${H}/images/moon-jar.webp`, "asset"],
      [`${H}/fonts/serif.woff2`, "asset"],
      [`${H}/app.js.map`, "asset"],
      [`${H}/price-list.pdf`, "asset"],
      [`${H}/favicon.ico`, "asset"],
      // Data routes
      [`${H}/api/stock?sku=FK-1`, "data-route"],
      [`${H}/api`, "data-route"],
      [`${H}/data/glazes.json`, "data-route"],
      [`${H}/export/orders.xml`, "data-route"],
      // Pages, sitemaps and feeds included
      [`${H}/sitemap.xml`, "page", undefined, `${H}/sitemap.xml`],
      [`${H}/sitemap-pots.xml`, "page", undefined, `${H}/sitemap-pots.xml`],
      [`${H}/rss.xml`, "page", undefined, `${H}/rss.xml`],
      [`${H}/shop/moon-jar`, "page", undefined, `${H}/shop/moon-jar`],
      [`${H}/apiary-visit`, "page", undefined, `${H}/apiary-visit`],
      [`${H}/journal/`, "page", undefined, `${H}/journal`],
    ];
    expect(table).toHaveLength(30);
    for (const [address, kind, framework, pageUrl] of table)
      expect(classify({ address }), address).toEqual({
        kind,
        ...(framework ? { framework } : {}),
        ...(pageUrl ? { pageUrl } : {}),
      });
  });

  it("a prefetch URL resolves to its page; other query parameters are kept", () => {
    expect(classify({ address: `${H}/shop?utm_source=mail&_rsc=1a&ref=x` }).pageUrl).toBe(
      `${H}/shop?utm_source=mail&ref=x`,
    );
  });

  it("address column detection: Address, URL, a sitemap-style loc", () => {
    for (const header of ["Address", "URL", "loc"])
      expect(readCrawlExport(`Status,${header}\n200,${H}/a\n`).columns.address).toBe(header);
  });

  it("the streaming reader reads what parseCsv reads, whatever the chunk boundaries", () => {
    const text = `\uFEFFa,"b, with comma","c ""quoted"""\r\n1,"two\nlines",3\r\nx,,z`;
    const want = parseCsv(text.slice(1));
    for (const size of [1, 2, 3, 7, 1000]) {
      const csv = createCsvStream();
      const got = [];
      for (let i = 0; i < text.length; i += size) got.push(...csv.push(text.slice(i, i + size)));
      got.push(...csv.end());
      expect(got, `chunks of ${size}`).toEqual(want);
    }
  });
});

describe("verify: integration", () => {
  it("the 4,180-row export with 4,061 payload rows prints the quoted sentence exactly", () => {
    const { rows, columns } = readCrawlExport(crawlExport());
    expect(columns).toEqual({ address: "Address", issue: "Issue" });
    const s = summarise(rows);
    expect(formatSummary(s).split("\n")[0]).toBe(
      "4,061 of 4,180 orphan URLs were prefetch payloads",
    );
    expect(s.byKind).toEqual({ "prefetch-payload": 4061, asset: 70, "data-route": 15, page: 34 });
    expect(s.pages.size).toBe(40);
  });

  it("300 payload rows for 12 pages give a pages Map of size 12", () => {
    const rows: CrawlRow[] = Array.from({ length: 300 }, (_, i) => ({
      line: i + 2,
      address: `${H}/shop/pot-${i % 12}?_rsc=${i}`,
    }));
    const s = summarise(rows);
    expect(s.pages.size).toBe(12);
    expect(s.pages.get(`${H}/shop/pot-0`)).toMatchObject({ payloads: 25 });
    expect(s.pages.get(`${H}/shop/pot-0`)?.lines).toHaveLength(25);
  });
});

describe("verify: edge cases", () => {
  it("an export with no issue column: the summary has no issue grouping", () => {
    const { rows, columns } = readCrawlExport(`Address\n${H}/a?_rsc=1\n${H}/a\n${H}/x.js\n`);
    expect(columns).toEqual({ address: "Address" });
    expect(formatSummary(summarise(rows))).toBe(
      [
        "1 of 3 rows were prefetch payloads",
        "  1 prefetch payload",
        "  1 asset",
        "  0 data routes",
        "  1 page",
        "1 distinct page behind them, the addresses to re-check",
      ].join("\n"),
    );
  });

  it("an export in another language: the address column is found by its content", () => {
    const r = readCrawlExport(
      `Statut,Adresse,Problème\n200,${H}/a?_rsc=1,URL orphelines\n200,${H}/b,URL orphelines\n`,
    );
    // The issue column is matched by its English name only: here the summary has no grouping.
    expect(r.columns).toEqual({ address: "Adresse" });
    expect(r.rows.map((x) => x.address)).toEqual([`${H}/a?_rsc=1`, `${H}/b`]);
    expect(r.warnings).toEqual([
      'No column is named Address or URL: read "Adresse", where most cells are web addresses.',
    ]);
  });

  it("no address column at all is an error naming the header", () => {
    expect(() => readCrawlExport("Status,Title\n200,Home\n")).toThrow(NoAddressColumnError);
  });

  it("a page that legitimately has ?_rsc in a link is still a payload row", () => {
    expect(classify({ address: `${H}/campaign?_rsc=summer` }).kind).toBe("prefetch-payload");
  });

  it("a fragment, an upper-case host or a trailing slash map to the same page key", () => {
    const keys = [
      `${H}/shop`,
      `${H}/shop/`,
      `https://FERNKILN.Example/shop#pots`,
      `${H}/shop?_rsc=1`,
    ].map((address) => classify({ address }).pageUrl);
    expect(new Set(keys)).toEqual(new Set([`${H}/shop`]));
  });

  it("a row with an empty address is skipped and counted", () => {
    const { rows } = readCrawlExport(
      `Address,Issue\n${H}/a,Orphan URLs\n,Orphan URLs\n  ,Orphan URLs\n`,
    );
    const s = summarise(rows);
    expect([s.total, s.skipped]).toEqual([1, 2]);
    expect(formatSummary(s)).toContain("2 rows with no address skipped");
  });

  it("a 200,000-row export is read as a stream, and memory follows pages, not rows", async () => {
    let made = 0;
    async function* chunks() {
      yield "Address,Issue\n";
      for (let b = 0; b < 200; b++) {
        let block = "";
        for (let i = 0; i < 1000; i++, made++)
          block += `${H}/shop/pot-${made % 12}?_rsc=${made.toString(16)},Orphan URLs\n`;
        yield block;
      }
    }
    // What the summary keeps, measured after a full collection on both sides: heapUsed alone also
    // counts garbage not yet collected, which swings with whatever else the machine is running.
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as () => void;
    const retained = async <T>(make: () => Promise<T> | T): Promise<[T, number]> => {
      gc();
      const before = process.memoryUsage().heapUsed;
      const value = await make();
      gc();
      return [value, process.memoryUsage().heapUsed - before];
    };
    const [{ summary }, kept] = await retained(() => summariseStream(chunks()));
    expect([summary.total, summary.pages.size]).toEqual([200_000, 12]);
    // Each page keeps line numbers only, never the rows' text.
    expect(summary.pages.get(`${H}/shop/pot-0`)?.lines.slice(0, 2)).toEqual([2, 14]);
    // 200,000 line numbers are about 2 MB. The export's text is about 12 MB: holding it, as reading
    // the file whole would, fails the same bound, so the bound tells the two apart.
    const BOUND = 8 * 1024 * 1024;
    expect(kept).toBeLessThan(BOUND);
    made = 0;
    const [whole, held] = await retained(async () => {
      let text = "";
      for await (const block of chunks()) text += block;
      return text.split("\n");
    });
    expect(whole.length).toBeGreaterThan(200_000);
    expect(held).toBeGreaterThan(BOUND);
  });
});
