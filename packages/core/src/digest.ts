import { createPageRegistry } from "./checks/index.js";
import { SEVERITY_ORDER, type CheckRegistry, type Finding, type Severity } from "./model.js";
import { redact } from "./redact.js";
import { RENEWAL_CHECK_IDS, renewalItems } from "./renewals/section.js";
import { escapeHtml } from "./report/html.js";
import type { Result } from "./result.js";

/**
 * The weekly digest: a week of saved runs (--json) read into what is new, what was fixed and what
 * is still open, in sentences someone who doesn't read JSON can forward. Plain rules over the runs:
 * the same runs give the same digest.
 */

/** Runs older than this before the latest one are left out. */
export const DIGEST_DAYS = 7;
const DAY_MS = 86_400_000;

export interface DigestItem {
  key: string;
  checkId: string;
  severity: Severity;
  /** The plain sentence (the finding's title). */
  title: string;
  /** What to do, from the check. */
  fix?: string;
  /** The page, without its query string. */
  page: string;
  evidence: string;
  firstSeen: Date;
  lastSeen: Date;
  /** The first run it was missing from, after it was last seen. */
  fixedAt?: Date;
}

export interface Digest {
  site: string;
  runs: number;
  from: Date;
  to: Date;
  /** Runs before the week that were left out. */
  older: number;
  newThisWeek: DigestItem[];
  fixed: DigestItem[];
  /** Open before the week and still open, oldest first. */
  stillOpen: DigestItem[];
  /** Checks that passed in the latest run. */
  agree: number;
  timeZone: string;
}

/** Numbers vary between runs ("3 links", "12 KB"); the same finding keeps its key. */
export function findingKey(f: Pick<Finding, "checkId" | "url" | "evidence">): string {
  return `${f.checkId} ${stripQuery(f.url)} ${f.evidence.replace(/\d+(?:[.,]\d+)?/g, "#")}`;
}

/** An address without its query string or fragment: a query can carry a token. */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.replace(/[?#].*$/, "");
  }
}

/** Evidence safe for the digest: no secrets, and query strings cut to "?…". */
export function safeEvidence(text: string): string {
  return redact(text).replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/g, "$1?…");
}

/** The calendar date in the zone, as YYYY-MM-DD. */
function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Whole calendar days from `a` to `b` in the zone. A clock change makes a day 23 or 25 hours long,
 * so days are counted by date, never by dividing milliseconds.
 */
export function daysBetween(a: Date, b: Date, timeZone: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUtc(localDate(b, timeZone)) - toUtc(localDate(a, timeZone))) / DAY_MS);
}

/** "Mon 2 Nov" in the zone. */
export function shortDate(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Group a week of runs of one site. Throws a plain error when the runs are of more than one site
 * or there are none. Runs are sorted by startedAt; those more than 7 days before the latest are
 * left out (and counted).
 */
export function buildDigest(
  results: readonly Result[],
  opts: { registry?: CheckRegistry; timeZone?: string } = {},
): Digest {
  if (results.length === 0) throw new Error("There are no saved runs to make a digest from.");
  const hosts = [...new Set(results.map((r) => hostOf(r.url)))];
  if (hosts.length > 1)
    throw new Error(
      `The runs are of more than one site (${hosts.join(", ")}): give one site's runs.`,
    );
  const registry = opts.registry ?? createPageRegistry();
  const timeZone = opts.timeZone ?? "UTC";
  const sorted = [...results].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const latestAt = Date.parse(sorted.at(-1)?.startedAt ?? "");
  const week = sorted.filter((r) => latestAt - Date.parse(r.startedAt) <= DIGEST_DAYS * DAY_MS);
  const first = week[0];
  const latest = week.at(-1);
  if (!first || !latest) throw new Error("There are no saved runs to make a digest from.");
  const times = week.map((r) => new Date(r.startedAt));

  // key -> the item, filled as the runs are read in order. A Map keeps first-seen order.
  const items = new Map<string, DigestItem>();
  const seenIn = new Map<string, Set<number>>();
  week.forEach((run, i) => {
    for (const f of run.findings) {
      const key = findingKey(f);
      const at = times[i] ?? new Date(run.startedAt);
      const runs = seenIn.get(key) ?? new Set<number>();
      runs.add(i);
      seenIn.set(key, runs);
      const known = items.get(key);
      if (known) {
        known.lastSeen = at;
        known.evidence = safeEvidence(f.evidence);
        continue;
      }
      const fix = registry.get(f.checkId)?.fix;
      items.set(key, {
        key,
        checkId: f.checkId,
        severity: f.severity,
        title: f.title,
        ...(fix ? { fix } : {}),
        page: stripQuery(f.url),
        evidence: safeEvidence(f.evidence),
        firstSeen: at,
        lastSeen: at,
      });
    }
  });
  const last = week.length - 1;
  const urgency = (a: DigestItem, b: DigestItem) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.firstSeen.getTime() - b.firstSeen.getTime();
  const newThisWeek: DigestItem[] = [];
  const fixed: DigestItem[] = [];
  const stillOpen: DigestItem[] = [];
  for (const item of items.values()) {
    const runs = seenIn.get(item.key) ?? new Set<number>();
    const lastIndex = Math.max(...runs);
    if (lastIndex < last) {
      fixed.push({ ...item, ...(times[lastIndex + 1] ? { fixedAt: times[lastIndex + 1] } : {}) });
    } else if (week.length > 1 && !runs.has(0)) newThisWeek.push(item);
    else stillOpen.push(item);
  }
  newThisWeek.sort(urgency);
  fixed.sort(urgency);
  stillOpen.sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime() || urgency(a, b));
  return {
    site: stripQuery(latest.url),
    runs: week.length,
    from: new Date(first.startedAt),
    to: new Date(latest.startedAt),
    older: sorted.length - week.length,
    newThisWeek,
    fixed,
    stillOpen,
    agree: latest.passed.length,
    timeZone,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The one-line verdict. */
export function verdict(d: Digest): string {
  const open = d.newThisWeek.length + d.stillOpen.length;
  if (d.runs === 1)
    return open === 0
      ? `One check this week, and nothing to fix. ${plural(d.agree, "thing")} agree.`
      : `One check this week: ${plural(open, "thing")} to fix.`;
  if (d.newThisWeek.length === 0 && d.fixed.length === 0)
    return open === 0
      ? `Nothing changed. ${plural(d.agree, "thing")} still agree.`
      : `Nothing changed. ${plural(d.agree, "thing")} still agree, and ${plural(open, "thing")} still ${open === 1 ? "needs" : "need"} fixing.`;
  const older = d.stillOpen.length;
  const parts = [
    d.newThisWeek.length > 0 ? `${plural(d.newThisWeek.length, "new thing")} to fix` : "",
    d.fixed.length > 0 ? `${d.fixed.length} fixed` : "",
    older > 0
      ? `${older} older ${older === 1 ? "one" : "ones"} still open`
      : open === 0
        ? "nothing left open"
        : "",
  ].filter((p) => p !== "");
  const last = parts.pop() ?? "";
  return `This week: ${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}.`;
}

function path(page: string): string {
  try {
    return new URL(page).pathname;
  } catch {
    return page;
  }
}

function age(item: DigestItem, d: Digest): string {
  const days = daysBetween(item.firstSeen, d.to, d.timeZone);
  return days === 0 ? "first seen today" : `open ${plural(days, "day")}`;
}

/** The digest as plain lines, shared by the Markdown and HTML renderers. */
interface Section {
  heading: string;
  lines: { lead: string; rest: string }[];
}

function sections(d: Digest): { plain: Section[]; checked: string; notes: string[] } {
  const day = (t: Date) => shortDate(t, d.timeZone);
  const todo = (i: DigestItem) => (i.fix ? ` What to do: ${i.fix}` : "");
  const plain: Section[] = [];
  // Renewals (a domain, a certificate, a token) read by their date, not by when they were first seen:
  // one section, soonest first, with the date written out. They leave the lists below.
  const open = [...d.newThisWeek, ...d.stillOpen];
  const byKey = new Map(open.map((i) => [i.key, i] as const));
  const renewals = renewalItems(
    open.map((i) => ({
      checkId: i.checkId,
      severity: i.severity,
      title: i.title,
      evidence: i.evidence,
      url: i.key,
    })),
  ).flatMap((r) => {
    const item = byKey.get(r.url);
    return item ? [item] : [];
  });
  const isRenewal = (i: DigestItem) => RENEWAL_CHECK_IDS.has(i.checkId);
  if (renewals.length > 0)
    plain.push({
      heading: "Renewals",
      lines: renewals.map((item) => ({
        lead: item.title,
        rest: `: ${item.evidence}.${todo(item)}`,
      })),
    });
  const newThisWeek = d.newThisWeek.filter((i) => !isRenewal(i));
  const stillOpen = d.stillOpen.filter((i) => !isRenewal(i));
  if (newThisWeek.length > 0)
    plain.push({
      heading: "New this week",
      lines: newThisWeek.map((i) => ({
        lead: i.title,
        rest: ` (on ${path(i.page)}, first seen ${day(i.firstSeen)}).${todo(i)}`,
      })),
    });
  if (d.fixed.length > 0)
    plain.push({
      heading: "Fixed this week",
      lines: d.fixed.map((i) => ({
        lead: i.title,
        rest: ` (on ${path(i.page)}, seen ${day(i.firstSeen)}${i.fixedAt ? `, fixed by ${day(i.fixedAt)}` : ""}).`,
      })),
    });
  if (stillOpen.length > 0)
    plain.push({
      heading: "Still open",
      lines: stillOpen.map((i) => ({
        lead: i.title,
        rest: ` (on ${path(i.page)}, ${age(i, d)}).${todo(i)}`,
      })),
    });
  const span =
    d.runs === 1
      ? `once, on ${day(d.to)}`
      : `${plural(d.runs, "time")} between ${day(d.from)} and ${day(d.to)}`;
  const checked = `${d.site} was checked ${span}. ${plural(d.agree, "thing")} looked right in the latest check.${d.older > 0 ? ` ${plural(d.older, "older run")} ${d.older === 1 ? "was" : "were"} left out.` : ""}${d.runs === 1 ? " With one check, nothing can be called new or fixed yet." : ""}`;
  const notes = [...d.newThisWeek, ...d.fixed, ...d.stillOpen].map(
    (i) => `${i.checkId} on ${path(i.page)}: ${i.evidence}`,
  );
  return { plain, checked, notes };
}

export function digestMarkdown(d: Digest): string {
  const { plain, checked, notes } = sections(d);
  const out = [`# ${hostOf(d.site)}: the week`, "", verdict(d), ""];
  for (const s of plain) {
    out.push(`## ${s.heading}`, "");
    for (const l of s.lines) out.push(`- **${l.lead}**${l.rest}`);
    out.push("");
  }
  out.push("## What was checked", "", checked, "");
  if (notes.length > 0) {
    out.push("---", "", "## Technical notes", "");
    for (const n of notes) out.push(`- \`${n.replace(/`/g, "'")}\``);
    out.push("");
  }
  return out.join("\n");
}

/** One self-contained page, inline styles only, every value escaped: it is also an email body. */
export function digestHtml(d: Digest): string {
  const e = escapeHtml;
  const { plain, checked, notes } = sections(d);
  const out = [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(hostOf(d.site))}: the week</title></head>`,
    `<body><div style="font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#101828;max-width:44rem;margin:0 auto;padding:0 1rem">`,
    `<h1 style="font-size:1.4rem;margin:1rem 0 .25rem">${e(hostOf(d.site))}: the week</h1>`,
    `<p style="font-size:1.1rem;margin:0 0 1rem"><strong>${e(verdict(d))}</strong></p>`,
  ];
  for (const s of plain) {
    out.push(`<h2 style="font-size:1.1rem;margin:1.5rem 0 .5rem">${e(s.heading)}</h2>`, "<ul>");
    for (const l of s.lines) out.push(`<li><strong>${e(l.lead)}</strong>${e(l.rest)}</li>`);
    out.push("</ul>");
  }
  out.push(
    `<h2 style="font-size:1.1rem;margin:1.5rem 0 .5rem">What was checked</h2>`,
    `<p>${e(checked)}</p>`,
  );
  if (notes.length > 0) {
    out.push(
      '<hr style="border:0;border-top:1px solid #eaecf0;margin:2rem 0 1rem">',
      `<h2 style="font-size:1rem;margin:0 0 .5rem;color:#475467">Technical notes</h2>`,
      `<ul style="color:#475467;font-size:.875rem">`,
      ...notes.map(
        (n) =>
          `<li><code style="font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-word">${e(n)}</code></li>`,
      ),
      "</ul>",
    );
  }
  out.push("</div></body>", "</html>", "");
  return out.join("\n");
}
