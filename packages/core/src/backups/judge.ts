import { DAY_MS, writeDate } from "../renewals/dates.js";
import type { ExportFile } from "./types.js";

/** Whole days between a backup and the injected clock. A backup a little in the future is today, never negative. */
export function ageInDays(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));
}

/** True when the backup is older than `maxAgeDays` whole days, by the millisecond. */
export function stale(iso: string, now: Date, maxAgeDays: number): boolean {
  return now.getTime() - Date.parse(iso) > maxAgeDays * DAY_MS;
}

/** A time further than this past the clock cannot be a backup that already ran: a clock a few hours off is allowed. */
export const FUTURE_SLACK_MS = DAY_MS;

/** True when a time is more than a day after the injected clock. */
export function inFuture(iso: string, now: Date): boolean {
  return Date.parse(iso) - now.getTime() > FUTURE_SLACK_MS;
}

/** "today (11 Nov 2026)", "1 day ago (10 Nov 2026)", "12 days ago (30 Oct 2026)". */
export function agePhrase(iso: string, now: Date): string {
  const days = ageInDays(iso, now);
  const when = days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"} ago`;
  return `${when} (${writeDate(iso)})`;
}

/** The UTC day of an ISO time, "2026-11-10". */
export const dayOf = (iso: string): string => new Date(Date.parse(iso)).toISOString().slice(0, 10);

const NAME_DATE =
  /(?<![0-9])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?![0-9])/;

/**
 * The day an export file stands for: a date written in its name (2026-11-10, 20261110, 2026.11.10),
 * else the day it was last changed, which the result says. A number that is not a calendar day (a
 * millisecond timestamp, 2026-13-45) is not a date. Pure.
 */
export function exportDateOf(
  name: string,
  modified: string,
): { date: string; dateFrom: "name" | "modified"; at: string } {
  const m = NAME_DATE.exec(name);
  if (m) {
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    // 2026-02-31 matches the pattern and is not a day.
    if (dayOf(`${date}T00:00:00Z`) === date)
      return { date, dateFrom: "name", at: `${date}T23:59:59.999Z` };
  }
  const at = new Date(Date.parse(modified));
  return { date: dayOf(modified), dateFrom: "modified", at: at.toISOString() };
}

export type ExportJudgement =
  { kind: "empty" } | { kind: "ok"; latest: ExportFile; previous?: ExportFile; shrunk: boolean };

/** The biggest file of a day, then the first by name: one file stands for the day, so a second run does not hide a good one. */
function byDay(files: readonly ExportFile[]): ExportFile[] {
  const days = new Map<string, ExportFile>();
  for (const f of files) {
    const best = days.get(f.date);
    if (!best || f.size > best.size || (f.size === best.size && f.name < best.name))
      days.set(f.date, f);
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * The latest export and the one before it, and whether the latest is far smaller: under `shrinkPercent`
 * percent of the previous one's size. Integer arithmetic (size times 100 against size times percent), so
 * the same files give the same answer on every machine. A previous export of zero bytes has nothing to
 * shrink from.
 */
export function judgeExports(files: readonly ExportFile[], shrinkPercent: number): ExportJudgement {
  const days = byDay(files);
  const latest = days[0];
  if (!latest) return { kind: "empty" };
  const previous = days[1];
  const shrunk = previous !== undefined && latest.size * 100 < previous.size * shrinkPercent;
  return { kind: "ok", latest, ...(previous ? { previous } : {}), shrunk };
}

const withCommas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A size for people: "812 bytes", "41 KB", "1.2 MB", in thousands (not 1,024s), one decimal under 10. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "";
  for (const u of units) {
    value /= 1000;
    unit = u;
    if (value < 1000) break;
  }
  const tenths = Math.round(value * 10);
  const text =
    value >= 100
      ? withCommas(Math.round(value))
      : tenths % 10 === 0
        ? String(tenths / 10)
        : (tenths / 10).toFixed(1);
  return `${text} ${unit}`;
}
