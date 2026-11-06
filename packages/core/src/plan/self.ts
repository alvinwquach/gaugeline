import type { Finding, Severity } from "../model.js";
import { addressKey, groupBy, textKey } from "./keys.js";
import type { PlanRow } from "./read.js";

/**
 * The plan against itself, before anything is built: pure, no requests. Each rule groups rows by
 * a key in one pass, and every group larger than one is a single finding listing all its lines.
 */
export interface SelfRule {
  id: "plan-duplicate-address" | "plan-duplicate-title" | "plan-duplicate-h1";
  severity: Severity;
  title: string;
  key(row: PlanRow): string | undefined;
  /** How the shared value is shown in the evidence. */
  label(row: PlanRow): string;
}

const nonEmpty = (s: string | undefined) => (s && s.trim() !== "" ? textKey(s) : undefined);

export const SELF_RULES: readonly SelfRule[] = Object.freeze([
  {
    id: "plan-duplicate-address",
    severity: "high",
    title: "Two rows in the plan share one address",
    key: (r) => addressKey(r),
    label: (r) => (r.fragment ? `${r.path}#${r.fragment}` : r.path),
  },
  {
    id: "plan-duplicate-title",
    severity: "medium",
    title: "Two rows in the plan have the same title tag",
    key: (r) => nonEmpty(r.titleTag),
    label: (r) => `"${r.titleTag ?? ""}"`,
  },
  {
    id: "plan-duplicate-h1",
    severity: "medium",
    title: "Two rows in the plan have the same H1",
    key: (r) => nonEmpty(r.h1),
    label: (r) => `"${r.h1 ?? ""}"`,
  },
]);

/** "lines 12, 30 and 41" */
function lines(rows: readonly PlanRow[]): string {
  const ns = rows.map((r) => String(r.line));
  return ns.length === 1
    ? `line ${ns[0] ?? ""}`
    : `lines ${ns.slice(0, -1).join(", ")} and ${ns.at(-1) ?? ""}`;
}

/** One rule over the rows. `file` is the finding's url: the plan a person opens. */
export function runSelfRule(rule: SelfRule, rows: readonly PlanRow[], file: string): Finding[] {
  const out: Finding[] = [];
  for (const group of groupBy(rows, (r) => rule.key(r)).values()) {
    if (group.length < 2) continue;
    const first = group[0];
    if (!first) continue;
    out.push({
      checkId: rule.id,
      severity: rule.severity,
      title: rule.title,
      evidence: `${rule.label(first)} on ${lines(group)} (${group.length} rows)`,
      url: file,
    });
  }
  return out;
}

/** Every self-check rule over the plan's rows, in rule order. */
export function checkPlan(rows: readonly PlanRow[], file = "the plan"): Finding[] {
  return SELF_RULES.flatMap((rule) => runSelfRule(rule, rows, file));
}
