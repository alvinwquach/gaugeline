import { ConfigError } from "../errors.js";
import { COLUMN_ALIASES, normaliseHeader, parseCsv, type PlanField } from "./columns.js";
import { readWorkbook, type Workbook } from "./workbook.js";

export { COLUMN_ALIASES, normaliseHeader, parseCsv } from "./columns.js";
export type { PlanField } from "./columns.js";

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

/** Field -> the header it was read from, as written. */
export type ColumnMap = Partial<Record<PlanField, string>>;

export interface Plan {
  rows: PlanRow[];
  columns: ColumnMap;
  warnings: string[];
  /** Rows with no URL (a nav label, a section heading): skipped and counted. */
  skipped: number;
  /** Every tab of the file, and the one read. Later checks read the other tabs. */
  workbook: Workbook;
}

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
 * Read a plan: a CSV, a multi-tab text export or an .xlsx (told apart by its first bytes). The
 * workbook's page-list tab is chosen (see readWorkbook) and its rows read. Only a URL column is
 * required; a tab without one is a ConfigError listing the headers found.
 */
export function readPlan(
  input: string | Uint8Array,
  opts: { sheet?: string; fileName?: string } = {},
): Plan {
  const workbook = readWorkbook(input, opts);
  const chosen = workbook.chosen;
  const plan: Plan = {
    rows: [],
    columns: {},
    warnings: [...workbook.warnings],
    skipped: 0,
    workbook,
  };
  const records = parseCsv(chosen.csvText).map((r) => ({ ...r, line: r.line + chosen.lineOffset }));
  const headersSeen: string[][] = [];
  const multi = workbook.sheets.length > 1;
  readSection(records, multi ? chosen.name.trim() : undefined, plan, headersSeen);
  if (plan.columns.url === undefined) {
    const found = headersSeen[0] ?? chosen.headers;
    throw new ConfigError(
      `${multi ? `The "${chosen.name.trim()}" tab` : "The plan"} has no URL column. Headers found: ${found.length > 0 ? found.join(", ") : "none"}.`,
      {
        hint: 'Call the column that holds each address "URL" (or Address, New URL or Destination).',
      },
    );
  }
  return plan;
}
