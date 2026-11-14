import {
  BUDGET_KINDS,
  renderReport,
  type BudgetSummary,
  type CheckRegistry,
  type RunResult,
} from "@gaugeline/core";
import type { Run } from "./store.js";

/**
 * The name the browser saves the report under. A constant, on purpose: nothing about the checked
 * site (its address, its title) is ever put into a response header.
 */
export const REPORT_FILENAME = "gaugeline-report.html";

/**
 * The report is a file to keep, never a page of the app. `sandbox` on its own gives a document that
 * is opened from here (a right-click, "open in a new tab") no scripts, no forms and no access to
 * the app's origin. It stands in place of the app's policy on this one response.
 */
export const REPORT_POLICY = "sandbox";

/** The headers of the download. The body's length is added by the route. */
export function reportHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-disposition": `attachment; filename="${REPORT_FILENAME}"`,
    "cache-control": "no-store",
    "content-security-policy": REPORT_POLICY,
  };
}

/**
 * The run's budget summary, read back from the result's `sampled` record: the result stores
 * seen/taken/limit for every kind, which is the summary under other names, so nothing is kept twice.
 */
export function budgetOf(sampled: RunResult["sampled"]): BudgetSummary {
  const out = {} as BudgetSummary;
  for (const kind of BUDGET_KINDS) {
    const s = sampled[kind];
    out[kind] = { limit: s?.limit ?? 0, sampled: s?.taken ?? 0, found: s?.seen ?? 0 };
  }
  return out;
}

/**
 * The same text `gaugeline <address>` writes to gaugeline-report.html for this run: one renderer
 * (renderReport), the inputs the CLI gives it. Undefined while the run has no report.
 */
export function renderRunReport(run: Run, registry: CheckRegistry, version: string) {
  if (!run.report) return undefined;
  return renderReport({
    result: run.report.result,
    url: run.report.url,
    startedAt: new Date(run.startedAt),
    registry,
    sampled: budgetOf(run.report.result.sampled),
    version,
  });
}
