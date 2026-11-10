import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { Cell } from "../connectors/postgres/session.js";
import type { AssertionResult } from "./types.js";

/** Rows a finding lists. A finding has to be readable in ten seconds: the count says how big it is. */
export const EVIDENCE_ROWS = 20;
/** Characters of one value shown. */
export const CELL_CHARS = 80;

/**
 * One value as printable text. Data from a database is data, never instructions: control, invisible
 * and tag characters become \u{HEX}, line breaks become spaces, a long value is cut, and the result
 * goes through the run's redactor last, so a key or connection string that sits in a cell is blanked.
 * Text with a space or a separator in it is quoted so a row stays readable.
 */
export function cellText(cell: Cell, redact: (text: string) => string): string {
  if (cell === null) return "null";
  if (typeof cell !== "string") return redact(String(cell));
  const shown = escapeInvisible(cell, CELL_CHARS);
  const text = /^[^\s,;="]+$/.test(shown) ? shown : `"${shown.replace(/"/g, '\\"')}"`;
  return redact(text);
}

function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The evidence line of one assertion: its id first (so two assertions are never one finding), how
 * many rows broke it, and the evidence columns of the first few. Plain text on one line.
 */
export function describeAssertion(r: AssertionResult): string {
  if (r.status !== "failed") return `${r.id}: ${r.message ?? r.status}`;
  const how = r.atLeast
    ? `more than ${thousands(r.count)} rows`
    : `${thousands(r.count)} ${r.count === 1 ? "row" : "rows"}`;
  const shown = r.rows.length;
  const head = `${r.id}: ${how}${r.count > shown || r.atLeast ? `, showing the first ${shown}` : ""}.`;
  const lines = r.rows.map((row) => r.columns.map((c) => `${c}=${row[c] ?? "null"}`).join(", "));
  return `${head} ${lines.join("; ")}`;
}
