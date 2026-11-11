import { escapeInvisible } from "../checks/hidden-text/escape.js";
import {
  POINTS,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type CheckRegistry,
  type Finding,
  type Severity,
  type Size,
} from "../model.js";
import { minorExponent } from "../products/money.js";
import type { Result } from "../result.js";

/**
 * The work order (G28): a Markdown file that says how many items are worth paying to fix and how big
 * each is, then each item with what is wrong, why it matters, what "done" looks like, the evidence and
 * what changes the estimate. It is made from a finished result and the check registry, by templates:
 * no model, no clock, no request and no file. The same result and options give the same text.
 *
 * Sizes are read from each check through the registry (the kind of fix, known when the check was
 * written), never guessed from how severe a finding is.
 */
export interface BriefOptions {
  /** The business the work order is for. Shown in the heading, escaped. Default: the site's host. */
  business?: string;
  /** What an hour costs, in whole minor units (11000 is $110.00). Used only with hoursPerPoint. */
  rateMinor?: number;
  /** ISO 4217 code of the rate. Default "usd". */
  currency?: string;
  /** What a point costs in hours, to two decimals. Without it the work order gives points only. */
  hoursPerPoint?: number;
}

const SIZE_NAME: Readonly<Record<Size, string>> = Object.freeze({
  S: "Small",
  M: "Medium",
  L: "Large",
});

/**
 * The hours range is 80% to 130% of points times hours per point. Percentages as integers, so the
 * arithmetic below is in whole numbers: an estimate that is a float picks up an error nobody can see
 * and a range's end can come out a unit off.
 */
const RANGE_PERCENT = Object.freeze({ low: 80, high: 130 });

/** One hundredth of an hour, in the units the range is worked out in: hours times 10,000 / percent. */
const SCALE = 10_000;

/** A positive hours-per-point as whole hundredths of an hour. */
function hundredths(hoursPerPoint: number): number {
  if (!Number.isFinite(hoursPerPoint) || hoursPerPoint <= 0)
    throw new RangeError("Hours per point must be a number above zero.");
  return Math.max(1, Math.round(hoursPerPoint * 100));
}

/** points x hundredths x percent: hours times 10,000, a whole number. */
function scaled(points: number, h100: number, percent: number): number {
  if (!Number.isSafeInteger(points) || points < 0)
    throw new RangeError("Points must be a whole number, zero or more.");
  const x = points * h100 * percent;
  if (!Number.isSafeInteger(x)) throw new RangeError("That is too many points to work out.");
  return x;
}

/**
 * The hours a number of points is likely to take, as a range of whole hours that always has two
 * ends: never a single number. 80% to 130% of points times hours per point, rounded half up.
 */
export function hoursRange(points: number, hoursPerPoint: number): { low: number; high: number } {
  const h100 = hundredths(hoursPerPoint);
  const round = (x: number) => Math.floor((x + SCALE / 2) / SCALE);
  const low = Math.max(1, round(scaled(points, h100, RANGE_PERCENT.low)));
  const high = Math.max(low + 1, round(scaled(points, h100, RANGE_PERCENT.high)));
  return { low, high };
}

/**
 * The same range in money: the unrounded hours times the rate, then rounded half up to whole currency
 * units (so 21.45 hours at $110 is $2,359.50, which is $2,360). The amounts are in minor units and are
 * always whole units, so a person never sees cents on an estimate.
 */
export function costRange(
  points: number,
  hoursPerPoint: number,
  rateMinor: number,
  currency = "usd",
): { lowMinor: number; highMinor: number; currency: string } {
  if (!Number.isSafeInteger(rateMinor) || rateMinor <= 0)
    throw new RangeError("The rate must be a whole number of minor units above zero.");
  const h100 = hundredths(hoursPerPoint);
  const factor = 10 ** minorExponent(currency);
  const wholeUnits = (x: number): number => {
    const n = x * rateMinor;
    if (!Number.isSafeInteger(2 * n + SCALE * factor))
      throw new RangeError("That is too much money to work out.");
    // round(n / (SCALE x factor)) half up, in integers.
    return Math.floor((2 * n + SCALE * factor) / (2 * SCALE * factor));
  };
  return {
    lowMinor: wholeUnits(scaled(points, h100, RANGE_PERCENT.low)) * factor,
    highMinor: wholeUnits(scaled(points, h100, RANGE_PERCENT.high)) * factor,
    currency,
  };
}

/**
 * An amount in minor units as money, in whole units unless it has a fraction ($1,452, $110.50). The
 * locale is fixed (en-US), so the same number reads the same on every machine.
 */
export function formatCurrency(minor: number, currency = "usd"): string {
  const digits = minorExponent(currency);
  const factor = 10 ** digits;
  const places = minor % factor === 0 ? 0 : digits;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(minor / factor);
}

/** The \u{HEX} escapes escapeInvisible writes: a backslash before a "u" is plain text in Markdown. */
const ALREADY_ESCAPED = /\\u\{[0-9A-F]+\}/u;
const MARKDOWN = new RegExp(`${ALREADY_ESCAPED.source}|[\\\\\`*_\\[\\]()<>#~|&]`, "gu");

/**
 * Text made safe to put in a Markdown line (CommonMark: any ASCII punctuation may be escaped with a
 * backslash). Line breaks and runs of spaces become one space, so a value cannot start a heading, a
 * list or a table of its own, and the characters that mean something in Markdown or in the HTML it
 * may contain are escaped.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(MARKDOWN, (m) => (m.startsWith("\\u{") ? m : `\\${m}`));
}

/** For text that starts a list item: a leading marker or number (`- x`, `1. x`) would nest a list, so it is escaped too. */
function escapeStartingLine(text: string): string {
  return escapeMarkdown(text)
    .replace(/^([-+=])/u, "\\$1")
    .replace(/^(\d+)([.)])/u, "$1\\$2");
}

/** Text that came from a page: control, zero-width, bidirectional and tag characters shown as escapes, cut, then escaped. */
const EVIDENCE_MAX = 300;
const fromPage = (text: string): string => escapeMarkdown(escapeInvisible(text, EVIDENCE_MAX));
const fromPageStartingLine = (text: string): string =>
  escapeStartingLine(escapeInvisible(text, EVIDENCE_MAX));

/** An address without its query string or fragment, which can carry a token. */
function withoutQuery(address: string): string {
  try {
    const u = new URL(address);
    return `${u.origin}${u.pathname}`;
  } catch {
    return address.split(/[?#]/u)[0] ?? "";
  }
}

function hostOf(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return address;
  }
}

/**
 * A Markdown table with its columns padded to one width, so it reads as a table in a text editor too
 * (the numbers are right-aligned). The cells are already escaped.
 */
function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = head.map((h, c) => Math.max(3, h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const right = head.length - 1;
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((v, c) => (c === right ? v.padStart(widths[c] ?? 0) : v.padEnd(widths[c] ?? 0))).join(" | ")} |`;
  return [
    line(head),
    `| ${widths.map((w, c) => (c === right ? `${"-".repeat(w - 1)}:` : "-".repeat(w))).join(" | ")} |`,
    ...rows.map(line),
  ];
}

/** The findings of one check, in the order they came. A Map keeps the first appearance and is one lookup per finding. */
interface Group {
  checkId: string;
  findings: Finding[];
}

/** A check as the registry holds it, whatever its input. */
type RegisteredCheck = NonNullable<ReturnType<CheckRegistry["get"]>>;

interface Item {
  check: RegisteredCheck;
  group: Group;
  severity: Severity;
  size: Size;
  points: number;
  /** Position of the group's first finding: the last tie-breaker, so the order is stable. */
  first: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * One line of evidence for a finding: what it found, and where. The address is added only when the
 * evidence does not already name it, so a line never says the same address twice.
 */
function evidenceLine(f: Finding): string {
  const what = fromPageStartingLine(f.evidence);
  const address = f.url === "" ? "" : withoutQuery(f.url);
  const named = address !== "" && (f.evidence.includes(address) || f.evidence.includes(f.url));
  const where = address === "" || named ? "" : escapeMarkdown(address);
  if (what === "") return where;
  return where === "" ? what : `${what} (${where})`;
}

function evidenceOf(group: Group): string[] {
  const seen = new Set<string>();
  for (const f of group.findings) {
    const line = evidenceLine(f);
    if (line !== "") seen.add(line);
  }
  return [...seen];
}

/** The most severe level among a group's findings (high before medium before low). */
function severityOf(findings: readonly Finding[]): Severity {
  let best: Severity = "low";
  for (const f of findings)
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[best]) best = f.severity;
  return best;
}

/**
 * The work order as Markdown. Several findings from one check are one item with several evidence
 * lines (twelve images with no alt text are one job with twelve places to look), sized once. Items are
 * ordered by severity, then by size with the smallest first. A finding whose check is not in the
 * registry (a removed custom check) is listed as not sized and left out of the total.
 */
export function briefMarkdown(
  result: Result,
  registry: CheckRegistry,
  opts: BriefOptions = {},
): string {
  const groups = new Map<string, Group>();
  const firstAt = new Map<string, number>();
  result.findings.forEach((f, i) => {
    const group = groups.get(f.checkId) ?? { checkId: f.checkId, findings: [] };
    group.findings.push(f);
    if (!groups.has(f.checkId)) {
      groups.set(f.checkId, group);
      firstAt.set(f.checkId, i);
    }
  });

  const items: Item[] = [];
  const unsized: Group[] = [];
  for (const group of groups.values()) {
    const check = registry.get(group.checkId);
    if (check === undefined) {
      unsized.push(group);
      continue;
    }
    items.push({
      check,
      group,
      severity: severityOf(group.findings),
      size: check.size,
      points: POINTS[check.size],
      first: firstAt.get(group.checkId) ?? 0,
    });
  }
  items.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.points - b.points ||
      a.first - b.first,
  );
  const points = items.reduce((sum, item) => sum + item.points, 0);

  const name = escapeMarkdown(opts.business ?? "") || escapeMarkdown(hostOf(result.url));
  const out: string[] = [
    `# Work order: ${name}`,
    "",
    `Checked ${escapeMarkdown(withoutQuery(result.url))} at ${result.startedAt}.`,
    "",
    "## What is worth paying to fix",
    "",
  ];

  if (items.length === 0) {
    out.push(
      unsized.length === 0
        ? "Nothing needs paying for. Gaugeline found nothing to fix on this site."
        : "Nothing needs paying for that Gaugeline can size. The findings that have no size are listed below.",
    );
  } else {
    out.push(
      `${plural(items.length, "item is", "items are")} worth paying to fix, ${plural(points, "point")} in all.`,
      "",
      ...table(
        ["#", "Item", "Size", "Points"],
        items.map((item, i) => [
          String(i + 1),
          escapeMarkdown(item.check.title),
          SIZE_NAME[item.size],
          String(item.points),
        ]),
      ),
      "",
    );
    if (opts.hoursPerPoint !== undefined) {
      const hours = hoursRange(points, opts.hoursPerPoint);
      const per = hundredths(opts.hoursPerPoint) / 100;
      let money = "";
      if (opts.rateMinor !== undefined) {
        const currency = opts.currency ?? "usd";
        const cost = costRange(points, opts.hoursPerPoint, opts.rateMinor, currency);
        money = ` (about ${formatCurrency(cost.lowMinor, currency)}\u2013${formatCurrency(cost.highMinor, currency)} at ${formatCurrency(opts.rateMinor, currency)}/hour)`;
      }
      out.push(
        `At ${per} ${per === 1 ? "hour" : "hours"} per point, that's roughly ${hours.low}\u2013${hours.high} hours${money}.`,
        "",
      );
    }
    out.push(
      `Small is ${POINTS.S} point, Medium ${POINTS.M} and Large ${POINTS.L}. Points say how big a fix is. Whoever quotes the work turns them into time and money, because the same fix is minutes in a shared component and an afternoon when it is hardcoded in twelve places, and each item says what changes its estimate.`,
    );
  }

  const unread = new Set(result.couldNotCheck.map((c) => c.id)).size;
  if (unread > 0)
    out.push(
      "",
      `${plural(unread, "check")} could not read ${unread === 1 ? "part" : "parts"} of the site, so this work order may be missing items.`,
    );

  items.forEach((item, i) => {
    const { check } = item;
    out.push(
      "",
      `## ${i + 1}. ${escapeMarkdown(check.title)}`,
      "",
      `**Size:** ${SIZE_NAME[item.size]} (${plural(item.points, "point")}). **Priority:** ${SEVERITY_LABEL[item.severity]}.`,
      "",
      `**What is wrong:** ${escapeMarkdown(check.what)}`,
      "",
      `**Why it matters:** ${escapeMarkdown(check.why)}`,
      "",
      `**What done looks like:** ${escapeMarkdown(check.done)}`,
      "",
      "**Evidence:**",
      "",
      ...evidenceOf(item.group).map((line) => `- ${line}`),
      "",
      `**What changes the estimate:** ${escapeMarkdown(check.estimateChanges)}`,
    );
  });

  if (unsized.length > 0) {
    out.push(
      "",
      "## Not sized",
      "",
      "These findings come from checks this version of Gaugeline does not have (a custom check that was removed, for example), so they have no size and are not in the total above.",
      "",
    );
    for (const group of unsized) {
      const first = group.findings[0];
      out.push(
        `- **${fromPage(first?.title ?? group.checkId)}** (${fromPage(group.checkId)})`,
        ...evidenceOf(group).map((line) => `  - ${line}`),
      );
    }
  }

  return `${out.join("\n")}\n`;
}
