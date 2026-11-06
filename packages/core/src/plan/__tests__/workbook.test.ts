import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { ConfigError } from "../../errors.js";
import { parseCsv } from "../columns.js";
import { readPlan } from "../read.js";
import { formatDate, readWorkbook } from "../workbook.js";

const PLANS = `${SITES_DIR}../plans/`;
const exportText = () => readFileSync(`${PLANS}workbook-export.txt`, "utf8");

type Cell =
  string | number | { date: number; style: "builtin" | "iso" } | { inline: string } | null;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A minimal .xlsx, written the way spreadsheets write them: shared strings, styles, one sheet per tab. */
function xlsx(tabs: { name: string; rows: Cell[][] }[]): Uint8Array {
  const shared: string[] = [];
  const sst = (s: string) => {
    const i = shared.indexOf(s);
    if (i >= 0) return i;
    shared.push(s);
    return shared.length - 1;
  };
  const files: Record<string, Uint8Array> = {};
  tabs.forEach((tab, t) => {
    const rows = tab.rows
      .map((row, r) => {
        const cells = row
          .map((c, i) => {
            const ref = `${colName(i)}${r + 1}`;
            if (c === null || c === "") return "";
            if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === "string") return `<c r="${ref}" t="s"><v>${sst(c)}</v></c>`;
            if ("inline" in c)
              return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.inline)}</t></is></c>`;
            return `<c r="${ref}" s="${c.style === "builtin" ? 1 : 2}"><v>${c.date}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/sheet${t + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs
      .map((t, i) => `<sheet name="${esc(t.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0"?><Relationships>${tabs
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
  );
  files["xl/sharedStrings.xml"] = strToU8(
    `<?xml version="1.0"?><sst>${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`,
  );
  files["xl/styles.xml"] = strToU8(
    `<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  );
  return zipSync(files);
}

describe("workbook: unit", () => {
  it("marker split: 3 tabs, the second empty, the third with a quoted cell holding a newline", () => {
    const wb = readWorkbook(
      [
        "## Sheet name: Pages",
        "URL,H1",
        "/a,A",
        "## Sheet name: Empty",
        "## Sheet name: Notes",
        "Label,Note",
        'x,"two',
        'lines"',
      ].join("\n"),
    );
    expect(wb.sheets.map((s) => [s.name, s.headers, s.rowCount, s.lineOffset])).toEqual([
      ["Pages", ["URL", "H1"], 1, 1],
      ["Empty", [], 0, 4],
      ["Notes", ["Label", "Note"], 1, 5],
    ]);
    expect(parseCsv(wb.sheets[2]?.csvText ?? "").at(-1)?.cells).toEqual(["x", "two\nlines"]);
    expect(wb.chosen.name).toBe("Pages");
  });

  it('"## Sheet name:" at the start of a line inside a quoted cell does not open a tab', () => {
    const wb = readWorkbook(
      ["URL,Note", '/a,"see below', '## Sheet name: not a tab"', "/b,x"].join("\n"),
      {
        fileName: "plan.csv",
      },
    );
    expect(wb.sheets.map((s) => s.name)).toEqual(["plan.csv"]);
    expect(readPlan(wb.chosen.csvText).rows.map((r) => r.url)).toEqual(["/a", "/b"]);
  });

  it("xlsx: shared strings, inline strings, numbers, an empty cell mid-row, and dates as displayed", () => {
    const wb = readWorkbook(
      xlsx([
        {
          name: "Pages",
          rows: [
            ["URL", "Title", "Priority", "Due", "Launched"],
            [
              "/a",
              { inline: "Inline & title" },
              2,
              { date: 46332, style: "iso" },
              { date: 46332, style: "builtin" },
            ],
            ["/b", null, 0.1 + 0.2, null, "done"],
          ],
        },
      ]),
    );
    expect(parseCsv(wb.chosen.csvText).map((r) => r.cells)).toEqual([
      ["URL", "Title", "Priority", "Due", "Launched"],
      ["/a", "Inline & title", "2", "2026-11-06", "11/6/2026"],
      ["/b", "", "0.3", "", "done"],
    ]);
    expect(formatDate(46332, "d-mmm-yy")).toBe("6-Nov-26");
  });

  it("choosing the tab: one URL tab, two (first, with a warning), none (an error listing the headers)", () => {
    const tabs = (a: string, b: string) =>
      `## Sheet name: A\n${a}\n/x\n## Sheet name: B\n${b}\n/y\n`;
    expect(readWorkbook(tabs("Label", "URL")).chosen.name).toBe("B");
    const two = readWorkbook(tabs("Address", "URL"));
    expect(two.chosen.name).toBe("A");
    expect(two.warnings).toEqual([
      'More than one tab has a URL column; reading "A". The others: B. Choose one with --sheet.',
    ]);
    expect(() => readWorkbook(tabs("Label", "Link"))).toThrow(
      "No tab has a URL column. A: Label; B: Link.",
    );
  });
});

describe("workbook: integration (the invented seven-tab export)", () => {
  it("seven tabs; the keywords tab is chosen without --sheet; counts match the single CSV", () => {
    const plan = readPlan(exportText(), { fileName: "workbook-export.txt" });
    expect(plan.workbook.sheets.map((s) => s.name)).toEqual([
      "Kim's Keywords",
      "Solutions",
      "Who We Serve",
      "Technology",
      "Resources",
      "About Us",
      "Footer",
    ]);
    expect(plan.workbook.chosen.name).toBe("Kim's Keywords");
    expect(plan.warnings).toEqual([]);
    expect(plan.rows).toHaveLength(163);
    expect(plan.skipped).toBe(4);
    // Lines point at the file the person opened: the keywords header is line 2.
    expect(plan.rows[0]?.line).toBe(4);
    const single = readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));
    expect(plan.rows.map((r) => r.raw)).toEqual(single.rows.map((r) => r.raw));
  });

  it("the same workbook as .xlsx gives the same 163 rows, cell for cell", () => {
    const text = readWorkbook(exportText());
    const tabs = text.sheets.map((s) => ({
      name: s.name === "Kim's Keywords" ? "Kim's Keywords " : s.name,
      rows: parseCsv(s.csvText).map((r) =>
        r.cells.map((c): Cell => (/^\d+$/.test(c) ? Number(c) : c === "" ? null : c)),
      ),
    }));
    const fromXlsx = readPlan(xlsx(tabs), { fileName: "plan.xlsx" });
    const fromText = readPlan(exportText());
    expect(fromXlsx.workbook.sheets).toHaveLength(7);
    expect(fromXlsx.rows.map((r) => r.raw)).toEqual(fromText.rows.map((r) => r.raw));
    expect(fromXlsx.skipped).toBe(4);
  });
});

describe("workbook: edge cases", () => {
  it("Footer's Link column holds menu labels: Link is not a URL alias, so Footer is not chosen", () => {
    const wb = readWorkbook(exportText());
    expect(wb.sheets.find((s) => s.name === "Footer")?.headers).toEqual([
      "Main category",
      "Link",
      "Phase",
    ]);
    expect(wb.chosen.name).not.toBe("Footer");
  });

  it("Resources: free text and a footnote under its header parse as ragged rows, no error", () => {
    const resources = readWorkbook(exportText()).sheets.find((s) => s.name === "Resources");
    const rows = parseCsv(resources?.csvText ?? "").map((r) => r.cells.length);
    expect(rows).toEqual([3, 1, 1, 1, 1]);
    expect(resources?.rowCount).toBe(4);
  });

  it('--sheet matches after trimming and lowercasing: "kim\'s keywords" finds "Kim\'s Keywords "', () => {
    const tabs = [
      { name: "Kim's Keywords ", rows: [["URL"], ["/a"]] as Cell[][] },
      {
        name: "Footer",
        rows: [
          ["Main category", "Link"],
          ["Co", "About"],
        ] as Cell[][],
      },
    ];
    expect(readWorkbook(xlsx(tabs), { sheet: "kim's keywords" }).chosen.name).toBe(
      "Kim's Keywords ",
    );
    expect(() => readWorkbook(xlsx(tabs), { sheet: "Menus" })).toThrow(
      '--sheet: there is no tab named "Menus". Tabs: Kim\'s Keywords, Footer.',
    );
    expect(() => readPlan(xlsx(tabs), { sheet: "footer" })).toThrow(
      'The "Footer" tab has no URL column. Headers found: Main category, Link.',
    );
  });

  it("the file's bytes decide, not its name: xlsx named .csv is xlsx, CSV named .xlsx is CSV", () => {
    expect(
      readWorkbook(xlsx([{ name: "P", rows: [["URL"], ["/a"]] }]), { fileName: "plan.csv" }).chosen
        .name,
    ).toBe("P");
    const csv = new TextEncoder().encode("URL\n/a\n");
    expect(readWorkbook(csv, { fileName: "plan.xlsx" }).chosen.name).toBe("plan.xlsx");
  });

  it("a corrupt .xlsx and an .xls (or password-protected file) stop with one sentence", () => {
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
    expect(() => readWorkbook(corrupt)).toThrow(ConfigError);
    expect(() => readWorkbook(corrupt)).toThrow(
      "The .xlsx file could not be opened: it may be damaged. Save it again as .xlsx or CSV.",
    );
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => readWorkbook(ole, { fileName: "plan.xls" })).toThrow(
      "plan.xls is an .xls workbook (the old Excel format) or a password-protected one: save it as .xlsx without a password, or as CSV.",
    );
  });
});
