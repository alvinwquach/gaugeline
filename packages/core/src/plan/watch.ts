import { ConfigError } from "../errors.js";
import { fingerprint } from "../fingerprint.js";
import type { Finding } from "../model.js";
import type { PlanState } from "./progress.js";

/**
 * The 30-day watch after cutover: a scheduled CI job runs the plan check against production each
 * day and speaks up only when something new drifts. The command counts the days itself, so a
 * forgotten workflow stops requesting the site after day 30.
 */
export const WATCH_DAYS = 30;

export type WatchDay = { kind: "watching"; day: number } | { kind: "over"; day: number };

const DAY_MS = 86_400_000;

/** Day 1 is the cutover date itself, compared in UTC; day 30 runs, day 31 is over. */
export function watchDay(cutover: string, now: Date): WatchDay {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cutover.trim());
  const start = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
  if (!m || Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== cutover.trim())
    throw new ConfigError(
      `--watch: "${cutover}" is not a date. Give the cutover date as YYYY-MM-DD.`,
    );
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = Math.floor((today - start) / DAY_MS) + 1;
  if (day < 1)
    throw new ConfigError(
      `--watch: the cutover date ${cutover} is in the future. The watch starts on the cutover day.`,
      { hint: "Run without --watch until then, or check the date." },
    );
  return day > WATCH_DAYS ? { kind: "over", day } : { kind: "watching", day };
}

/** "Day 9 of 30 since cutover", with a note when the plan changed since the baseline. */
export function watchLine(day: number, planChanged = false): string {
  return `Day ${day} of ${WATCH_DAYS} since cutover${planChanged ? " (the plan has changed since the baseline)" : ""}`;
}

/** Findings whose fingerprint isn't in the last run's state: what is new. */
export function newSince(findings: readonly Finding[], previous: PlanState | undefined): Finding[] {
  if (!previous) return [...findings];
  return findings.filter((f) => !(fingerprint(f) in previous.open));
}

/** The last line of a watch day: "No new drift. 2 known findings still open." */
export function watchSummary(fresh: number, known: number, fixed: number): string {
  const knownText = `${known} known finding${known === 1 ? "" : "s"} still open`;
  const fixedText = fixed > 0 ? ` ${fixed} fixed since the last run.` : "";
  return fresh === 0
    ? `No new drift. ${knownText}.${fixedText}`
    : `${fresh} new since the last run. ${knownText}.${fixedText}`;
}
