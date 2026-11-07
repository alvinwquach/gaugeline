import { appendFileSync } from "node:fs";
import { SEVERITY_LABEL, type Finding, type Severity } from "@gaugeline/core";

/** How many findings the summary lists before saying how many more there are. */
export const SUMMARY_LIMIT = 10;

/** A Markdown table cell: pipes and backslashes escaped, line breaks flattened. */
export function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n|\r/g, " ")
    .trim();
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * The GitHub Actions job summary for a plan check: rows read and matching, findings by level, and
 * the first ten findings with their plan lines. Markdown, short enough to read in the run's page.
 */
export function planStepSummary(input: {
  file: string;
  rows: number;
  /** Plan lines the findings point at. */
  findings: readonly Finding[];
  couldNotCheck: number;
}): string {
  const lines = new Set(input.findings.flatMap((f) => f.group?.lines ?? []));
  const matching = Math.max(0, input.rows - lines.size);
  const by = (s: Severity) => input.findings.filter((f) => f.severity === s).length;
  const out = [
    `### Gaugeline plan check: ${cell(input.file)}`,
    "",
    `**${n(input.rows)} row${input.rows === 1 ? "" : "s"}**, ${n(matching)} matching. ${input.findings.length === 0 ? "No findings." : `${n(input.findings.length)} finding${input.findings.length === 1 ? "" : "s"}: ${n(by("high"))} ${SEVERITY_LABEL.high.toLowerCase()}, ${n(by("medium"))} ${SEVERITY_LABEL.medium.toLowerCase()}, ${n(by("low"))} ${SEVERITY_LABEL.low.toLowerCase()}.`}${input.couldNotCheck > 0 ? ` ${n(input.couldNotCheck)} could not be checked.` : ""}`,
  ];
  if (input.findings.length > 0) {
    out.push("", "| Line | Level | Finding | Evidence |", "| ---: | --- | --- | --- |");
    for (const f of input.findings.slice(0, SUMMARY_LIMIT))
      out.push(
        `| ${f.group?.lines.join(", ") ?? ""} | ${SEVERITY_LABEL[f.severity]} | ${cell(f.title)} | ${cell(f.evidence)} |`,
      );
    const rest = input.findings.length - SUMMARY_LIMIT;
    if (rest > 0) out.push("", `…and ${n(rest)} more: run the plan check locally to see them all.`);
  }
  return `${out.join("\n")}\n`;
}

/** Append to $GITHUB_STEP_SUMMARY when it is set; write nothing (and create nothing) when it isn't. */
export function appendStepSummary(env: Record<string, string | undefined>, markdown: string): void {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, `${markdown}\n`);
}
