import type { Since } from "./history.js";
import { inOrder } from "./history.js";
import type { RecordedSiteFinding, RunRecord } from "./types.js";

/** One finding of a site, by what makes it the same finding in the next run: its check and its address. */
export const siteFindingKey = (f: Pick<RecordedSiteFinding, "checkId" | "address">): string =>
  `${f.checkId} ${f.address}`;

/** A list with each finding once, in first-seen order. */
export function uniqueSite(
  list: readonly RecordedSiteFinding[] | undefined,
): RecordedSiteFinding[] {
  const seen = new Set<string>();
  return (list ?? []).filter((f) => {
    const key = siteFindingKey(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What changed in the site's findings between two runs. */
export interface SiteDiff {
  added: RecordedSiteFinding[];
  fixed: RecordedSiteFinding[];
  unchanged: RecordedSiteFinding[];
  /** Findings whose check could not be read in both runs: neither new nor fixed, so not compared. */
  notCompared: { before: number; after: number };
}

/**
 * The site's findings of two runs side by side, for the renewal checks both runs could read. A check
 * a run did not read (no --renewals, a registry that would not answer, an older run) says nothing, so
 * its finding missing from that run is never "fixed" and one present after it is never called new.
 * Undefined when the two runs share no readable check. Pure.
 */
export function siteDiff(before: RunRecord, after: RunRecord): SiteDiff | undefined {
  const shared = new Set(
    (before.renewalChecks ?? []).filter((id) => after.renewalChecks?.includes(id)),
  );
  if (shared.size === 0) return undefined;
  const was = uniqueSite(before.siteFindings);
  const now = uniqueSite(after.siteFindings);
  const wasKeys = new Set(was.filter((f) => shared.has(f.checkId)).map(siteFindingKey));
  const nowKeys = new Set(now.filter((f) => shared.has(f.checkId)).map(siteFindingKey));
  return {
    added: now.filter((f) => shared.has(f.checkId) && !wasKeys.has(siteFindingKey(f))),
    fixed: was.filter((f) => shared.has(f.checkId) && !nowKeys.has(siteFindingKey(f))),
    unchanged: now.filter((f) => shared.has(f.checkId) && wasKeys.has(siteFindingKey(f))),
    notCompared: {
      before: was.filter((f) => !shared.has(f.checkId)).length,
      after: now.filter((f) => !shared.has(f.checkId)).length,
    },
  };
}

/**
 * The run a "since" question is asked against: the latest run that read some renewal check and is not
 * later than the point asked about (before the latest run; before a date; at or before a run id).
 * Undefined when no earlier run read any.
 */
export function siteReference(runs: readonly RunRecord[], since: Since): RunRecord | undefined {
  const ordered = inOrder(runs);
  if (ordered.length === 0) return undefined;
  const earlier = ordered.slice(0, -1).filter((r) => (r.renewalChecks ?? []).length > 0);
  if (since.kind === "previous") return earlier.at(-1);
  if (since.kind === "date") return earlier.filter((r) => r.takenAt < since.at).at(-1);
  const named = ordered.find((r) => r.id === since.id);
  return named ? earlier.filter((r) => r.takenAt <= named.takenAt).at(-1) : undefined;
}
