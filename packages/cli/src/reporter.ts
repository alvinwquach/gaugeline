import {
  formatSampleSummary,
  forTerminal,
  TERMINAL_EVIDENCE_MAX,
  UNTRUSTED_CAPS,
  type BudgetSummary,
  type Finding,
  type RunResult,
} from "@gaugeline/core";
import { paint } from "./color.js";

function firstFew(items: readonly string[], n = 3): string {
  const shown = items.slice(0, n).join(", ");
  return items.length > n ? `${shown} and ${items.length - n} more` : shown;
}

const MARK = { high: "✗", medium: "!", low: "·" } as const;
const TICK = "✓";

/** "3 to look at, 2 to fix first." / "Nothing to look at." */
export function summaryLine(findings: readonly Pick<Finding, "severity">[]): string {
  if (findings.length === 0) return "Nothing to look at.";
  const high = findings.filter((f) => f.severity === "high").length;
  return `${findings.length} to look at, ${high === 0 ? "none" : high} to fix first.`;
}

export function failedLine(count: number): string {
  return count === 1 ? "1 check could not run" : `${count} checks could not run`;
}

export interface TerminalReport {
  result: RunResult;
  sampled?: BudgetSummary;
  color: boolean;
  /** Checks left out of this run on purpose, with what to do to run them (DNS without --dns). */
  notRun?: { ids: readonly string[]; hint: string };
  /** The checked page's origin: same-site addresses in "?" rows are shown as paths. */
  origin?: string;
  /** Lines printed last in place of the count line (plan --progress: what changed, then the summary). */
  footer?: readonly string[];
}

/** The plain-English report on stdout. Evidence is indented and greyed under each finding. */
export function formatTerminal({
  result,
  sampled,
  color,
  notRun,
  origin,
  footer,
}: TerminalReport): string {
  const short = (url: string) => {
    try {
      const u = new URL(url);
      return origin && u.origin === origin ? `${u.pathname}${u.search}` : url;
    } catch {
      return url;
    }
  };
  const p = paint(color);
  const lines: string[] = [];
  for (const f of result.findings) {
    const mark =
      f.severity === "high"
        ? p.red(MARK.high)
        : f.severity === "medium"
          ? p.yellow(MARK.medium)
          : p.grey(MARK.low);
    lines.push(`${mark} ${forTerminal(f.title, UNTRUSTED_CAPS.title)}`);
    lines.push(`    ${p.grey(forTerminal(f.evidence, TERMINAL_EVIDENCE_MAX))}`);
    // A plan finding covers a group of rows: every line once, so the owner can find them.
    // A live page the plan misses has no plan line to name.
    if (f.group && f.group.lines.length > 0)
      lines.push(
        `    ${p.grey(`${f.group.lines.length === 1 ? "line" : "lines"} ${f.group.lines.join(", ")}`)}`,
      );
  }
  for (const id of result.passed) lines.push(`${p.green(TICK)} ${p.grey(id)}`);
  if (result.failed.length > 0) {
    lines.push(
      `${p.yellow("?")} ${failedLine(result.failed.length)}: ${result.failed.map((f) => f.id).join(", ")}`,
    );
  }
  // One "?" row per check that could not read what it needed (a refused page or sample).
  const refused = new Map<string, { reason: string; urls: string[] }[]>();
  for (const c of result.couldNotCheck ?? []) {
    const rows = refused.get(c.id) ?? [];
    const row = rows.find((r) => r.reason === c.reason);
    if (row) row.urls.push(short(c.url));
    else rows.push({ reason: c.reason, urls: [short(c.url)] });
    refused.set(c.id, rows);
  }
  for (const [id, rows] of refused)
    for (const r of rows)
      lines.push(
        `${p.yellow("?")} ${id} could not be checked: ${r.reason}${r.urls.length > 1 || !r.reason.startsWith("the page") ? ` (${firstFew(r.urls)})` : ""}`,
      );
  if (notRun && notRun.ids.length > 0) {
    lines.push(`${p.yellow("?")} ${failedLine(notRun.ids.length)}: ${notRun.ids.join(", ")}`);
    lines.push(`    ${p.grey(notRun.hint)}`);
  }
  lines.push("");
  const sample = sampled ? formatSampleSummary(sampled) : "";
  if (sample !== "") lines.push(sample);
  if (footer) lines.push(...footer.slice(0, -1), p.bold(footer.at(-1) ?? ""));
  else lines.push(p.bold(summaryLine(result.findings)));
  return `${lines.join("\n")}\n`;
}
