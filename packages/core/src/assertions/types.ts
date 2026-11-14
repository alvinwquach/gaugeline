import type { Severity } from "../model.js";

/**
 * How one assertion came out.
 * - passed: the query ran and returned no rows.
 * - failed: it returned rows; `count` of them and the evidence of the first few.
 * - could-not-check: it did not run to the end (the database was down, the query ran out of time, the
 *   role may not read a table). Never a pass.
 * - config-error: the file is wrong (the SQL is not a read, an evidence column is not in the result).
 *   It is the owner's to fix and it ends the `assert` command with exit 2.
 */
export type AssertionStatus = "passed" | "failed" | "could-not-check" | "config-error";

export interface AssertionResult {
  id: string;
  title: string;
  severity: Severity;
  /** The source's name in the config. */
  source: string;
  status: AssertionStatus;
  /** Rows that broke the rule: all of them, or the cap when `atLeast` is true. 0 unless failed. */
  count: number;
  /** True when the query had more rows than were read, so `count` is a floor. */
  atLeast: boolean;
  /** The evidence columns, in the order the config lists them. Empty unless failed. */
  columns: string[];
  /** The first rows, evidence columns only, as escaped and redacted text. */
  rows: Array<Record<string, string>>;
  /** Why it could not be checked, or what is wrong with the file. Names the assertion. */
  message?: string;
}
