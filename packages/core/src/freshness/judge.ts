import { duration } from "../switches/text.js";
import type { Moment } from "./time.js";

/**
 * Comparing a stamp with a limit. A stamp is a span of instants (see Moment), so a verdict is only
 * "stale" or "behind" when it is true at both ends of the span; when the limit falls inside the
 * span, the stamp does not say enough ("unsure") and the check reports could not check.
 */

export type AgeVerdict = "stale" | "fresh" | "unsure";
export type LagVerdict = "behind" | "level" | "unsure";

/** Whether a stamp is older than `maxAge` at `now`. */
export function judgeAge(stamp: Moment, now: number, maxAge: number): AgeVerdict {
  if (now - stamp.latest > maxAge) return "stale";
  if (now - stamp.earliest <= maxAge) return "fresh";
  return "unsure";
}

/** Whether a stamp is older than the source's newest time by more than `maxLag`. */
export function judgeLag(stamp: Moment, source: number, maxLag: number): LagVerdict {
  if (source - stamp.latest > maxLag) return "behind";
  if (source - stamp.earliest <= maxLag) return "level";
  return "unsure";
}

/** How long ago a stamp is: exactly for one with a zone, "at least" the fewest it could be otherwise. */
export function passedBy(stamp: Moment, now: number): string {
  const seconds = Math.max(0, Math.floor((now - stamp.latest) / 1000));
  return `${stamp.kind === "exact" ? "" : "at least "}${duration(seconds)}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function sentence(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "October to June": months as runs, so a window across new year reads as one. */
export function describeMonths(months: readonly number[]): string {
  const on = new Set(months);
  if (on.size === 12) return "every month";
  const runs: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const previous = m === 1 ? 12 : m - 1;
    if (!on.has(m) || on.has(previous)) continue;
    let end = m;
    let length = 1;
    while (on.has(end === 12 ? 1 : end + 1) && length < 12) {
      end = end === 12 ? 1 : end + 1;
      length += 1;
    }
    const first = MONTH_NAMES[m - 1] ?? "";
    const last = MONTH_NAMES[end - 1] ?? "";
    runs.push(length === 1 ? first : length === 2 ? `${first} and ${last}` : `${first} to ${last}`);
  }
  // "June and July" reads as a pair only when it is the whole answer; inside a list it is a run.
  if (runs.length === 1) return runs[0] ?? "";
  return sentence(runs.map((r) => r.replace(" and ", " to ")));
}
