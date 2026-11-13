import { findingKey, inOrder, type Since } from "./history.js";
import { diffRecords } from "./record.js";
import { day } from "./report.js";
import type { FieldChange, RecordedFinding, RunRecord } from "./types.js";

/** One of the two saved runs a before-and-after report is taken between. */
export interface RunRef {
  id: string;
  takenAt: string;
}

/**
 * The findings of two saved runs side by side. Only pages both runs read are compared: a finding on a
 * page one run never read is counted in `notCompared`, because "fixed" and "new" would be guesses.
 */
export interface BeforeAfter {
  site: string;
  before: RunRef;
  after: RunRef;
  /** Paths both runs read, sorted. */
  compared: string[];
  /** On a compared page in the before run and not in the after run. */
  fixed: RecordedFinding[];
  /** On a compared page in the after run and not in the before run. */
  added: RecordedFinding[];
  /** In both runs. */
  unchanged: RecordedFinding[];
  /** Findings on pages only one of the two runs read. */
  notCompared: { before: number; after: number };
  /** What differs on each compared page, only for pages that changed. */
  pages: { path: string; changes: FieldChange[] }[];
}

export type BeforeAfterResult = { ok: true; report: BeforeAfter } | { ok: false; note: string };

const ref = (r: RunRecord): RunRef => ({ id: r.id, takenAt: r.takenAt });

/**
 * The latest run (after) against an earlier one (before): by default the run just before it, or the
 * run a run id names, or the latest run taken at or before a date. Pure over the runs it is given, so
 * the same runs always give the same report. A question the stored runs cannot answer is a note that
 * says why, never a guess.
 */
export function compareRuns(
  site: string,
  runs: readonly RunRecord[],
  since: Since = { kind: "previous" },
): BeforeAfterResult {
  const ordered = inOrder(runs);
  const after = ordered.at(-1);
  if (!after || ordered.length < 2)
    return {
      ok: false,
      note: `Only one run is stored for ${site}: run Gaugeline with --since last again after a change to have something to compare.`,
    };
  const earlier = ordered.slice(0, -1);
  let picked: RunRecord | undefined;
  if (since.kind === "previous") picked = earlier.at(-1);
  else if (since.kind === "run") {
    if (since.id === after.id)
      return {
        ok: false,
        note: `${after.id} is the latest run: name an earlier run or date to compare it with.`,
      };
    picked = earlier.find((r) => r.id === since.id);
    if (!picked)
      return {
        ok: false,
        note: `No stored run has the id ${since.id}. The runs stored for ${site} start at ${ordered[0]?.id ?? ""}.`,
      };
  } else {
    picked = [...earlier].reverse().find((r) => r.takenAt <= since.at);
    if (!picked)
      return {
        ok: false,
        note: `No run was taken on or before ${day(since.at)}. The runs stored for ${site} start on ${day(ordered[0]?.takenAt ?? since.at)}.`,
      };
  }
  if (!picked) return { ok: false, note: `No earlier run is stored for ${site}.` };
  const before: RunRecord = picked;
  const bothRead = (path: string) =>
    Object.hasOwn(before.pages, path) && Object.hasOwn(after.pages, path);
  const compared = Object.keys(after.pages)
    .filter(bothRead)
    .sort((a, b) => a.localeCompare(b));
  const dedupe = (list: readonly RecordedFinding[]) => {
    const seen = new Set<string>();
    return list.filter((x) => {
      const k = findingKey(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const beforeOn = dedupe(before.findings.filter((x) => bothRead(x.path)));
  const afterOn = dedupe(after.findings.filter((x) => bothRead(x.path)));
  const afterKeys = new Set(afterOn.map(findingKey));
  const beforeKeys = new Set(beforeOn.map(findingKey));
  const pages = compared.flatMap((path) => {
    const changes = diffRecords(before.pages[path]!, after.pages[path]!);
    return changes.length > 0 ? [{ path, changes }] : [];
  });
  return {
    ok: true,
    report: {
      site,
      before: ref(before),
      after: ref(after),
      compared,
      fixed: beforeOn.filter((x) => !afterKeys.has(findingKey(x))),
      added: afterOn.filter((x) => !beforeKeys.has(findingKey(x))),
      unchanged: afterOn.filter((x) => beforeKeys.has(findingKey(x))),
      notCompared: {
        before: dedupe(before.findings.filter((x) => !bothRead(x.path))).length,
        after: dedupe(after.findings.filter((x) => !bothRead(x.path))).length,
      },
      pages,
    },
  };
}

function section(title: string, rows: readonly RecordedFinding[]): string[] {
  if (rows.length === 0) return [`${title} (0)`, "  none", ""];
  const check = Math.max(...rows.map((r) => r.checkId.length));
  const path = Math.max(...rows.map((r) => r.path.length));
  return [
    `${title} (${rows.length})`,
    ...rows.map((r) => `  ${r.checkId.padEnd(check)}  ${r.path.padEnd(path)}  ${r.title}`),
    "",
  ];
}

/** The report as plain text: the two runs, then what was fixed, what is new and what is still there. */
export function formatBeforeAfter(result: BeforeAfterResult): string {
  if (!result.ok) return `${result.note}\n`;
  const r = result.report;
  const lines = [
    `Before: ${r.before.id} (${day(r.before.takenAt)})   After: ${r.after.id} (${day(r.after.takenAt)})`,
    `${r.compared.length} ${r.compared.length === 1 ? "page" : "pages"} read by both runs. Findings there: ${r.fixed.length + r.unchanged.length} before, ${r.added.length + r.unchanged.length} after.`,
    "",
    ...section("Fixed", r.fixed),
    ...section("New", r.added),
    ...section("Still there", r.unchanged),
  ];
  if (r.pages.length > 0)
    lines.push(
      "What changed on the pages:",
      ...r.pages.map((p) => `  ${p.path}: ${p.changes.map((c) => c.detail).join("; ")}`),
      "",
    );
  const { before, after } = r.notCompared;
  if (before + after > 0)
    lines.push(
      `Not compared: ${before} ${before === 1 ? "finding" : "findings"} before and ${after} after are on pages only one of the two runs read.`,
      "",
    );
  return lines.join("\n");
}
