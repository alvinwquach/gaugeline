import type { RecordedFinding, RunRecord } from "./types.js";

const DAY_MS = 86_400_000;

export const findingKey = (f: Pick<RecordedFinding, "checkId" | "path">): string =>
  `${f.checkId} ${f.path}`;

/** The run id for a start time: sortable, safe in a file name ("r-20261103T180500Z"). */
export const runId = (at: Date): string => `r-${at.toISOString().replace(/[-:]|\.\d{3}/g, "")}`;

/** Oldest first. A stable copy, so the caller's list is untouched. */
export const inOrder = (runs: readonly RunRecord[]): RunRecord[] =>
  [...runs].sort((a, b) => a.takenAt.localeCompare(b.takenAt) || a.id.localeCompare(b.id));

/** Runs older than the retention are dropped; `cutoff` says from when history is kept. */
export function pruneRuns(
  runs: readonly RunRecord[],
  now: Date,
  retentionDays: number,
): { kept: RunRecord[]; dropped: RunRecord[]; cutoff: string } {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const kept: RunRecord[] = [];
  const dropped: RunRecord[] = [];
  for (const r of inOrder(runs)) (r.takenAt >= cutoff ? kept : dropped).push(r);
  return { kept, dropped, cutoff };
}

/** A finding that is new since a point in history, with the two runs its page diff is taken between. */
export interface Appearance {
  finding: RecordedFinding;
  /** The first run of the unbroken stretch of runs that all have the finding. */
  first: RunRecord;
  /** The run of the same page just before it; undefined when there is none (first run of the page, or pruned). */
  before: RunRecord | undefined;
}

export type Since =
  { kind: "previous" } | { kind: "date"; at: string } | { kind: "run"; id: string };

/** "2026-11-01" or a full time -> date; "r-..." -> a run id; anything else is undefined. */
export function parseSince(text: string): Since | undefined {
  if (/^r-\d{8}T\d{6}Z$/.test(text)) return { kind: "run", id: text };
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return { kind: "date", at: new Date(ms).toISOString() };
  }
  return undefined;
}

/**
 * The findings of the latest run that appeared after `since` (by default: that were not in the run
 * before it). For each, walk back through the runs that read the same page while the finding was
 * there: the first of them is where it appeared. Pure over the runs it is given.
 */
export function newFindings(
  runs: readonly RunRecord[],
  since: Since = { kind: "previous" },
): Appearance[] {
  const ordered = inOrder(runs);
  const latest = ordered.at(-1);
  if (!latest) return [];
  const sinceRun = since.kind === "run" ? ordered.find((r) => r.id === since.id) : undefined;
  const out: Appearance[] = [];
  const seen = new Set<string>();
  for (const finding of latest.findings) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    // Runs that read this page, oldest first.
    const read = ordered.filter((r) => Object.hasOwn(r.pages, finding.path));
    let i = read.length - 1;
    while (i > 0 && read[i - 1]!.findings.some((f) => findingKey(f) === key)) i--;
    const first = read[i] ?? latest;
    const before = read[i - 1];
    const isNew =
      since.kind === "previous"
        ? first.id === latest.id
        : since.kind === "date"
          ? first.takenAt >= since.at
          : sinceRun !== undefined && first.takenAt > sinceRun.takenAt;
    if (isNew) out.push({ finding, first, before });
  }
  return out;
}
