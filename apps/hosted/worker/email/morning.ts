/**
 * The morning email, as plain rules with no database and no clock of its own (X64): which sites count for
 * which setting, the one sentence per site, the subject, and when it is 07:00 for a person. Same input,
 * same email.
 *
 * What may leave: counts, the site's name, the title of the most urgent new finding, and two links. Page
 * text (the title) is cleaned with core's sanitise (N17) and then escaped for HTML; the evidence line is
 * never sent. There are no images, styles, scripts or tracking addresses: the only addresses in the
 * message are the dashboard and the person's preference link.
 */
import { escapeHtml, sanitise, UNTRUSTED_CAPS, type BuiltEmail } from "@gaugeline/core";

export type Frequency = "every_change" | "fix_first" | "off";
export type Role = "owner" | "admin" | "member" | "client";

/** What one site's latest runs changed since the person's last email. */
export interface SiteChange {
  siteId: string;
  siteName: string;
  opened: number;
  /** Of the opened findings, how many are high severity ("fix first"). */
  openedHigh: number;
  closed: number;
  /** The title of the most urgent finding that opened (page text: cleaned before it is shown). */
  topTitle: string | null;
}

/**
 * A person's setting, or the default for their role when they never chose: owners and admins are on
 * (they answer for the sites), members are off until they opt in. A client viewer is never mailed.
 */
export function effectiveFrequency(chosen: Frequency | null, role: Role): Frequency {
  if (role === "client") return "off";
  return chosen ?? (role === "member" ? "off" : "every_change");
}

/** The sites this setting wants to hear about. */
export function forFrequency(changes: readonly SiteChange[], frequency: Frequency): SiteChange[] {
  if (frequency === "off") return [];
  return changes.filter((c) =>
    frequency === "fix_first" ? c.openedHigh > 0 : c.opened + c.closed > 0,
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SITE_NAME_CAP = 80;
const SUBJECT_TITLE_CAP = 90;

const clean = (text: string, cap: number): string => sanitise(text, cap).text;

/** One plain sentence for one site. `name` and `title` are already cleaned. */
function sentence(c: SiteChange, name: string, title: string | null): string {
  const high = c.openedHigh > 0 ? ` (${c.openedHigh} to fix first)` : "";
  const fresh = `${plural(c.opened, "new problem", "new problems")}${high}`;
  let s: string;
  if (c.opened > 0 && c.closed > 0) s = `${name}: ${fresh} and ${c.closed} fixed.`;
  else if (c.opened > 0) s = `${name}: ${fresh}.`;
  else s = `${name}: ${plural(c.closed, "problem", "problems")} fixed.`;
  return c.opened > 0 && title ? `${s} Start with "${title}".` : s;
}

function subjectFor(changes: readonly SiteChange[], names: readonly string[]): string {
  const opened = changes.reduce((n, c) => n + c.opened, 0);
  const closed = changes.reduce((n, c) => n + c.closed, 0);
  const sites = plural(changes.length, "site", "sites");
  const first = changes.findIndex((c) => c.opened > 0);
  if (opened === 1 && first >= 0 && changes[first]!.topTitle) {
    return `New: ${clean(changes[first]!.topTitle!, SUBJECT_TITLE_CAP)} (${names[first]})`;
  }
  if (opened > 0)
    return `${plural(opened, "new problem", "new problems")} on ${sites}${closed > 0 ? `, ${closed} fixed` : ""}`;
  return `${plural(closed, "problem", "problems")} fixed on ${sites}`;
}

/** A link we put in a message must be https: never javascript:, data: or plain http. */
export function httpsAddress(url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} is not an address`);
  }
  if (u.protocol !== "https:") throw new Error(`${what} must be an https address`);
  return u.href;
}

export interface MorningInput {
  orgName: string;
  /** Already limited to what the person's setting wants (forFrequency). */
  changes: readonly SiteChange[];
  /** Where the dashboard is, from configuration. */
  dashboardUrl: string;
  /** The person's signed preference link. */
  preferencesUrl: string;
}

/** The email, or null when nothing changed: a quiet night sends nothing. */
export function buildMorningEmail(input: MorningInput): BuiltEmail | null {
  const dashboard = httpsAddress(input.dashboardUrl, "the dashboard address");
  const preferences = httpsAddress(input.preferencesUrl, "the preference link");
  const changes = input.changes.filter((c) => c.opened + c.closed > 0);
  if (changes.length === 0) return null;
  const names = changes.map((c) => clean(c.siteName, SITE_NAME_CAP));
  const org = clean(input.orgName, SITE_NAME_CAP);
  const lines = changes.map((c, i) =>
    sentence(c, names[i]!, c.topTitle ? clean(c.topTitle, UNTRUSTED_CAPS.title) : null),
  );
  const subject = subjectFor(changes, names);
  const text = [
    `Overnight, Gaugeline found changes on ${org}'s sites.`,
    "",
    ...lines,
    "",
    `Open the dashboard to see each one and how to fix it: ${dashboard}`,
    "",
    "--",
    `You get this because you look after ${org} on Gaugeline. It only comes when something changed.`,
    `Change how often, or stop it: ${preferences}`,
    "",
  ].join("\n");
  const e = escapeHtml;
  const html = [
    "<!doctype html>",
    '<html lang="en"><body style="font-family:system-ui,Arial,sans-serif;line-height:1.5;color:#1b1b1b">',
    `<p>Overnight, Gaugeline found changes on ${e(org)}&#39;s sites.</p>`,
    "<ul>",
    ...lines.map((l) => `<li>${e(l)}</li>`),
    "</ul>",
    `<p><a href="${e(dashboard)}">Open the dashboard</a> to see each one and how to fix it.</p>`,
    `<p style="color:#555;font-size:0.9em">You get this because you look after ${e(org)} on Gaugeline. It only comes when something changed. <a href="${e(preferences)}">Change how often, or stop it</a>.</p>`,
    "</body></html>",
  ].join("\n");
  return { subject, html, text };
}

export interface LocalMorning {
  /** The date where the person is, as YYYY-MM-DD: the key that makes one email per person per day. */
  localDate: string;
  /** It is between 07:00 and 11:00 there. */
  due: boolean;
}

/** The first minute of the morning window, and the first minute after it, in local minutes. */
const WINDOW_START = 7 * 60;
const WINDOW_END = 11 * 60;

/**
 * Is it morning for someone in `timeZone`, and which local date is it? The wall clock is read from the
 * zone's own rules (Intl, the same time zone data as the server's), not worked out from an offset, so a
 * clock change moves nothing: 07:00 is 07:00 on the day clocks go forward and on the day they go back.
 * The window runs to 11:00 so a worker that was down at 07:00 still sends, once. Null for an unknown zone.
 */
export function localMorning(now: Date, timeZone: string): LocalMorning | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return {
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    due: minutes >= WINDOW_START && minutes < WINDOW_END,
  };
}

/** One run_changes row as the worker reads it, with the most urgent opened finding's title. */
export interface ChangeRow {
  siteId: string;
  siteName: string;
  opened: number;
  openedHigh: number;
  closed: number;
  topTitle: string | null;
}

/**
 * Several runs of one site since the last email (a nightly and a manual one) become one entry: the
 * counts add up, and the title shown is the latest one that is high severity, else the latest one.
 * Rows come oldest first. Sites keep the order they first appear in.
 */
export function mergeBySite(rows: readonly ChangeRow[]): SiteChange[] {
  const out = new Map<string, SiteChange>();
  for (const r of rows) {
    const had = out.get(r.siteId);
    if (!had) {
      out.set(r.siteId, { ...r });
      continue;
    }
    const takeTitle = r.topTitle !== null && (r.openedHigh > 0 || had.openedHigh === 0);
    out.set(r.siteId, {
      ...had,
      opened: had.opened + r.opened,
      openedHigh: had.openedHigh + r.openedHigh,
      closed: had.closed + r.closed,
      topTitle: takeTitle ? r.topTitle : had.topTitle,
    });
  }
  return [...out.values()];
}
