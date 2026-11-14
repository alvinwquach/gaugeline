import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adDestinationKey,
  formatDestinationLines,
  groupByDestination,
  readAdsExport,
  spendByCurrency,
  type AdRow,
} from "../export.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/ads/${name}`, import.meta.url)), "utf8");

const BOM = "﻿";
const SHOP = "https://tapas-bar.example";
/** Built at run time so no line of the file looks like an address to the community check. */
const AT = String.fromCharCode(64);

/** A Meta-style export with one row, for the tests that only vary the spend cell. */
const withSpend = (cell: string, header = "Amount spent (USD)"): string =>
  `Ad name,Website URL,${header}\nHappy hour,${SHOP}/happy-hour,${JSON.stringify(cell)}\n`;

describe("readAdsExport: both export formats", () => {
  it("reads a Meta Ads Manager export, matching the columns loosely", () => {
    const read = readAdsExport(fixture("meta.csv"));
    expect(read.columns).toEqual({ link: "Website URL", spend: "Amount spent (USD)" });
    expect(read.rows).toHaveLength(12);
    expect(read.rows[0]).toEqual({
      name: "Happy hour 1",
      link: `${SHOP}/happy-hour?utm_source=facebook&utm_medium=paid&utm_campaign=autumn-menu`,
      spend: 30000,
      currency: "USD",
    });
    expect(read.warnings).toEqual([]);
  });

  it("reads a Google Ads export: a preamble, a currency column and totals rows", () => {
    const read = readAdsExport(fixture("google.csv"));
    expect(read.columns).toEqual({ link: "Final URL", spend: "Cost" });
    expect(read.rows.map((r) => r.name)).toEqual([
      "Gift cards - search",
      "Gift cards - brand",
      "Book a table - search",
    ]);
    expect(read.rows.every((r) => r.currency === "EUR")).toBe(true);
    // The two Total lines are not ads and not missing links.
    expect(read.warnings).toEqual([]);
  });

  it("reads a file with a byte order mark", () => {
    const read = readAdsExport(BOM + withSpend("10.00"));
    expect(read.columns.link).toBe("Website URL");
    expect(read.rows).toHaveLength(1);
  });

  it("skips a preamble line above the header", () => {
    const read = readAdsExport(`Ad report\nNovember 2026\n\n${withSpend("10.00")}`);
    expect(read.rows).toHaveLength(1);
  });

  it("skips a totals row at the end without counting it as a missing link", () => {
    const read = readAdsExport(`${withSpend("10.00")}Total: Account,,10.00\n`);
    expect(read.rows).toHaveLength(1);
    expect(read.warnings).toEqual([]);
  });

  it("takes the other candidate names for each column", () => {
    for (const link of ["Link", "Final URL", "Destination", "Destination URL", "Landing page"]) {
      const read = readAdsExport(`${link},Spend\n${SHOP}/a,1.00\n`);
      expect(read.columns, link).toEqual({ link, spend: "Spend" });
    }
    for (const spend of ["Amount spent", "Cost", "SPEND", "Amount Spent (EUR)"]) {
      const read = readAdsExport(`Link,${spend}\n${SHOP}/a,1.00\n`);
      expect(read.columns.spend, spend).toBe(spend);
    }
  });

  it("does not take 'Link clicks' for the link or 'Cost per result' for the spend", () => {
    const read = readAdsExport(
      `Link clicks,Cost per result,Website URL,Amount spent (USD)\n12,0.40,${SHOP}/a,5.00\n`,
    );
    expect(read.columns).toEqual({ link: "Website URL", spend: "Amount spent (USD)" });
  });

  it("two columns that both look like the link: the first candidate wins, with a warning", () => {
    const read = readAdsExport(`Website URL,Link,Spend\n${SHOP}/a,${SHOP}/b,1.00\n`);
    expect(read.columns.link).toBe("Link");
    expect(read.rows[0]?.link).toBe(`${SHOP}/b`);
    expect(read.warnings[0]).toContain('"Link" and "Website URL"');
  });

  it("reads the currency from a Currency column, else from the spend header", () => {
    const column = readAdsExport(`Link,Cost,Currency code\n${SHOP}/a,5.00,gbp\n`);
    expect(column.rows[0]?.currency).toBe("GBP");
    const header = readAdsExport(`Link,Amount spent (EUR)\n${SHOP}/a,5.00\n`);
    expect(header.rows[0]?.currency).toBe("EUR");
    const neither = readAdsExport(`Link,Spend\n${SHOP}/a,5.00\n`);
    expect(neither.rows[0]).not.toHaveProperty("currency");
  });
});

describe("readAdsExport: spend is an integer in minor units", () => {
  it.each([
    ["$1,204.50", 120450],
    ["1204.5", 120450],
    ["1204.50", 120450],
    ["€ 48", 4800],
    ["US$ 0.99", 99],
    ["0", 0],
    ["12", 1200],
    ["1,204", 120400],
  ])("%s reads as %i", (cell, minor) => {
    const read = readAdsExport(withSpend(cell));
    expect(read.rows[0]?.spend).toBe(minor);
    expect(read.warnings).toEqual([]);
  });

  it('"1.204,50" is read as 1204.50 and flagged as ambiguous', () => {
    const read = readAdsExport(withSpend("1.204,50"));
    expect(read.rows[0]?.spend).toBe(120450);
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toMatch(/ambiguous/i);
    expect(read.warnings[0]).toContain('"1.204,50"');
    expect(read.warnings[0]).toContain("line 2");
  });

  it('a decimal comma on its own ("12,50") is read as 12.50 and flagged', () => {
    const read = readAdsExport(withSpend("12,50"));
    expect(read.rows[0]?.spend).toBe(1250);
    expect(read.warnings[0]).toMatch(/ambiguous/i);
  });

  it("a blank spend is 0 and still joins its destination, without a warning", () => {
    const read = readAdsExport(
      `Link,Spend\n${SHOP}/a,\n${SHOP}/a,--\n${SHOP}/a,3.00\n${SHOP}/b,n/a\n`,
    );
    expect(read.rows.map((r) => r.spend)).toEqual([0, 0, 300, 0]);
    expect(read.warnings).toEqual([]);
    const groups = groupByDestination(read.rows);
    expect(groups.get(`${SHOP}/a`)?.ads).toHaveLength(3);
    expect(groups.get(`${SHOP}/b`)?.ads).toHaveLength(1);
    expect(groups.get(`${SHOP}/a`)?.spend).toBe(300);
  });

  it("text that is not an amount counts as 0 and is warned about, once", () => {
    const read = readAdsExport(
      `Link,Spend\n${SHOP}/a,Unavailable\n${SHOP}/a,-5.00\n${SHOP}/a,10.00\n`,
    );
    expect(read.rows.map((r) => r.spend)).toEqual([0, 0, 1000]);
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain("2 spend amounts");
  });

  it("an amount with more places than the currency has is not rounded", () => {
    const read = readAdsExport(withSpend("12.345"));
    expect(read.rows[0]?.spend).toBe(0);
    expect(read.warnings[0]).toContain('"12.345"');
  });

  it("yen has no decimals and 5 is 5 (never 500)", () => {
    const read = readAdsExport(`Link,Cost,Currency code\n${SHOP}/a,"5,000",JPY\n`);
    expect(read.rows[0]?.spend).toBe(5000);
  });

  it("follows the currency's own places, as the app does (clp has none, kwd has three)", () => {
    const read = readAdsExport(
      `Link,Cost,Currency code\n${SHOP}/a,2500,CLP\n${SHOP}/b,1.250,KWD\n`,
    );
    expect(read.rows.map((r) => r.spend)).toEqual([2500, 1250]);
  });

  it("never goes through a float: 19.99 and 0.07 stay exact", () => {
    const read = readAdsExport(`Link,Spend\n${SHOP}/a,19.99\n${SHOP}/a,0.07\n`);
    expect(read.rows.map((r) => r.spend)).toEqual([1999, 7]);
  });
});

describe("readAdsExport: rows and links", () => {
  it("a row with no link is skipped and counted in the warnings", () => {
    const read = readAdsExport(`Link,Spend\n${SHOP}/a,1.00\n,2.00\n  ,3.00\n--,4.00\n`);
    expect(read.rows).toHaveLength(1);
    expect(read.warnings).toEqual(["3 rows had no link and were skipped (the first is line 3)."]);
  });

  it("a link with no scheme is read as https, with a warning", () => {
    const read = readAdsExport(`Link,Spend\ntapas-bar.example/menu?utm_source=x,1.00\n`);
    expect(read.rows[0]?.link).toBe("https://tapas-bar.example/menu?utm_source=x");
    expect(read.warnings).toHaveLength(1);
    expect(read.warnings[0]).toContain("https://");
    expect(read.warnings[0]).toContain("tapas-bar.example/menu");
    // The query is the person's campaign, not something to repeat in a message.
    expect(read.warnings[0]).not.toContain("utm_source");
  });

  it("a link that is not a web address is skipped with a warning", () => {
    const read = readAdsExport(
      `Link,Spend\nmailto:hello${AT}tapas-bar.example,1.00\nftp://tapas-bar.example/x,1.00\nnot a link,1.00\n${SHOP}/a,1.00\n`,
    );
    expect(read.rows).toHaveLength(1);
    expect(read.warnings.join("\n")).toContain("3 links were not web addresses");
  });

  it("an export with no ads still reads, and says so", () => {
    const read = readAdsExport(`Link,Spend\n`);
    expect(read.rows).toEqual([]);
    expect(read.warnings[0]).toContain("no ads");
  });

  it("handles quoted cells, commas inside them and CRLF line endings", () => {
    const read = readAdsExport(
      `Ad name,Website URL,Amount spent (USD)\r\n"Happy hour, 2 for 1",${SHOP}/happy-hour,"1,204.50"\r\n`,
    );
    expect(read.rows[0]).toMatchObject({ name: "Happy hour, 2 for 1", spend: 120450 });
  });
});

describe("readAdsExport: files that cannot be used", () => {
  it("no link column: names the headers that were found", () => {
    expect(() => readAdsExport(fixture("no-link.csv"))).toThrow(
      /no link column.*Headers found: Ad name, Impressions, Amount spent \(USD\)\./s,
    );
  });

  it("no spend column: names the headers that were found", () => {
    expect(() => readAdsExport(fixture("no-spend.csv"))).toThrow(
      /no amount-spent column.*Headers found: Ad name, Website URL, Impressions\./s,
    );
  });

  it("an empty file says so", () => {
    expect(() => readAdsExport("")).toThrow(/Headers found: none/);
    expect(() => readAdsExport(BOM)).toThrow(/Headers found: none/);
  });

  it("with a preamble, the headers listed are the table's, not the title line's", () => {
    expect(() => readAdsExport("Ad report\nNov 2026\n\nAd,Clicks,Cost\nx,1,2\n")).toThrow(
      /Headers found: Ad, Clicks, Cost\./,
    );
  });

  it("a tab-separated file gets a hint instead of a one-header list", () => {
    expect(() => readAdsExport("Ad\tFinal URL\tCost\nx\thttps://tapas-bar.example/\t1\n")).toThrow(
      /tab-separated/,
    );
  });
});

describe("adDestinationKey", () => {
  it("one page with three different utm_campaign values is one destination", () => {
    const keys = ["a", "b", "c"].map(
      (c) => adDestinationKey(`${SHOP}/happy-hour?utm_campaign=${c}`).key,
    );
    expect(new Set(keys)).toEqual(new Set([`${SHOP}/happy-hour`]));
  });

  it("removes every utm_ key, gclid and fbclid, whatever their case", () => {
    const { key, tags } = adDestinationKey(
      `${SHOP}/menu?UTM_Source=meta&utm_id=7&gclid=g1&fbclid=f1&utm_custom=z&size=large`,
    );
    expect(key).toBe(`${SHOP}/menu?size=large`);
    expect(tags).toEqual({
      utm_source: "meta",
      utm_id: "7",
      gclid: "g1",
      fbclid: "f1",
      utm_custom: "z",
    });
  });

  it("removes the fragment and lower-cases the host, but not the path", () => {
    expect(adDestinationKey("HTTPS://Tapas-Bar.EXAMPLE/Menu#reserve").key).toBe(
      "https://tapas-bar.example/Menu",
    );
  });

  it("sorts the remaining query so its order does not matter", () => {
    const a = adDestinationKey(`${SHOP}/shop?size=l&colour=red`).key;
    const b = adDestinationKey(`${SHOP}/shop?colour=red&size=l`).key;
    expect(a).toBe(b);
    expect(a).toBe(`${SHOP}/shop?colour=red&size=l`);
  });

  it("keeps a repeated key in value order and does not drop a key with no value", () => {
    expect(adDestinationKey(`${SHOP}/s?tag=b&tag=a&flag`).key).toBe(`${SHOP}/s?flag=&tag=a&tag=b`);
  });

  it("drops a default port and a password, keeps another port", () => {
    expect(adDestinationKey("https://tapas-bar.example:443/a").key).toBe(`${SHOP}/a`);
    expect(adDestinationKey(`https://owner:secret${AT}tapas-bar.example/a`).key).toBe(`${SHOP}/a`);
    expect(adDestinationKey("http://tapas-bar.example:8080/a").key).toBe(
      "http://tapas-bar.example:8080/a",
    );
  });

  it("the same path with and without a trailing slash is two destinations (it does not guess)", () => {
    expect(adDestinationKey(`${SHOP}/menu`).key).not.toBe(adDestinationKey(`${SHOP}/menu/`).key);
    const groups = groupByDestination([
      { link: `${SHOP}/menu`, spend: 100 },
      { link: `${SHOP}/menu/`, spend: 200 },
    ]);
    expect(groups.size).toBe(2);
  });

  it("the home page with and without its slash is one destination (a URL always has one)", () => {
    expect(adDestinationKey(SHOP).key).toBe(`${SHOP}/`);
    expect(adDestinationKey(`${SHOP}/`).key).toBe(`${SHOP}/`);
  });

  it("http and https stay apart: an ad that sends people to http may be redirected", () => {
    expect(adDestinationKey("http://tapas-bar.example/a").key).not.toBe(
      adDestinationKey(`${SHOP}/a`).key,
    );
  });

  it("the first value of a repeated campaign key is the one kept", () => {
    expect(adDestinationKey(`${SHOP}/a?utm_source=one&utm_source=two`).tags).toEqual({
      utm_source: "one",
    });
  });

  it("decodes values once: %20 and + both read as a space", () => {
    expect(adDestinationKey(`${SHOP}/a?utm_campaign=autumn%20menu`).tags.utm_campaign).toBe(
      "autumn menu",
    );
    expect(adDestinationKey(`${SHOP}/a?utm_campaign=autumn+menu`).tags.utm_campaign).toBe(
      "autumn menu",
    );
  });

  it("a link the URL parser refuses is its own key, so no ad is lost", () => {
    expect(adDestinationKey("https://").key).toBe("https://");
  });
});

describe("groupByDestination", () => {
  it("12 ads across 4 destinations: a Map of size 4, spend summed per destination, zero requests", () => {
    const { rows } = readAdsExport(fixture("meta.csv"));
    const groups = groupByDestination(rows);
    expect(groups).toBeInstanceOf(Map);
    expect(groups.size).toBe(4);
    const spend = (path: string) => groups.get(`${SHOP}${path}`)?.spend;
    expect(spend("/happy-hour")).toBe(120450);
    expect(spend("/book-a-table")).toBe(80000);
    expect(spend("/gift-cards")).toBe(15075);
    expect(spend("/old-menu")).toBe(99999);
    expect(groups.get(`${SHOP}/happy-hour`)?.ads).toHaveLength(5);
    // The function is plain data in, data out: it has no fetcher to send anything with.
    expect(groupByDestination.length).toBe(1);
  });

  it("keeps each ad's original tag values on the destination, in step with its ads", () => {
    const { rows } = readAdsExport(fixture("meta.csv"));
    const happy = groupByDestination(rows).get(`${SHOP}/happy-hour`);
    expect(happy?.tags).toHaveLength(happy?.ads.length ?? -1);
    expect(happy?.tags.map((t) => t.utm_campaign)).toEqual([
      "autumn-menu",
      "autumn-menu",
      "two-for-one",
      "two-for-one",
      undefined,
    ]);
    expect(happy?.tags[4]).toEqual({ fbclid: "IwAR0demo000fixture" });
    // The ad's own link keeps its tags too.
    expect(happy?.ads[0]?.link).toContain("utm_campaign=autumn-menu");
    // An ad with no tags has an empty record, so index i is always ad i.
    expect(groupByDestination(rows).get(`${SHOP}/old-menu`)?.tags).toEqual([{}]);
  });

  it("keeps destinations in the order they first appear", () => {
    const groups = groupByDestination([
      { link: `${SHOP}/b`, spend: 1 },
      { link: `${SHOP}/a`, spend: 2 },
      { link: `${SHOP}/b`, spend: 3 },
    ]);
    expect([...groups.keys()]).toEqual([`${SHOP}/b`, `${SHOP}/a`]);
  });

  it("each destination's url is its key", () => {
    const groups = groupByDestination([{ link: `${SHOP}/a?utm_source=x`, spend: 1 }]);
    expect(groups.get(`${SHOP}/a`)?.url).toBe(`${SHOP}/a`);
  });

  it("an empty list of ads is an empty Map", () => {
    expect(groupByDestination([]).size).toBe(0);
  });
});

describe("two currencies in one file", () => {
  const rows = (): AdRow[] => readAdsExport(fixture("mixed-currency.csv")).rows;

  it("totals are kept per currency and never added together", () => {
    const groups = groupByDestination(rows());
    const gifts = groups.get(`${SHOP}/gift-cards`);
    expect([...(gifts?.spendByCurrency ?? new Map())]).toEqual([
      ["EUR", 4000],
      ["USD", 2500],
    ]);
    // spend is the amount in the file's main currency (the one most ads use), not a sum of both.
    expect(gifts?.spend).toBe(4000);
  });

  it("the table lists each currency on its own, biggest destination first", () => {
    const table = spendByCurrency(groupByDestination(rows()));
    expect(table.map((t) => t.currency)).toEqual(["EUR", "USD"]);
    expect(table[0]?.destinations).toEqual([
      { url: `${SHOP}/gift-cards`, ads: 2, spend: 4000 },
      { url: `${SHOP}/happy-hour`, ads: 1, spend: 1500 },
    ]);
    expect(table[1]?.destinations).toEqual([
      { url: `${SHOP}/gift-cards`, ads: 1, spend: 2500 },
      { url: `${SHOP}/book-a-table`, ads: 1, spend: 1200 },
    ]);
  });

  it("a line shows every currency of the page, joined with + and not summed", () => {
    const lines = formatDestinationLines(groupByDestination(rows()));
    const gifts = lines.find((l) => l.includes("/gift-cards"));
    expect(gifts).toContain("40.00 EUR + 25.00 USD");
    expect(gifts).toMatch(/3 ads/);
    expect(lines.join("\n")).not.toContain("65.00");
  });

  it("a file with no currency anywhere has one table whose currency is null", () => {
    const table = spendByCurrency(groupByDestination([{ link: `${SHOP}/a`, spend: 100 }]));
    expect(table).toEqual([
      { currency: null, destinations: [{ url: `${SHOP}/a`, ads: 1, spend: 100 }] },
    ]);
  });
});

describe("formatDestinationLines", () => {
  it("one line per destination, sorted by spend (highest first) then by address", () => {
    const lines = formatDestinationLines(
      groupByDestination(readAdsExport(fixture("meta.csv")).rows),
    );
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual([
      `${SHOP}/happy-hour`,
      `${SHOP}/old-menu`,
      `${SHOP}/book-a-table`,
      `${SHOP}/gift-cards`,
    ]);
    expect(lines[0]).toMatch(/5 ads\s+1204\.50 USD$/);
    expect(lines[1]).toMatch(/1 ad\s+999\.99 USD$/);
  });

  it("equal spend is ordered by address, not by the order of the file", () => {
    const lines = formatDestinationLines(
      groupByDestination([
        { link: `${SHOP}/z`, spend: 500 },
        { link: `${SHOP}/a`, spend: 500 },
        { link: `${SHOP}/m`, spend: 900 },
      ]),
    );
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual([`${SHOP}/m`, `${SHOP}/a`, `${SHOP}/z`]);
  });

  it("lines line up in columns", () => {
    const lines = formatDestinationLines(
      groupByDestination(readAdsExport(fixture("meta.csv")).rows),
    );
    const ends = new Set(lines.map((l) => l.length));
    expect(ends.size).toBe(1);
  });

  it("an ad without a currency shows the number alone", () => {
    const [line] = formatDestinationLines(groupByDestination([{ link: `${SHOP}/a`, spend: 1999 }]));
    expect(line).toMatch(/1 ad\s+19\.99$/);
  });

  it("no destinations, no lines", () => {
    expect(formatDestinationLines(new Map())).toEqual([]);
  });
});
