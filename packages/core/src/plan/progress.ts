import { createHash } from "node:crypto";
import { fingerprint } from "../fingerprint.js";
import type { Finding } from "../model.js";
import { addressKey } from "./keys.js";
import type { PlanRow } from "./read.js";

/**
 * A preview filling in over weeks: what was fixed and what is new since the last run. The state is
 * the open findings keyed by fingerprint, so two set differences give fixed and added. It holds
 * fingerprints, check ids, line numbers and titles: no page content, no header, no secret.
 */
export const PLAN_STATE_SCHEMA = 1;

export interface PlanState {
  schema: 1;
  /** The plan's rows (address, title, H1), sorted: a reorder is not a change, an edit is. */
  planHash: string;
  /** The preview's origin, as given to --base (never a credential). */
  base: string;
  /** When the run finished, ISO 8601. */
  at: string;
  rowsTotal: number;
  rowsMatching: number;
  open: Record<string, { checkId: string; line: number; title: string }>;
}

export interface PlanProgress {
  state: PlanState;
  previous?: PlanState;
  /** Fingerprints open last time and not now. */
  fixed: string[];
  /** Fingerprints open now and not last time. */
  added: string[];
  /** Open both times. */
  still: number;
  /** The rows (addresses, titles, H1s) differ from last time's. */
  planChanged: boolean;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function planHash(rows: readonly PlanRow[]): string {
  return sha(
    rows
      .map((r) => `${addressKey(r)}\t${r.titleTag ?? ""}\t${r.h1 ?? ""}`)
      .sort()
      .join("\n"),
  );
}

/** Rows no finding names: a row with three findings is one row that doesn't match. */
export function rowsMatching(rows: readonly PlanRow[], findings: readonly Finding[]): number {
  const named = new Set<number>();
  for (const f of findings) for (const line of f.group?.lines ?? []) named.add(line);
  return rows.filter((r) => !named.has(r.line)).length;
}

export function compare(
  prev: PlanState | undefined,
  findings: readonly Finding[],
  rows: readonly PlanRow[],
  opts: { base: string; at: string },
): PlanProgress {
  const open: PlanState["open"] = {};
  for (const f of findings)
    open[fingerprint(f)] = { checkId: f.checkId, line: f.group?.lines[0] ?? 0, title: f.title };
  const state: PlanState = {
    schema: PLAN_STATE_SCHEMA,
    planHash: planHash(rows),
    base: opts.base,
    at: opts.at,
    rowsTotal: rows.length,
    rowsMatching: rowsMatching(rows, findings),
    open,
  };
  const before = prev?.open ?? {};
  const fixed = Object.keys(before).filter((k) => !(k in open));
  const added = Object.keys(open).filter((k) => !(k in before));
  return {
    state,
    ...(prev ? { previous: prev } : {}),
    fixed,
    added,
    still: Object.keys(open).length - added.length,
    planChanged: prev !== undefined && prev.planHash !== state.planHash,
  };
}

export type ReadState =
  { kind: "ok"; state: PlanState } | { kind: "corrupt" } | { kind: "newer"; schema: unknown };

/** A state file's text: this schema, a later one (refuse it), or something unreadable. */
export function readPlanState(text: string): ReadState {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "corrupt" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { kind: "corrupt" };
  const d = data as Record<string, unknown>;
  if (typeof d.schema === "number" && d.schema > PLAN_STATE_SCHEMA)
    return { kind: "newer", schema: d.schema };
  if (
    d.schema !== PLAN_STATE_SCHEMA ||
    typeof d.planHash !== "string" ||
    typeof d.at !== "string" ||
    typeof d.rowsTotal !== "number" ||
    typeof d.rowsMatching !== "number" ||
    d.open === null ||
    typeof d.open !== "object"
  )
    return { kind: "corrupt" };
  return { kind: "ok", state: data as PlanState };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct", with the year when it isn't this one. Dates are UTC, so the same run reads the same. */
export function shortDate(iso: string, now: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the last run";
  const year = new Date(now).getUTCFullYear();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""}${d.getUTCFullYear() === year ? "" : ` ${d.getUTCFullYear()}`}`;
}

/**
 * The line printed last: "142 of 163 rows match the plan (was 131). 14 fixed since 3 Oct, 3 new,
 * 18 still open." A first run says what it saved instead.
 */
export function progressLine(p: PlanProgress): string {
  const { state, previous } = p;
  const rows = `${state.rowsMatching} of ${state.rowsTotal} row${state.rowsTotal === 1 ? "" : "s"} match the plan`;
  const open = Object.keys(state.open).length;
  if (!previous) return `${rows}. First run: ${open} open.`;
  const note =
    previous.rowsTotal !== state.rowsTotal
      ? ` of ${previous.rowsTotal}; the plan changed`
      : p.planChanged
        ? "; the plan changed"
        : "";
  return `${rows} (was ${previous.rowsMatching}${note}). ${p.fixed.length} fixed since ${shortDate(previous.at, state.at)}, ${p.added.length} new, ${p.still} still open.`;
}
