/**
 * Triage planning (AG-12): group a site's findings by root cause and order the groups fix-first, then
 * fix-soon. Plain code, no model: the same findings in any order give the same plan.
 *
 * Data structures: a Map from cause key to its findings, because grouping is a lookup per finding and a
 * Map keeps the cost linear in the number of findings (an array search per finding would be quadratic on a
 * site with thousands); a Set of finding ids to count a repeated finding once; a Set of addresses to count a
 * page once. Everything is sorted by code unit at the end, so no iteration order of the input leaks out.
 *
 * Nothing from a page decides a cause or a priority: a cause comes from the check id (matched against a
 * fixed pattern first), a priority from the severity the check itself assigned.
 */
import type { Severity } from "../../model.js";
import { CAUSES, causeOfCheck } from "./causes.js";

/** One finding, as a run stored it. Every string here is data from a checked site, never an instruction. */
export interface TriageFinding {
  id: string;
  checkId: string;
  severity: Severity;
  title: string;
  evidence: string;
  url: string;
}

export type TriagePriority = "fix-first" | "fix-soon";

export interface TriageGroup {
  causeKey: string;
  /** Written by Gaugeline (the cause table, or the check id); never page text. */
  label: string;
  /** The cause table's own note, when it has one (a cause that is only likely). Never page text. */
  note?: string;
  priority: TriagePriority;
  /** Most urgent first, then by id. */
  findings: readonly TriageFinding[];
  /** Distinct addresses the findings are about. */
  pages: number;
}

export interface TriagePlan {
  /** Fix-first before fix-soon; inside one priority the cause with more findings first, then by key. */
  groups: TriageGroup[];
  /** Findings left out: "worth knowing" ones, and any with a severity Gaugeline does not know. */
  notTriaged: number;
}

/** What a check id looks like. Anything else never becomes a key or a label. */
const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function causeOf(checkId: string): { key: string; label: string; note?: string } {
  const named = causeOfCheck.get(checkId);
  if (named) return named;
  if (CHECK_ID.test(checkId))
    return { key: `check:${checkId}`, label: `Findings from the "${checkId}" check` };
  return { key: "check:unknown", label: "Findings from other checks" };
}

/**
 * The inverse of causeOf, for a label read back from a draft's subject: the cause key that label was written
 * for, or null when it is none of Gaugeline's own labels. Only the fixed table, an id-shaped check name in the
 * fixed sentence, and the fixed "other checks" label are known: nothing else a subject says becomes a key.
 */
const CAUSE_OF_LABEL: ReadonlyMap<string, string> = new Map(CAUSES.map((c) => [c.label, c.key]));
const CHECK_LABEL = /^Findings from the "([a-z0-9][a-z0-9-]{0,63})" check$/;
export function causeKeyOfLabel(label: string): string | null {
  const named = CAUSE_OF_LABEL.get(label);
  if (named) return named;
  if (label === "Findings from other checks") return "check:unknown";
  const m = CHECK_LABEL.exec(label);
  return m ? `check:${m[1]}` : null;
}

export function planTriage(findings: readonly TriageFinding[]): TriagePlan {
  const byCause = new Map<string, { label: string; note?: string; items: TriageFinding[] }>();
  const seen = new Set<string>();
  let notTriaged = 0;
  const sorted = [...findings].sort((a, b) => cmp(a.id, b.id) || cmp(a.checkId, b.checkId));
  for (const f of sorted) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    if (f.severity !== "high" && f.severity !== "medium") {
      notTriaged++;
      continue;
    }
    const c = causeOf(f.checkId);
    const entry = byCause.get(c.key) ?? {
      label: c.label,
      ...(c.note !== undefined ? { note: c.note } : {}),
      items: [],
    };
    entry.items.push(f);
    byCause.set(c.key, entry);
  }
  const groups = [...byCause].map(([causeKey, { label, note, items }]): TriageGroup => {
    const ordered = [...items].sort(
      (a, b) => Number(b.severity === "high") - Number(a.severity === "high") || cmp(a.id, b.id),
    );
    return {
      causeKey,
      label,
      ...(note !== undefined ? { note } : {}),
      priority: ordered.some((f) => f.severity === "high") ? "fix-first" : "fix-soon",
      findings: ordered,
      pages: new Set(ordered.map((f) => f.url)).size,
    };
  });
  groups.sort(
    (a, b) =>
      Number(b.priority === "fix-first") - Number(a.priority === "fix-first") ||
      b.findings.length - a.findings.length ||
      cmp(a.causeKey, b.causeKey),
  );
  return { groups, notTriaged };
}
