/**
 * Quiet hours (X67): when a message may go, in the site's own time zone. Shared by the rule-based findings
 * notifications (notify.ts) and the agent messages (agent-messages.ts), so both wait for the same hours.
 */

/** The zone if this runtime knows it, else UTC (as the dashboard does): Postgres knows names ICU does not. */
function knownZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

function localHour(at: Date, zone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(at)
    .find((p) => p.type === "hour")?.value;
  return Number(h ?? "0");
}

/**
 * When a message may go: now, or the first minute after quiet hours end in the site's own zone. Hours are
 * whole local hours, start inclusive and end exclusive; a span that crosses midnight (22 to 7) works, and
 * the walk is by minute, so a clock change cannot skip or repeat the end hour.
 */
export function sendAfter(now: Date, zone: string, start: number | null, end: number | null): Date {
  if (start === null || end === null || start === end) return now;
  zone = knownZone(zone);
  const quiet = (h: number) => (start < end ? h >= start && h < end : h >= start || h < end);
  if (!quiet(localHour(now, zone))) return now;
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 26 * 60; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (!quiet(localHour(t, zone))) return t;
  }
  return now;
}
