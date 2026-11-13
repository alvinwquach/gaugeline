/**
 * The weekly client update (X66): one client's week of runs, per site, in the digest's plain wording (core's
 * digest.ts: "New this week", "Fixed this week", what is still open, "This week: ..."). Plain rules over the
 * runs, no model call: the same week gives the same text whatever order the runs arrive in.
 *
 * Findings are matched across runs by fingerprint (the same join key as the nightly diff, G36). Against the
 * last run before the week: new = not open before, still there in the last run of the week; fixed = open
 * before or seen this week, gone from the last run; still waiting = open before and still there.
 */
import { shortDate } from "@gaugeline/core";
import { pageText } from "../lib/web/html.js";

export interface WeekFinding {
  fingerprint: string;
  title: string;
  url: string;
  severity: "high" | "medium" | "low";
}

export interface WeekRun {
  startedAt: string;
  findings: WeekFinding[];
}

export interface WeekSite {
  name: string;
  url: string;
  /** The findings of the last run before the week, or [] when there was none. */
  before: WeekFinding[];
  /** The runs that started in the week. */
  runs: WeekRun[];
}

export interface WeekInput {
  agencyName: string;
  clientName: string;
  /** The Monday the week starts on, YYYY-MM-DD (UTC). */
  weekStart: string;
  sites: WeekSite[];
}

export interface SiteWeek {
  lines: string[];
  counts: { new: number; fixed: number; waiting: number };
  /** High-severity findings still open at the end of the week. */
  high: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Text from a site or a person (a finding's title, a client, site or agency name) cleaned by core's sanitise
 * (bidirectional controls removed, other controls shown as text) and kept to one line, so it always fits the
 * email draft's shape (kinds.ts, migration 0005).
 */
const clean = (title: string): string => pageText(title, "title").replace(/\s+/g, " ").trim();

/** Titles of a fingerprint set, sorted so the text does not depend on the order rows arrived. */
function titles(keys: Iterable<string>, byKey: Map<string, WeekFinding>): string[] {
  return [...keys]
    .map((k) => clean(byKey.get(k)?.title ?? k))
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** One site's part of the update, and its counts for the all-clients view. */
export function siteWeek(site: WeekSite): SiteWeek {
  const heading = `${clean(site.name)} (${clean(host(site.url))})`;
  const runs = [...site.runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const last = runs.at(-1);
  if (!last)
    return {
      lines: [heading, "Not checked this week."],
      counts: { new: 0, fixed: 0, waiting: 0 },
      high: 0,
    };

  // fingerprint -> the latest finding seen with it (later runs overwrite earlier ones). Map: one entry per key.
  const byKey = new Map<string, WeekFinding>();
  for (const x of site.before) byKey.set(x.fingerprint, x);
  for (const r of runs) for (const x of r.findings) byKey.set(x.fingerprint, x);
  const before = new Set(site.before.map((x) => x.fingerprint));
  const now = new Set(last.findings.map((x) => x.fingerprint));
  const fresh = [...now].filter((k) => !before.has(k));
  const waiting = [...now].filter((k) => before.has(k));
  const fixed = [...byKey.keys()].filter((k) => !now.has(k));

  const first = runs[0]!;
  const day = (at: string) => shortDate(new Date(at), "UTC");
  const lines = [
    heading,
    runs.length === 1
      ? `Checked once, on ${day(last.startedAt)}.`
      : `Checked ${plural(runs.length, "time")} between ${day(first.startedAt)} and ${day(last.startedAt)}.`,
  ];
  if (fresh.length + fixed.length + waiting.length === 0) {
    lines.push("All checked, nothing found.");
  } else {
    const parts = [
      fresh.length > 0 ? `${plural(fresh.length, "new thing")} to fix` : "",
      fixed.length > 0 ? `${fixed.length} fixed` : "",
      waiting.length > 0
        ? `${waiting.length} older ${waiting.length === 1 ? "one" : "ones"} still open`
        : now.size === 0
          ? "nothing left open"
          : "",
    ].filter((p) => p !== "");
    const tail = parts.pop() ?? "";
    lines.push(`This week: ${parts.length > 0 ? `${parts.join(", ")} and ${tail}` : tail}.`, "");
    for (const [label, keys] of [
      ["New this week:", fresh],
      ["Fixed this week:", fixed],
      ["Still waiting:", waiting],
    ] as const) {
      if (keys.length === 0) continue;
      lines.push(label, ...titles(keys, byKey).map((t) => `- ${t}`));
    }
  }
  const high = last.findings.filter((x) => x.severity === "high").length;
  return {
    lines,
    counts: { new: fresh.length, fixed: fixed.length, waiting: waiting.length },
    high,
  };
}

/** The whole update for one client: subject and plain-text body (an `email` draft's payload, G37). */
export function composeWeeklyUpdate(input: WeekInput): { subject: string; body: string } {
  const agency = clean(input.agencyName);
  const client = clean(input.clientName);
  const sites = [...input.sites].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.url.localeCompare(b.url, "en"),
  );
  const monday = shortDate(new Date(`${input.weekStart}T00:00:00Z`), "UTC");
  const opening = `Hello from ${agency}. Here is what we checked on your ${sites.length === 1 ? "site" : "sites"} this week.`;
  const blocks = sites.map((s) => siteWeek(s).lines.join("\n").replace(/\n+$/, ""));
  return {
    subject: `${client}: your sites, week of ${monday}`.slice(0, 200),
    body: [opening, ...blocks, agency].join("\n\n").slice(0, 20_000),
  };
}

export interface ClientRow {
  name: string;
  /** High-severity findings open now, across the client's sites. */
  high: number;
  /** Findings open now. */
  open: number;
  /** New plus fixed this week. */
  changed: number;
}

/** The all-clients view: worst first (most high findings, then most open, then most changed), then by name. */
export function sortClientsWorstFirst<T extends ClientRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      b.high - a.high ||
      b.open - a.open ||
      b.changed - a.changed ||
      a.name.localeCompare(b.name, "en"),
  );
}
