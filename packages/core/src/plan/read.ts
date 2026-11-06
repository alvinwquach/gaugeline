import { ConfigError } from "../errors.js";

/**
 * A launch plan read from any CSV with a URL column: one row per planned page. Column names are
 * matched loosely through an alias table (lowercase, punctuation stripped), never by guessing.
 */
export interface PlanRow {
  /** The line in the file the row starts on (1-based), for evidence a person can open. */
  line: number;
  /** The tab it came from, in a multi-tab export. */
  sheet?: string;
  page?: string;
  /** The address as written in the plan. */
  url: string;
  path: string;
  /** "rural" for /medical#rural. */
  fragment?: string;
  titleTag?: string;
  h1?: string;
  primaryKeyword?: string;
  secondaryKeyword?: string;
  legacyUrl?: string;
  /** Every cell of the row, by its header as written. */
  raw: Record<string, string>;
}

export type PlanField =
  "url" | "page" | "titleTag" | "h1" | "primaryKeyword" | "secondaryKeyword" | "legacyUrl";

/** Field -> the header it was read from, as written. */
export type ColumnMap = Partial<Record<PlanField, string>>;

export interface Plan {
  rows: PlanRow[];
  columns: ColumnMap;
  warnings: string[];
  /** Rows with no URL (a nav label, a section heading): skipped and counted. */
  skipped: number;
}

/**
 * Normalised header -> field. A header either maps or it doesn't: "URL notes" is not the URL.
 * The docs list these names; a test reads every one.
 */
export const COLUMN_ALIASES: Readonly<Record<string, PlanField>> = Object.freeze({
  url: "url",
  address: "url",
  "new url": "url",
  destination: "url",
  "new address": "url",
  "page url": "url",
  page: "page",
  "page name": "page",
  "title tag": "titleTag",
  title: "titleTag",
  "meta title": "titleTag",
  h1: "h1",
  heading: "h1",
  "primary keyword": "primaryKeyword",
  keyword: "primaryKeyword",
  "target keyword": "primaryKeyword",
  "secondary keyword": "secondaryKeyword",
  "secondary keywords": "secondaryKeyword",
  "legacy url": "legacyUrl",
  "old url": "legacyUrl",
  "current url": "legacyUrl",
  "redirect from": "legacyUrl",
});

/** "Title_Tag", " TITLE-TAG " and "title tag" are one header. */
export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * RFC 4180: fields separated by commas, records by CRLF or LF; a field in double quotes may hold
 * commas, line breaks and doubled quotes. Returns each record with the line it starts on.
 */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = 0;
  const endRecord = () => {
    cells.push(cell);
    records.push({ line: start, cells });
    cells = [];
    cell = "";
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (c === "\n") line++;
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      cells.push(cell);
      cell = "";
      i++;
    } else if (c === "\r" && text[i + 1] === "\n") {
      endRecord();
      i += 2;
      line++;
      start = line;
    } else if (c === "\n" || c === "\r") {
      endRecord();
      i++;
      line++;
      start = line;
    } else {
      cell += c;
      i++;
    }
  }
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}

const SHEET = /^## Sheet name:\s*(.*?)\s*$/;

function split(url: string): { path: string; fragment?: string } {
  const hash = url.indexOf("#");
  const noHash = hash >= 0 ? url.slice(0, hash) : url;
  const fragment = hash >= 0 ? url.slice(hash + 1) : undefined;
  let path = noHash;
  try {
    path = new URL(noHash).pathname;
  } catch {
    path = noHash.replace(/[?].*$/, "") || "/";
  }
  return { path, ...(fragment ? { fragment } : {}) };
}

function readSection(
  records: { line: number; cells: string[] }[],
  sheet: string | undefined,
  plan: Plan,
  headersSeen: string[][],
): void {
  // The header is the first record with a URL column: a title or notes row above it is skipped.
  const headerAt = records.findIndex((r) =>
    r.cells.some((c) => COLUMN_ALIASES[normaliseHeader(c)] === "url"),
  );
  if (headerAt < 0) {
    const first = records.find((r) => r.cells.some((c) => c.trim() !== ""));
    if (first) headersSeen.push(first.cells.map((c) => c.trim()).filter((c) => c !== ""));
    return;
  }
  const header = (records[headerAt]?.cells ?? []).map((h) => h.trim());
  const index: Partial<Record<PlanField, number>> = {};
  header.forEach((h, i) => {
    const field = COLUMN_ALIASES[normaliseHeader(h)];
    if (!field) return;
    const first = index[field];
    if (first === undefined) {
      index[field] = i;
      plan.columns[field] ??= h;
    } else
      plan.warnings.push(
        `Columns "${header[first] ?? ""}" and "${h}" both look like the ${field === "url" ? "URL" : field} column; using "${header[first] ?? ""}".`,
      );
  });
  for (const r of records.slice(headerAt + 1)) {
    if (r.cells.every((c) => c.trim() === "")) continue;
    const get = (f: PlanField) => {
      const i = index[f];
      const v = i === undefined ? undefined : r.cells[i]?.trim();
      return v === undefined || v === "" ? undefined : v;
    };
    const url = get("url");
    if (!url) {
      plan.skipped++;
      continue;
    }
    const raw: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h !== "") raw[h] = r.cells[i] ?? "";
    });
    const row: PlanRow = { line: r.line, url, ...split(url), raw };
    if (sheet) row.sheet = sheet;
    for (const f of [
      "page",
      "titleTag",
      "h1",
      "primaryKeyword",
      "secondaryKeyword",
      "legacyUrl",
    ] as const) {
      const v = get(f);
      if (v !== undefined) row[f] = v;
    }
    plan.rows.push(row);
  }
}

/**
 * Read a plan. Only a URL column is required; a file without one is a ConfigError listing the
 * headers found. A multi-tab export pasted into one file ("## Sheet name: …" lines) is read tab by
 * tab, each with its own header.
 */
export function readPlan(csvText: string): Plan {
  const text = csvText.replace(/^\uFEFF/, "");
  const plan: Plan = { rows: [], columns: {}, warnings: [], skipped: 0 };
  const records = parseCsv(text);
  const sections: { sheet?: string; records: typeof records }[] = [{ records: [] }];
  for (const r of records) {
    const m = r.cells.length === 1 ? SHEET.exec(r.cells[0] ?? "") : null;
    if (m) sections.push({ sheet: m[1] ?? "", records: [] });
    else sections.at(-1)?.records.push(r);
  }
  const headersSeen: string[][] = [];
  for (const s of sections) readSection(s.records, s.sheet, plan, headersSeen);
  if (plan.columns.url === undefined) {
    const found = headersSeen[0] ?? [];
    throw new ConfigError(
      `The plan has no URL column. Headers found: ${found.length > 0 ? found.join(", ") : "none"}.`,
      {
        hint: 'Call the column that holds each address "URL" (or Address, New URL or Destination).',
      },
    );
  }
  return plan;
}
