import { ConfigError } from "../errors.js";

/** The window `gaugeline delivery` reads when --since is not given. Proposed. */
export const DEFAULT_WINDOW = "7d";
/** The furthest back a window may reach, in days. Proposed: a typo such as 7000d is not a window. */
export const MAX_WINDOW_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A span of time, from the oldest instant read to now. */
export interface Window {
  from: Date;
  to: Date;
  /** Reads after "in": "the last 7 days", "since 2026-11-01". */
  label: string;
}

function refuse(text: string, why?: string): never {
  throw new ConfigError(
    `--since "${text}" is not a window${why ? `: ${why}` : ""}. Use a number of days or hours such as 7d or 24h, or a date such as 2026-11-01.`,
    { hint: "For example: gaugeline delivery --paid --sent --since 7d." },
  );
}

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? `the last ${one}` : `the last ${n} ${many}`;

/**
 * 7d, 24h, an ISO date (midnight UTC that day) or an ISO date and time with an offset. Anything
 * else is a ConfigError (exit 2), as is a window that starts in the future or more than
 * MAX_WINDOW_DAYS back. `now` is passed in so the same input always gives the same window.
 */
export function parseWindow(text: string | undefined, now: Date): Window {
  const given = (text ?? DEFAULT_WINDOW).trim();
  const relative = /^([1-9]\d{0,4})([dh])$/i.exec(given);
  let from: Date;
  let label: string;
  if (relative) {
    const n = Number(relative[1]);
    const days = relative[2]?.toLowerCase() === "d";
    from = new Date(now.getTime() - n * (days ? DAY_MS : HOUR_MS));
    label = days ? plural(n, "day", "days") : plural(n, "hour", "hours");
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(given)) {
    from = new Date(`${given}T00:00:00.000Z`);
    // new Date rolls 2026-02-30 over to March: the date must read back the same.
    if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== given) refuse(given);
    label = `since ${given}`;
  } else if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(given)
  ) {
    from = new Date(given);
    if (Number.isNaN(from.getTime())) refuse(given);
    label = `since ${from.toISOString().replace(".000Z", "Z")}`;
  } else {
    return refuse(given);
  }
  if (from.getTime() >= now.getTime()) refuse(given, "it starts in the future");
  if (now.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS)
    refuse(given, `it reaches back more than ${MAX_WINDOW_DAYS} days`);
  return { from, to: now, label };
}
