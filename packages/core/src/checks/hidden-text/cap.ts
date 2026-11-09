import type { Finding } from "../../model.js";

/** The most findings one of these checks reports for one page. */
export const MAX_PER_PAGE = 10;

/** The first MAX_PER_PAGE findings; the last says how many more there were. */
export function capFindings(all: Finding[]): Finding[] {
  if (all.length <= MAX_PER_PAGE) return all;
  const kept = all.slice(0, MAX_PER_PAGE);
  const last = kept[MAX_PER_PAGE - 1];
  if (last) {
    kept[MAX_PER_PAGE - 1] = {
      ...last,
      evidence: `${last.evidence} (and ${all.length - MAX_PER_PAGE} more on this page)`,
    };
  }
  return kept;
}
