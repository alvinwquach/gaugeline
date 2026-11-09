import { AREA_ORDER, CHECK_TITLES } from "../check-titles";
import { LEVELS, type Finding, type Level } from "../types";

/** The two filters. Each is "any of these"; an empty Set means "all". */
export interface Filters {
  levels: ReadonlySet<Level>;
  areas: ReadonlySet<string>;
}

/** Where a finding goes when this build has no title for its check (one from a newer version). */
export const OTHER_AREA = "Other checks";

/** The area the report files a finding under, from its check id. */
export function areaOf(finding: Pick<Finding, "checkId">): string {
  return CHECK_TITLES[finding.checkId]?.[1] ?? OTHER_AREA;
}

/**
 * The findings that pass both filters, in the order given. A Set answers "is this one of the
 * chosen?" in constant time, so one pass over the list is all it takes; levels and areas combine
 * with AND, and the choices inside one of them with OR. Anything extra on an item (the view adds
 * its place in the result) is kept.
 */
export function filterFindings<T extends Finding>(
  findings: readonly T[],
  { levels, areas }: Filters,
): T[] {
  if (levels.size === 0 && areas.size === 0) return [...findings];
  return findings.filter(
    (f) =>
      (levels.size === 0 || levels.has(f.severity)) && (areas.size === 0 || areas.has(areaOf(f))),
  );
}

/**
 * How many findings each button would show. Every level is there (zero included); an area is there
 * only when this run has a finding in it, in the report's order.
 */
export function facetCounts(findings: readonly Finding[]): {
  levels: Map<Level, number>;
  areas: Map<string, number>;
} {
  const levels = new Map<Level, number>(LEVELS.map((l) => [l, 0]));
  const found = new Map<string, number>();
  for (const f of findings) {
    levels.set(f.severity, (levels.get(f.severity) ?? 0) + 1);
    const area = areaOf(f);
    found.set(area, (found.get(area) ?? 0) + 1);
  }
  const areas = new Map<string, number>();
  for (const area of [...AREA_ORDER, OTHER_AREA]) {
    const n = found.get(area);
    if (n) areas.set(area, n);
  }
  return { levels, areas };
}
