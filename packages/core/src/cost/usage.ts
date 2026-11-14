import { DAY_MS, writeDate } from "../renewals/dates.js";
import { DEFAULT_MULTIPLE, DEFAULT_WINDOW } from "./config.js";

export { DEFAULT_MULTIPLE, DEFAULT_WINDOW };

/**
 * One usage figure by day, as whole thousandths of its unit (12.5 GB is 12500): integers, so a sum or a
 * comparison is exact and the same on every machine. `daily` is keyed by the UTC day, "2026-11-10".
 */
export interface Metric {
  name: string;
  unit: string;
  daily: ReadonlyMap<string, number>;
}

/** What one provider's usage read gave: the metrics, or why they could not be had. */
export type UsageProviderRead =
  | { ok: true; provider: "Vercel" | "Sanity"; metrics: Metric[] }
  | {
      ok: false;
      provider: "Vercel" | "Sanity";
      /** True when a request was made and it failed; false when none was (no key, no documented endpoint). */
      asked: boolean;
      /** True when the user set this provider's key: a provider that is not set up is only mentioned when nothing at all could be read. */
      configured: boolean;
      reason: string;
    };

export interface UsageRead {
  providers: UsageProviderRead[];
}

export interface Jump {
  metric: string;
  unit: string;
  /** The UTC day that jumped, the latest complete one. */
  day: string;
  /** Thousandths of the unit. */
  latest: number;
  /** The trailing average, thousandths, rounded to the nearest. */
  average: number;
  window: number;
  /** The multiple that was configured. */
  multiple: number;
  /** latest divided by the average, in tenths (34 is 3.4 times), rounded down. */
  ratioTenths: number;
}

/** The UTC calendar day of a clock reading, "2026-11-11". */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The day before a UTC day, by 86,400-second steps from midnight UTC: a month end or a leap day never skips. */
export const dayBefore = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/** The `n` days before `latest`, newest first. */
export function windowDays(latest: string, n: number): string[] {
  const out: string[] = [];
  let day = latest;
  for (let i = 0; i < n; i++) {
    day = dayBefore(day);
    out.push(day);
  }
  return out;
}

/** One whole unit in thousandths: a day under this is noise, not a jump. */
const ONE_UNIT = 1000;

/**
 * Metrics whose latest complete day (yesterday, UTC, from the injected clock) is more than `multiple`
 * times the average of the `window` days before it. Days with no row count as zero; a metric with no
 * usage in those days has nothing to be a multiple of and is skipped; a latest day under one whole unit
 * is skipped. Integer arithmetic (BigInt for the comparison, so a month of bytes cannot overflow): the
 * same input gives the same jumps. Biggest jump first, then by name.
 */
export function detectJumps(
  metrics: readonly Metric[],
  now: Date,
  opts: { multiple?: number; window?: number },
): Jump[] {
  const window = opts.window ?? DEFAULT_WINDOW;
  const multiple = opts.multiple ?? DEFAULT_MULTIPLE;
  const hundredths = BigInt(Math.round(multiple * 100));
  const day = dayBefore(utcDay(now));
  const before = windowDays(day, window);
  const jumps: Array<Jump & { ratioHundredths: bigint }> = [];
  for (const m of metrics) {
    const latest = m.daily.get(day) ?? 0;
    const sum = before.reduce((total, d) => total + (m.daily.get(d) ?? 0), 0);
    if (sum <= 0 || latest < ONE_UNIT) continue;
    const latestScaled = BigInt(latest) * 100n * BigInt(window);
    if (latestScaled <= BigInt(sum) * hundredths) continue;
    const ratioHundredths = latestScaled / BigInt(sum);
    jumps.push({
      metric: m.name,
      unit: m.unit,
      day,
      latest,
      average: Math.round(sum / window),
      window,
      multiple,
      ratioTenths: Number(ratioHundredths / 10n),
      ratioHundredths,
    });
  }
  return jumps
    .sort(
      (a, b) =>
        (a.ratioHundredths === b.ratioHundredths
          ? 0
          : a.ratioHundredths > b.ratioHundredths
            ? -1
            : 1) || a.metric.localeCompare(b.metric),
    )
    .map(({ ratioHundredths: _ignored, ...jump }) => jump);
}

const withCommas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * A figure in thousandths with its unit, for people: "41 GB", "12.5 GB", "1,234,567" (the unit "Number"
 * and "Requests" are the count itself), "0.4 USD". Under 100 whole units it shows one decimal when it
 * has one; from 100 it rounds to a whole number.
 */
export function formatQuantity(thousandths: number, unit: string): string {
  const whole = thousandths / 1000;
  let text: string;
  if (whole >= 100) text = withCommas(Math.round(whole));
  else {
    const tenths = Math.round(thousandths / 100);
    text = tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  return unit === "Number" ? text : `${text} ${unit}`;
}

/** "was 41 GB on 10 Nov 2026, 3.4 times its average of 12 GB over the 14 days before". */
export function jumpPhrase(j: Jump): string {
  return `was ${formatQuantity(j.latest, j.unit)} on ${writeDate(`${j.day}T00:00:00Z`)}, ${Math.floor(j.ratioTenths / 10)}.${j.ratioTenths % 10} times its average of ${formatQuantity(j.average, j.unit)} over the ${j.window} days before`;
}
