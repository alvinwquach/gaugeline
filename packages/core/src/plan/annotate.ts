import { SEVERITY_ORDER, type Finding } from "../model.js";
import { normaliseHeader, parseCsv } from "./columns.js";
import type { PlanRow } from "./read.js";
import type { Sheet } from "./workbook.js";

/**
 * The plan's chosen tab as CSV again, every cell as read, with one more column, "Gaugeline", saying
 * what is wrong on each row: the result goes back into the spreadsheet where it gets fixed.
 */
export const ANNOTATION_HEADER = "Gaugeline";

/** Line -> the findings whose group covers it: one pass over the findings, one lookup per row. */
export function byLine(findings: readonly Finding[]): Map<number, Finding[]> {
  const out = new Map<number, Finding[]>();
  for (const f of findings)
    for (const line of new Set(f.group?.lines ?? [])) {
      const list = out.get(line) ?? [];
      list.push(f);
      out.set(line, list);
    }
  for (const list of out.values())
    list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return out;
}

const SHORT: Readonly<Record<string, string>> = {
  "plan-duplicate-address": "same address as",
  "plan-duplicate-title": "same title tag as",
  "plan-duplicate-h1": "same H1 as",
  "plan-keyword-cannibalisation": "same primary keyword as",
  "plan-keyword-overlap": "shares its keyword with",
};

function linesWord(lines: readonly number[]): string {
  return `${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")}`;
}

/** "plan-duplicate-address: same address as lines 60, 61" for one row. */
function note(f: Finding, line: number): string {
  const others = (f.group?.lines ?? []).filter((l) => l !== line);
  const short = SHORT[f.checkId];
  if (short && others.length > 0) return `${f.checkId}: ${short} ${linesWord(others)}`;
  if (f.checkId === "plan-legacy-unresolved")
    return `${f.checkId}: the old address in the notes isn't settled`;
  return `${f.checkId}: ${f.evidence}`;
}

/** RFC 4180 quoting; nothing else is changed, so every cell reads back as it was read. */
function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A Gaugeline cell never starts with a character a spreadsheet would run as a formula. */
function safe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function annotate(
  sheet: Sheet,
  rows: readonly PlanRow[],
  findings: readonly Finding[],
): string {
  const records = parseCsv(sheet.csvText).map((r) => ({ ...r, line: r.line + sheet.lineOffset }));
  const header = records.find((r) => r.line === sheet.headerLine);
  const width = header?.cells.length ?? 0;
  const existing = header ? header.cells.findIndex((c) => normaliseHeader(c) === "gaugeline") : -1;
  const at = existing >= 0 ? existing : width;
  const kept = new Set(rows.map((r) => r.line));
  const notes = byLine(findings);
  const out: string[] = [];
  for (const r of records) {
    if (r.cells.every((c) => c.trim() === "") && r !== header) {
      out.push("");
      continue;
    }
    let text = "";
    if (r === header) text = ANNOTATION_HEADER;
    else if (header && r.line > header.line) {
      const fs = notes.get(r.line) ?? [];
      text = kept.has(r.line) ? fs.map((f) => note(f, r.line)).join("; ") : "skipped: no URL";
    }
    const cells = [...r.cells];
    while (cells.length < Math.max(width, at)) cells.push("");
    cells[at] = safe(text);
    out.push(cells.map(cell).join(","));
  }
  while (out.length > 0 && out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}
