import { ConfigError } from "../errors.js";
import { normaliseHeader, parseCsv } from "../plan/columns.js";

/**
 * The register of printed addresses: every QR code, flyer and short link that left the building.
 * Only the owner knows where they went, so the register says where each one is printed and a
 * finding can say "the table tents" instead of an address nobody recognises.
 */
export interface PrintedRow {
  /** The file's line number (a quoted cell with a line break makes rows span lines). */
  line: number;
  url: string;
  /** Where it is printed: "table tents", "spring flyer". */
  where: string;
  printedOn?: string;
  /** Where it should land, when the owner knows. */
  expectedDestination?: string;
}

export type PrintedField = "url" | "where" | "printedOn" | "expectedDestination";

export const PRINTED_COLUMNS: Readonly<Record<string, PrintedField>> = Object.freeze({
  url: "url",
  "printed url": "url",
  address: "url",
  link: "url",
  where: "where",
  location: "where",
  "printed on": "printedOn",
  printedon: "printedOn",
  date: "printedOn",
  "expected destination": "expectedDestination",
  expecteddestination: "expectedDestination",
  destination: "expectedDestination",
});

export function readRegister(text: string): PrintedRow[] {
  const records = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = records[0];
  if (!header) throw new ConfigError("The printed register is empty.");
  const columns = new Map<PrintedField, number>();
  header.cells.forEach((cell, i) => {
    const field = PRINTED_COLUMNS[normaliseHeader(cell)];
    if (field && !columns.has(field)) columns.set(field, i);
  });
  const urlAt = columns.get("url");
  if (urlAt === undefined)
    throw new ConfigError(
      `The printed register has no url column. Headers: ${header.cells.join(", ")}.`,
      { hint: "Columns: url, where, printedOn, expectedDestination (the last two optional)." },
    );
  const at = (cells: string[], field: PrintedField) => {
    const i = columns.get(field);
    const v = i === undefined ? undefined : cells[i]?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const rows: PrintedRow[] = [];
  for (const record of records.slice(1)) {
    const url = record.cells[urlAt]?.trim() ?? "";
    if (url === "") continue;
    const printedOn = at(record.cells, "printedOn");
    const expected = at(record.cells, "expectedDestination");
    rows.push({
      line: record.line,
      url,
      where: at(record.cells, "where") ?? `line ${record.line}`,
      ...(printedOn ? { printedOn } : {}),
      ...(expected ? { expectedDestination: expected } : {}),
    });
  }
  return rows;
}

const CSV = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Lines to append for decoded addresses the register doesn't have yet (url, where), in the
 * register's own column order; existing rows are never rewritten.
 */
export function registerAdditions(
  text: string,
  decoded: readonly { url: string; where: string }[],
): string {
  const records = parseCsv(text.replace(/^\uFEFF/, ""));
  const header = records[0]?.cells ?? ["url", "where"];
  const have = new Set(readRegisterOrEmpty(text).map((r) => r.url));
  const fieldAt = header.map((h) => PRINTED_COLUMNS[normaliseHeader(h)]);
  const lines: string[] = [];
  for (const d of decoded) {
    if (have.has(d.url)) continue;
    have.add(d.url);
    lines.push(
      fieldAt.map((f) => (f === "url" ? CSV(d.url) : f === "where" ? CSV(d.where) : "")).join(","),
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function readRegisterOrEmpty(text: string): PrintedRow[] {
  try {
    return readRegister(text);
  } catch {
    return [];
  }
}
