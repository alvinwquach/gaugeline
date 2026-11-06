import type { PlanRow } from "./read.js";

/**
 * Old addresses read out of a free-text notes column (--legacy-from), when a plan has no Legacy URL
 * column. A note is written for a person, so every mention is kept as a record with the sentence it
 * came from, and only one kind ("redirect here") ever becomes a legacy URL. Pure: no requests.
 */
export type LegacyKind = "redirect-here" | "no-destination" | "unconfirmed" | "no-path";

export interface LegacyMention {
  /** The plan line the note is on. */
  line: number;
  /** The planned page the note belongs to. */
  rowPath: string;
  column: string;
  sentence: string;
  path?: string;
  kind: LegacyKind;
}

/** Sentences as Intl.Segmenter finds them, trimmed. "KD 8." and "#1-4" stay inside theirs. */
export function splitSentences(text: string): string[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return [...segmenter.segment(text.replace(/\s+/g, " "))]
    .map((s) => s.segment.trim())
    .filter((s) => s !== "");
}

const TRAILING = /[.,;:!?)\]}"'’”]+$/;
const LEADING = /^[("'‘“[]+/;

/** "/a/b." -> "/a/b"; a full URL -> its path. A path starts with "/" and contains a letter. */
export function pathsIn(sentence: string): string[] {
  const out: string[] = [];
  for (const raw of sentence.split(/\s+/)) {
    let token = raw.replace(LEADING, "").replace(TRAILING, "");
    if (/^https?:\/\//i.test(token)) {
      try {
        token = new URL(token).pathname;
      } catch {
        continue;
      }
    }
    if (!token.startsWith("/") || !/[a-z]/i.test(token)) continue;
    token = token.replace(TRAILING, "");
    if (token.length > 1) token = token.replace(/\/+$/, "");
    out.push(token);
  }
  return out;
}

const REDIRECT_HERE = /\b301\b.*\bhere\b|\bredirect\w*\b.*\bhere\b|\bvia 301\b|\b301 from\b/i;
const NO_DESTINATION = /\bno destination\b/i;

/** One sentence's kind, by the rules in order; undefined when the sentence is not about a redirect. */
export function classify(sentence: string, paths: readonly string[]): LegacyKind | undefined {
  if (paths.length > 0) {
    if (/^confirm\b/i.test(sentence) || /\bwhether\b/i.test(sentence) || /\?\s*$/.test(sentence))
      return "unconfirmed";
    if (NO_DESTINATION.test(sentence)) return "no-destination";
    if (REDIRECT_HERE.test(sentence)) return "redirect-here";
    return undefined;
  }
  if (NO_DESTINATION.test(sentence)) return "no-destination";
  if (/\b301\b/.test(sentence)) return "no-path";
  return undefined;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p).toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Every legacy mention in the named columns, in row then sentence order. Only sentences with the
 * word "legacy" are read; a path equal to a planned page's path is dropped (it is a new page, not an
 * old one); one sentence with two paths gives two mentions.
 */
export function extractLegacy(
  rows: readonly PlanRow[],
  columnNames: readonly string[],
): LegacyMention[] {
  const planned = rows.map((r) => r.path);
  const out: LegacyMention[] = [];
  for (const row of rows) {
    for (const column of columnNames) {
      const cell = row.raw[column];
      if (!cell) continue;
      for (const sentence of splitSentences(cell)) {
        if (!/\blegacy\b/i.test(sentence)) continue;
        const paths = pathsIn(sentence).filter((p) => !planned.some((q) => samePath(p, q)));
        const kind = classify(sentence, paths);
        if (!kind) continue;
        const base = { line: row.line, rowPath: row.path, column, sentence, kind };
        if (paths.length === 0) out.push(base);
        else for (const path of paths) out.push({ ...base, path });
      }
    }
  }
  return out;
}

/** Fill legacyUrl from redirect-here mentions only (the first per row), with where it came from. */
export function applyLegacy(rows: PlanRow[], mentions: readonly LegacyMention[]): void {
  for (const m of mentions) {
    if (m.kind !== "redirect-here" || !m.path) continue;
    const row = rows.find((r) => r.line === m.line);
    if (!row || row.legacyUrl !== undefined) continue;
    row.legacyUrl = m.path;
    row.legacySource = m.column;
  }
}

/** Columns other than the plan's own fields whose cells mention "legacy", with how many rows. */
export function legacyHints(
  rows: readonly PlanRow[],
  skip: readonly string[],
): { column: string; rows: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows)
    for (const [column, cell] of Object.entries(row.raw))
      if (!skip.includes(column) && /\blegacy\b/i.test(cell))
        counts.set(column, (counts.get(column) ?? 0) + 1);
  return [...counts].map(([column, n]) => ({ column, rows: n }));
}

const CSV = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The review table as CSV, for the spreadsheet owner to confirm. */
export function legacyReviewCsv(mentions: readonly LegacyMention[]): string {
  const head = ["line", "kind", "path", "column", "sentence"];
  const rows = mentions.map((m) => [String(m.line), m.kind, m.path ?? "", m.column, m.sentence]);
  return [head, ...rows].map((r) => r.map(CSV).join(",")).join("\n") + "\n";
}
