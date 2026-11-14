import { findingKey } from "../changes/history.js";
import { expiryPhrase, daysUntil } from "../renewals/dates.js";
import { renewalLabel } from "../renewals/format.js";
import type { RenewalRow } from "../renewals/reader.js";
import { RECEIPT_GROUPS, receiptGroupOf, type ReceiptGroupId } from "./groups.js";
import { parseReceiptMonth } from "./month.js";

/**
 * The care-plan receipt (F-13): what Gaugeline caught in a month, restated from the runs it already
 * keeps. It only counts and dates what a run recorded. It never estimates money or traffic, and it
 * says "before your customers did" only for a fix nobody reported. Pure: no clock, no file, no
 * request. The same runs give the same receipt, and nothing passed in is changed.
 */

/** One run, as much of it as a receipt reads. A saved run record fits (`pages` is its page paths). */
export interface ReceiptRun {
  /** ISO time the run was taken. */
  takenAt: string;
  /** The page paths this run read: a finding is gone only from a run that read its page. */
  pages: readonly string[];
  findings: readonly { checkId: string; path: string; title: string }[];
}

/** A finding the client reported (G34's "reported by client"): one check, on one page or on any. */
export interface ClientReport {
  checkId: string;
  path?: string;
}

export interface ReceiptItem {
  checkId: string;
  title: string;
  path: string;
  /** The first run that had it, as a UTC day (YYYY-MM-DD). */
  firstSeen: string;
  /** The first run that read the page and did not have it, as a UTC day. Absent while it is open. */
  resolvedOn?: string;
  reportedByClient: boolean;
}

export interface ReceiptGroup {
  id: ReceiptGroupId;
  name: string;
  items: ReceiptItem[];
}

export interface ComingUp {
  /** "Domain marlowe-bar.example: expires 20 Dec 2026, 37 days". */
  label: string;
  /** The day it lapses (YYYY-MM-DD). */
  date: string;
  /** Whole days from the receipt's clock until it lapses. */
  days: number;
}

export interface Receipt {
  schema: 1;
  site: string;
  month: string;
  /** The first moment of the month and of the next one, as ISO times. */
  from: string;
  to: string;
  /** True when the month is not over: the receipt is the month so far. */
  partial: boolean;
  /** The clock the receipt was made at (the "coming up" window starts here). */
  asOf: string;
  /** Checks that ran in the month, and on how many different UTC days. */
  checks: { ran: number; days: number };
  /** Whole numbers: findings first seen in the month, fixes in the month, and what is open at its end. */
  counts: { opened: number; beforeCustomers: number; afterYouToldUs: number; stillOpen: number };
  /** Fixed in the month and not reported by the client, by group (empty groups left out). */
  groups: ReceiptGroup[];
  /** Fixed in the month after the client reported them. */
  afterYouToldUs: ReceiptItem[];
  /** Open at the end of the month, oldest first. */
  stillOpen: ReceiptItem[];
  /** F-01 renewals due in the next COMING_UP_DAYS days, soonest first. */
  comingUp: ComingUp[];
  /** Checks ran, and nothing was opened or fixed in the month. */
  quiet: boolean;
}

export const COMING_UP_DAYS = 60;

export interface CareReceiptInput {
  /** The site's host. */
  site: string;
  /** yyyy-mm, UTC. */
  month: string;
  runs: readonly ReceiptRun[];
  clientReported?: readonly ClientReport[];
  /** What F-01 read: only rows with a date within COMING_UP_DAYS of `now` are used. */
  renewals?: readonly Pick<RenewalRow, "kind" | "subject" | "date">[];
  now: Date;
}

const day = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

/** One stretch of runs that all had a finding, and the run that ended it. */
interface Episode {
  checkId: string;
  path: string;
  title: string;
  firstSeen: string;
  resolvedOn?: string;
}

export function buildReceipt(input: CareReceiptInput): Receipt {
  const span = parseReceiptMonth(input.month);
  if (!span) throw new RangeError(`The month is yyyy-mm, such as 2026-10, not "${input.month}".`);
  const now = input.now.getTime();
  if (now < Date.parse(span.from))
    throw new RangeError(`${input.month} has not started yet, so there is nothing to report.`);
  const from = Date.parse(span.from);
  const to = Date.parse(span.to);
  const partial = now < to;

  // Runs up to the end of the month only: what happened later is not this month's. A Map of
  // key -> episodes keeps first-seen order; counts are integers.
  const runs = input.runs
    .map((r) => ({ ...r, at: Date.parse(r.takenAt) }))
    .filter((r) => !Number.isNaN(r.at) && r.at < to)
    .sort((a, b) => a.at - b.at || a.takenAt.localeCompare(b.takenAt));

  const inMonth = runs.filter((r) => r.at >= from);
  const checks = {
    ran: inMonth.length,
    days: new Set(inMonth.map((r) => day(r.takenAt))).size,
  };

  const keys = new Map<string, { checkId: string; path: string }>();
  const held = runs.map((r) => {
    const keySet = new Set<string>();
    const titles = new Map<string, string>();
    for (const f of r.findings) {
      const key = findingKey(f);
      keySet.add(key);
      titles.set(key, f.title);
      if (!keys.has(key)) keys.set(key, { checkId: f.checkId, path: f.path });
    }
    return { keySet, titles, pages: new Set(r.pages) };
  });

  const episodes: Episode[] = [];
  for (const [key, { checkId, path }] of keys) {
    let open: Episode | undefined;
    runs.forEach((r, i) => {
      const h = held[i];
      if (!h) return;
      if (h.keySet.has(key)) {
        const title = h.titles.get(key) ?? checkId;
        if (open) open.title = title;
        else open = { checkId, path, title, firstSeen: day(r.takenAt) };
      } else if (open && h.pages.has(path)) {
        episodes.push({ ...open, resolvedOn: day(r.takenAt) });
        open = undefined;
      }
    });
    if (open) episodes.push(open);
  }

  const reports = input.clientReported ?? [];
  const reported = (e: Episode) =>
    reports.some((c) => c.checkId === e.checkId && (c.path === undefined || c.path === e.path));
  const item = (e: Episode): ReceiptItem => ({
    checkId: e.checkId,
    title: e.title,
    path: e.path,
    firstSeen: e.firstSeen,
    ...(e.resolvedOn ? { resolvedOn: e.resolvedOn } : {}),
    reportedByClient: reported(e),
  });
  const fromDay = span.from.slice(0, 10);
  const toDay = span.to.slice(0, 10);
  const within = (d: string) => d >= fromDay && d < toDay;
  const byDate = (a: ReceiptItem, b: ReceiptItem) =>
    (a.resolvedOn ?? "").localeCompare(b.resolvedOn ?? "") ||
    a.firstSeen.localeCompare(b.firstSeen) ||
    a.checkId.localeCompare(b.checkId) ||
    a.path.localeCompare(b.path);

  const fixed = episodes
    .filter((e) => e.resolvedOn !== undefined && within(e.resolvedOn))
    .map(item)
    .sort(byDate);
  const stillOpen = episodes
    .filter((e) => e.resolvedOn === undefined)
    .map(item)
    .sort(byDate);
  const opened = episodes.filter((e) => within(e.firstSeen)).length;

  const byGroup = new Map<ReceiptGroupId, ReceiptItem[]>();
  for (const i of fixed.filter((i) => !i.reportedByClient)) {
    const id = receiptGroupOf(i.checkId);
    byGroup.set(id, [...(byGroup.get(id) ?? []), i]);
  }
  const groups = RECEIPT_GROUPS.flatMap((g): ReceiptGroup[] => {
    const items = byGroup.get(g.id);
    return items ? [{ id: g.id, name: g.name, items }] : [];
  });
  const afterYouToldUs = fixed.filter((i) => i.reportedByClient);
  const beforeCustomers = fixed.length - afterYouToldUs.length;

  const comingUp = (input.renewals ?? [])
    .flatMap((r): { label: string; date: string; days: number; at: number }[] => {
      if (r.date === undefined || Number.isNaN(Date.parse(r.date))) return [];
      const at = Date.parse(r.date);
      const days = daysUntil(r.date, input.now);
      if (at < now || days > COMING_UP_DAYS) return [];
      return [
        {
          label: `${renewalLabel(r)}: ${expiryPhrase(r.date, input.now)}`,
          date: day(r.date),
          days,
          at,
        },
      ];
    })
    .sort((a, b) => a.at - b.at || a.label.localeCompare(b.label))
    .map(({ label, date, days }) => ({ label, date, days }));

  return {
    schema: 1,
    site: input.site,
    month: input.month,
    from: span.from,
    to: span.to,
    partial,
    asOf: input.now.toISOString(),
    checks,
    counts: {
      opened,
      beforeCustomers,
      afterYouToldUs: afterYouToldUs.length,
      stillOpen: stillOpen.length,
    },
    groups,
    afterYouToldUs,
    stillOpen,
    comingUp,
    quiet: checks.ran > 0 && opened === 0 && fixed.length === 0,
  };
}
