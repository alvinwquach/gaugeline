/**
 * Dates for the renewals checks. Everything is read and written in UTC and counted in whole days of
 * 86,400 seconds from an injected clock, so a clock change (daylight saving) or a leap day never moves
 * a threshold: the same input gives the same finding on any machine.
 */
export const DAY_MS = 86_400_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whole days from `now` until `iso`, rounded down; negative once it has passed. NaN for a bad date. */
export function daysUntil(iso: string, now: Date): number {
  return Math.floor((Date.parse(iso) - now.getTime()) / DAY_MS);
}

/** "3 Dec 2026", in UTC. */
export function writeDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

/** "3 Dec 2026" back to an ISO day, or undefined. The inverse of writeDate. */
export function readWrittenDate(text: string): string | undefined {
  const m = /\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})\b/.exec(text);
  if (!m) return undefined;
  const t = Date.UTC(Number(m[3]), MONTHS.indexOf(m[2] ?? ""), Number(m[1]));
  const d = new Date(t);
  return d.getUTCDate() === Number(m[1]) ? d.toISOString().slice(0, 10) : undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "expires 3 Dec 2026, 24 days", "expires 3 Dec 2026, less than a day" or "expired 28 Nov 2026, 3 days
 * ago". The date is written out, then the count, so a client reads it without a calendar.
 */
export function expiryPhrase(
  iso: string,
  now: Date,
  verbs: readonly [future: string, past: string] = ["expires", "expired"],
): string {
  const days = daysUntil(iso, now);
  const date = writeDate(iso);
  if (Date.parse(iso) <= now.getTime()) {
    const ago = Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
    return `${verbs[1]} ${date}, ${ago <= 0 ? "less than a day ago" : `${plural(ago, "day")} ago`}`;
  }
  return `${verbs[0]} ${date}, ${days === 0 ? "less than a day" : plural(days, "day")}`;
}

/** The ISO time of an RDAP or API date, or undefined when it is not one. */
export function isoOf(text: unknown): string | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** How urgent a date is: first (fix first), soon (fix soon) or fine. `soon` and `first` are day counts. */
export function urgency(
  iso: string,
  now: Date,
  soon: number,
  first: number,
): "first" | "soon" | "fine" {
  if (Date.parse(iso) <= now.getTime()) return "first";
  const days = daysUntil(iso, now);
  return days < first ? "first" : days < soon ? "soon" : "fine";
}
