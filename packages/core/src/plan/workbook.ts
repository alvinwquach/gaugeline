import { unzipSync, strFromU8 } from "fflate";
import { ConfigError } from "../errors.js";
import { COLUMN_ALIASES, normaliseHeader, parseCsv } from "./columns.js";

/**
 * A plan file as a workbook of tabs: a multi-tab text export ("## Sheet name:" lines) or an .xlsx,
 * told apart by the file's first bytes, never its extension. Every tab is kept; one is chosen for
 * the page list (the one whose header has a URL column) and later checks read the others.
 */
export interface Sheet {
  name: string;
  index: number;
  /** The line (text) or row (.xlsx) the header is on, in the file the person opened. */
  headerLine: number;
  headers: string[];
  /** The tab as CSV. Its line 1 is `firstLine` in the file. */
  csvText: string;
  /** Lines before this tab's first line in the file: added to every row's line. */
  lineOffset: number;
  /** Non-empty rows under the header. */
  rowCount: number;
}

export interface Workbook {
  sheets: Sheet[];
  chosen: Sheet;
  warnings: string[];
}

const SHEET_MARKER = /^## Sheet name:\s*(.*?)\s*$/;

function isZip(b: Uint8Array): boolean {
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** The old binary .xls, and password-protected .xlsx, are both OLE compound files. */
function isOle(b: Uint8Array): boolean {
  return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

function hasUrlColumn(headers: readonly string[]): boolean {
  return headers.some((h) => COLUMN_ALIASES[normaliseHeader(h)] === "url");
}

/** Header (the first record with a URL column, else the first non-empty one) and row count. */
function describe(csvText: string): { headerLine: number; headers: string[]; rowCount: number } {
  const records = parseCsv(csvText).filter((r) => r.cells.some((c) => c.trim() !== ""));
  const at = records.findIndex((r) => hasUrlColumn(r.cells));
  const header = records[at >= 0 ? at : 0];
  return {
    headerLine: header?.line ?? 1,
    headers: (header?.cells ?? []).map((c) => c.trim()).filter((c) => c !== ""),
    rowCount: Math.max(0, records.length - (at >= 0 ? at : 0) - 1),
  };
}

function sheetOf(name: string, index: number, csvText: string, lineOffset: number): Sheet {
  const d = describe(csvText);
  return {
    name,
    index,
    headerLine: d.headerLine + lineOffset,
    headers: d.headers,
    csvText,
    lineOffset,
    rowCount: d.rowCount,
  };
}

/** Tabs from a text export. Markers inside a quoted cell don't count: the CSV parser decides. */
function textSheets(text: string, fileName: string): Sheet[] {
  const lines = text.split(/\r?\n/);
  const markers = parseCsv(text)
    .filter((r) => r.cells.length === 1 && SHEET_MARKER.test(r.cells[0] ?? ""))
    .map((r) => ({ line: r.line, name: SHEET_MARKER.exec(r.cells[0] ?? "")?.[1] ?? "" }));
  if (markers.length === 0) return [sheetOf(fileName, 0, text, 0)];
  const sheets: Sheet[] = [];
  // Anything before the first marker that isn't blank is a tab of its own, named after the file.
  const before = lines.slice(0, (markers[0]?.line ?? 1) - 1).join("\n");
  if (before.trim() !== "") sheets.push(sheetOf(fileName, 0, before, 0));
  markers.forEach((m, i) => {
    const end = (markers[i + 1]?.line ?? lines.length + 1) - 1;
    const body = lines.slice(m.line, end).join("\n");
    sheets.push(sheetOf(m.name, sheets.length, body, m.line));
  });
  return sheets;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return ENTITIES[e] ?? m;
  });
}

/** The text of every <t> in a fragment (rich text runs joined). */
function texts(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)]
    .map((m) => decode(m[1] ?? ""))
    .join("");
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** "AB12" -> 27 (zero-based column 27). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Built-in number formats that show a date (ECMA-376 §18.8.30). */
const DATE_FORMATS: Readonly<Record<number, string>> = {
  14: "m/d/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  22: "m/d/yyyy h:mm",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A date serial (days since 1899-12-30, the 1900 system) shown in a format code. */
export function formatDate(serial: number, code: string): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return code
    .replace(/\\(.)/g, "$1")
    .replace(/"([^"]*)"/g, "$1")
    .replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d|hh|h|ss/gi, (t, offset: number, all: string) => {
      const lower = t.toLowerCase();
      // "mm" after an hour is minutes.
      const afterHour = /h[^a-z]*$/i.test(all.slice(0, offset));
      if (lower === "yyyy") return String(y);
      if (lower === "yy") return pad(y % 100);
      if (lower === "mmmm") return MONTHS[mo - 1] ?? "";
      if (lower === "mmm") return MONTHS[mo - 1] ?? "";
      if (lower === "mm") return afterHour ? pad(d.getUTCMinutes()) : pad(mo);
      if (lower === "m") return afterHour ? String(d.getUTCMinutes()) : String(mo);
      if (lower === "dd") return pad(day);
      if (lower === "d") return String(day);
      if (lower === "hh") return pad(d.getUTCHours());
      if (lower === "h") return String(d.getUTCHours());
      return pad(d.getUTCSeconds());
    });
}

function isDateCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[dy]/i.test(bare) || /m{3,}/i.test(bare);
}

/** Style index -> the date format code it shows, for styles that show a date. */
function dateStyles(stylesXml: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId"));
    const code = decode(attr(m[0], "formatCode") ?? "");
    custom.set(id, code);
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], "numFmtId") ?? "0");
    const code = custom.get(id) ?? DATE_FORMATS[id];
    if (code && (DATE_FORMATS[id] || isDateCode(code))) out.set(i, code);
  });
  return out;
}

/** A General-format number as Excel shows it: at most 15 significant digits. */
function generalNumber(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) || v.startsWith("## Sheet name:") ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Every cell of one worksheet as the string the spreadsheet shows, one CSV line per row number. */
function sheetCsv(xml: string, shared: readonly string[], dates: Map<number, string>): string {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\s([^>]*)>([\s\S]*?)<\/row>|<row\s([^>]*)\/>/g)) {
    const rowAttrs = rm[1] ?? rm[3] ?? "";
    const rowNum = Number(attr(` ${rowAttrs}`, "r") ?? rows.length + 1);
    const cells: string[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = ` ${cm[1] ?? ""}`;
      const body = cm[2] ?? "";
      const ref = attr(tag, "r");
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const t = attr(tag, "t");
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = "";
      if (t === "s") text = shared[Number(v)] ?? "";
      else if (t === "inlineStr") text = texts(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (t === "b") text = v === "1" ? "TRUE" : "FALSE";
      else if (t === "str" || t === "e") text = decode(v ?? "");
      else if (v !== undefined) {
        const style = Number(attr(tag, "s") ?? "-1");
        const code = dates.get(style);
        text = code ? formatDate(Number(v), code) : generalNumber(v);
      }
      cells[col] = text;
    }
    rows[rowNum - 1] = Array.from(cells, (c) => c ?? "");
  }
  return Array.from(rows, (r) => (r ?? []).map(csvCell).join(",")).join("\n");
}

function xlsxSheets(bytes: Uint8Array): Sheet[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ConfigError(
      "The .xlsx file could not be opened: it may be damaged. Save it again as .xlsx or CSV.",
      {
        hint: "Open it in your spreadsheet app and save a fresh copy.",
      },
    );
  }
  const text = (path: string) => (files[path] ? strFromU8(files[path]) : undefined);
  const workbook = text("xl/workbook.xml");
  if (!workbook)
    throw new ConfigError("The file is a zip but not an .xlsx workbook (no xl/workbook.xml).", {
      hint: "Export the plan from your spreadsheet as .xlsx or CSV.",
    });
  const rels = new Map<string, string>();
  for (const m of (text("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => texts(m[1] ?? ""),
  );
  const dates = dateStyles(text("xl/styles.xml"));
  return [...workbook.matchAll(/<sheet\s[^>]*>/g)].map((m, i) => {
    const name = decode(attr(m[0], "name") ?? `Sheet${i + 1}`);
    const rid = attr(m[0], "r:id");
    const target = (rid && rels.get(rid)) ?? `worksheets/sheet${i + 1}.xml`;
    const xml = text(`xl/${target}`) ?? "";
    return sheetOf(name, i, sheetCsv(xml, shared, dates), 0);
  });
}

/** "Kim's Keywords " and "kim's keywords" are one tab name. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Read a plan file into its tabs and choose the page list: --sheet if given (an unknown name is a
 * ConfigError listing the names), else the one tab whose header has a URL column; with several,
 * the first, and a warning naming the others; with none, a ConfigError listing every tab's headers.
 */
export function readWorkbook(
  input: string | Uint8Array,
  opts: { sheet?: string; fileName?: string } = {},
): Workbook {
  const fileName = opts.fileName ?? "the file";
  let sheets: Sheet[];
  if (typeof input !== "string" && isZip(input)) sheets = xlsxSheets(input);
  else if (typeof input !== "string" && isOle(input))
    throw new ConfigError(
      `${fileName} is an .xls workbook (the old Excel format) or a password-protected one: save it as .xlsx without a password, or as CSV.`,
      { hint: "In your spreadsheet app: File > Save As > Excel Workbook (.xlsx) or CSV." },
    );
  else {
    const text = (
      typeof input === "string" ? input : new TextDecoder("utf-8").decode(input)
    ).replace(/^\uFEFF/, "");
    sheets = textSheets(text, fileName);
  }
  const warnings: string[] = [];
  if (opts.sheet !== undefined) {
    const wanted = opts.sheet;
    const chosen = sheets.find((s) => sameName(s.name, wanted));
    if (!chosen)
      throw new ConfigError(
        `--sheet: there is no tab named "${wanted}". Tabs: ${sheets.map((s) => s.name.trim()).join(", ")}.`,
        { hint: "Give a tab name as it appears in the workbook (case doesn't matter)." },
      );
    return { sheets, chosen, warnings };
  }
  const withUrl = sheets.filter((s) => hasUrlColumn(s.headers));
  const first = withUrl[0];
  // One tab and no URL column: readPlan says so, with that tab's headers.
  if (!first && sheets.length === 1 && sheets[0]) return { sheets, chosen: sheets[0], warnings };
  if (!first)
    throw new ConfigError(
      `No tab has a URL column. ${sheets.map((s) => `${s.name.trim()}: ${s.headers.length > 0 ? s.headers.join(", ") : "no headers"}`).join("; ")}.`,
      {
        hint: 'Call the column that holds each address "URL" (or Address, New URL or Destination), or pick a tab with --sheet.',
      },
    );
  if (withUrl.length > 1)
    warnings.push(
      `More than one tab has a URL column; reading "${first.name.trim()}". The others: ${withUrl
        .slice(1)
        .map((s) => s.name.trim())
        .join(", ")}. Choose one with --sheet.`,
    );
  return { sheets, chosen: first, warnings };
}
