import {
  formatSampleSummary,
  type BudgetSummary,
  type Finding,
  type RunResult,
} from "@gaugeline/core";
import { paint } from "./color.js";

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
}

/** The plain-English report on stdout. Evidence is indented and greyed under each finding. */
export function formatTerminal({ result, sampled, color, notRun }: TerminalReport): string {
  const p = paint(color);
  const lines: string[] = [];
  for (const f of result.findings) {
    const mark =
      f.severity === "high"
        ? p.red(MARK.high)
        : f.severity === "medium"
          ? p.yellow(MARK.medium)
          : p.grey(MARK.low);
    lines.push(`${mark} ${f.title}`);
    lines.push(`    ${p.grey(f.evidence)}`);
  }
  for (const id of result.passed) lines.push(`${p.green(TICK)} ${p.grey(id)}`);
  if (result.failed.length > 0) {
    lines.push(
      `${p.yellow("?")} ${failedLine(result.failed.length)}: ${result.failed.map((f) => f.id).join(", ")}`,
    );
  }
  if (notRun && notRun.ids.length > 0) {
    lines.push(`${p.yellow("?")} ${failedLine(notRun.ids.length)}: ${notRun.ids.join(", ")}`);
    lines.push(`    ${p.grey(notRun.hint)}`);
  }
  lines.push("");
  const sample = sampled ? formatSampleSummary(sampled) : "";
  if (sample !== "") lines.push(sample);
  lines.push(p.bold(summaryLine(result.findings)));
  return `${lines.join("\n")}\n`;
}
