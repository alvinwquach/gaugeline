import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { ConfigError } from "../../errors.js";
import { COLUMN_ALIASES, normaliseHeader, parseCsv, readPlan } from "../read.js";

const PLANS = `${SITES_DIR}../plans/`;

describe("plan reader: unit", () => {
  it("the alias table: every documented column name, plus 3 spellings each", () => {
    const spell = (name: string) => [
      name.toUpperCase(),
      name.replace(/ /g, "_"),
      ` ${name.replace(/ /g, "-")}: `,
    ];
    for (const [name, field] of Object.entries(COLUMN_ALIASES)) {
      const plan = readPlan(field === "url" ? `${name}\n/a\n` : `URL,${name}\n/a,value\n`);
      expect(plan.columns[field], name).toBe(name);
      for (const s of spell(name)) {
        expect(COLUMN_ALIASES[normaliseHeader(s)], s).toBe(field);
      }
    }
    // A header that only contains an alias is not that column.
    expect(COLUMN_ALIASES[normaliseHeader("URL notes")]).toBeUndefined();
  });

  it("quoted cells holding commas, line breaks and doubled quotes", () => {
    expect(parseCsv('a,"b, c","line\none","say ""hi"""\nnext,row\n')).toEqual([
      { line: 1, cells: ["a", "b, c", "line\none", 'say "hi"'] },
      { line: 3, cells: ["next", "row"] },
    ]);
  });

  it("an address split into path and fragment", () => {
    const [row] = readPlan("URL\n/revenue-cycle-management/medical#rural\n").rows;
    expect(row).toMatchObject({
      url: "/revenue-cycle-management/medical#rural",
      path: "/revenue-cycle-management/medical",
      fragment: "rural",
      line: 2,
    });
    const [abs] = readPlan("URL\nhttps://shop.example/menu?x=1#lunch\n").rows;
    expect(abs).toMatchObject({ path: "/menu", fragment: "lunch" });
  });
});

describe("plan reader: integration (an invented 167-row keyword map)", () => {
  it("reads with no warnings: 4 menu-label rows skipped for having no URL, 163 kept", () => {
    const plan = readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));
    expect(plan.warnings).toEqual([]);
    expect(plan.skipped).toBe(4);
    expect(plan.rows).toHaveLength(163);
    expect(plan.columns).toEqual({
      page: "Page",
      url: "URL",
      titleTag: "Title Tag",
      h1: "H1",
      primaryKeyword: "Primary Keyword",
      secondaryKeyword: "Secondary Keyword",
      legacyUrl: "Legacy URL",
    });
    expect(plan.rows.filter((r) => r.fragment).map((r) => r.url)).toHaveLength(7);
    expect(Object.keys(plan.rows[0]?.raw ?? {})).toHaveLength(12);
    expect(plan.rows[0]?.raw.Notes).toBe("Draft 1, reviewed");
  });
});

describe("plan reader: edge cases", () => {
  it("a BOM, CRLF, a trailing blank line and a header that is not on the first line", () => {
    const plan = readPlan("\uFEFFLaunch plan v3\r\n,\r\nPage,URL\r\nHome,/\r\n\r\n");
    expect(plan.rows).toEqual([
      { line: 4, page: "Home", url: "/", path: "/", raw: { Page: "Home", URL: "/" } },
    ]);
    expect(plan.skipped).toBe(0);
  });

  it("two columns that both look like the URL: the first is used, with a warning", () => {
    const plan = readPlan("URL,Address\n/a,/b\n");
    expect(plan.rows[0]?.url).toBe("/a");
    expect(plan.warnings).toEqual([
      'Columns "URL" and "Address" both look like the URL column; using "URL".',
    ]);
  });

  it("no URL column at all: a config error listing the headers found", () => {
    expect(() => readPlan("Page,Title Tag,H1\nHome,Welcome,Hi\n")).toThrow(ConfigError);
    expect(() => readPlan("Page,Title Tag,H1\nHome,Welcome,Hi\n")).toThrow(
      "The plan has no URL column. Headers found: Page, Title Tag, H1.",
    );
  });

  it('a multi-tab export pasted into one file ("## Sheet name:" lines), each tab with its header', () => {
    const plan = readPlan(
      [
        "## Sheet name: Pages",
        "URL,H1",
        "/a,A",
        "## Sheet name: Blog",
        "Address,Title",
        "/blog/x,X",
        "",
      ].join("\n"),
    );
    expect(plan.rows.map((r) => [r.sheet, r.url, r.h1 ?? r.titleTag, r.line])).toEqual([
      ["Pages", "/a", "A", 3],
      ["Blog", "/blog/x", "X", 6],
    ]);
  });
});
