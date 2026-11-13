/**
 * The regression watcher's comparison (AG-13): two runs of the same site, set side by side by finding id and
 * severity. Only "got worse" counts: a finding that was not there before, or one whose severity went up
 * (Worth knowing, then Fix soon, then Fix this first). A finding that was fixed, or came down in severity, is
 * counted for context and never raises an alert. Comparing is plain code: the same two runs always give the
 * same report. No model, no network, no write, and no clock: the runs carry their own times.
 *
 * What a finding may add: its id, its severity and its title. The title may quote the page, so it is data:
 * cleaned, cut and labelled by core's sanitise, and escaped for Markdown when shown. Evidence, addresses and
 * everything else a finding carries are never read.
 */
import * as z from "zod";
import { SEVERITIES, SEVERITY_ORDER, type Severity } from "../../model.js";
import type { Result } from "../../result.js";
import { sanitise, UNTRUSTED_CAPS } from "../../untrusted.js";

/** Most findings one run may hold. Over it the input is refused (a site's run holds far fewer). */
export const MAX_REGRESSION_FINDINGS = 2000;
/** Most findings listed in each of the three lists; the rest are counted. */
export const MAX_REGRESSION_LISTED = 20;
/** The longest finding id kept: a check id and an address fit. A longer one is skipped and counted. */
export const MAX_REGRESSION_ID = 300;
const MAX_RUN_ID = 64;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const count = z.number().int().min(0);
const severity = z.enum(SEVERITIES);
const listed = z
  .object({
    id: z.string().min(1).max(MAX_REGRESSION_ID),
    severity,
    title: z.string().max(200),
  })
  .strict();
const worsenedItem = z
  .object({
    id: z.string().min(1).max(MAX_REGRESSION_ID),
    severity,
    from: severity,
    title: z.string().max(200),
  })
  .strict();
const runInfo = z
  .object({ runId: z.string().max(MAX_RUN_ID), takenAt: z.string().max(40), findings: count })
  .strict();

/** The report's shape. The eval harness parses a model's answer with the same schema. */
export const regressionReportSchema = z
  .object({
    status: z.enum(["compared", "no-baseline", "not-compared"]),
    /** Why nothing was compared, in fixed words; null when the runs were compared. */
    note: z.string().max(200).nullable(),
    previous: runInfo.nullable(),
    current: runInfo,
    headline: z.string().max(200),
    /** True only when something got worse. The one thing a message hangs on. */
    worse: z.boolean(),
    counts: z
      .object({
        added: count,
        worsened: count,
        improved: count,
        resolved: count,
        unchanged: count,
        skipped: z.object({ previous: count, current: count }).strict(),
      })
      .strict(),
    added: z.array(listed).max(MAX_REGRESSION_LISTED),
    worsened: z.array(worsenedItem).max(MAX_REGRESSION_LISTED),
    resolved: z.array(listed).max(MAX_REGRESSION_LISTED),
    omitted: z.object({ added: count, worsened: count, resolved: count }).strict(),
  })
  .strict();
export type RegressionReport = z.infer<typeof regressionReportSchema>;
export type RegressionListed = z.infer<typeof listed>;
export type RegressionWorsened = z.infer<typeof worsenedItem>;

/** A finding as the comparison reads it. Nothing else a finding carries is used. */
export interface RegressionFinding {
  id: string;
  severity: Severity;
  title: string;
}

/** The input is not a run, or is too long to read. Its message is fixed words. */
export class RegressionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegressionInputError";
  }
}

const runSchema = z.object({
  runId: z.string().min(1).max(MAX_RUN_ID),
  takenAt: z.string().regex(ISO),
  complete: z.boolean().optional(),
  findings: z.array(z.unknown()),
});
const rowSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(MAX_REGRESSION_ID)
    // A key is shown nowhere, but a control character has no place in one.
    .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)),
  severity,
  title: z.string().catch(""),
});

interface Snapshot {
  runId: string;
  takenAt: string;
  complete: boolean;
  /** A Map keyed by finding id: the other run's row is found without a search, and a repeat is one entry. */
  byId: Map<string, { severity: Severity; title: string }>;
  skipped: number;
}

function snapshot(raw: unknown, who: "current" | "previous"): Snapshot | null {
  const run = runSchema.safeParse(raw);
  if (!run.success) {
    if (who === "current") throw new RegressionInputError("The current run is not a run.");
    return null;
  }
  if (run.data.findings.length > MAX_REGRESSION_FINDINGS)
    throw new RegressionInputError(`More than ${MAX_REGRESSION_FINDINGS} findings in a run.`);
  if (Number.isNaN(Date.parse(run.data.takenAt))) {
    if (who === "current") throw new RegressionInputError("The current run is not a run.");
    return null;
  }
  const byId: Snapshot["byId"] = new Map();
  let skipped = 0;
  for (const r of run.data.findings) {
    const p = rowSchema.safeParse(r);
    if (!p.success) {
      skipped += 1;
      continue;
    }
    const { id, severity: s, title } = p.data;
    const seen = byId.get(id);
    // A repeated id is one finding at its worst severity (ties: the smaller title, so row order never shows).
    if (
      !seen ||
      SEVERITY_ORDER[s] < SEVERITY_ORDER[seen.severity] ||
      (s === seen.severity && title < seen.title)
    )
      byId.set(id, { severity: s, title });
  }
  return {
    runId: run.data.runId,
    takenAt: run.data.takenAt,
    complete: run.data.complete !== false,
    byId,
    skipped,
  };
}

const info = (s: Snapshot) => ({ runId: s.runId, takenAt: s.takenAt, findings: s.byId.size });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const title = (t: string) => sanitise(t, UNTRUSTED_CAPS.title).text;

/** Worst first, then by id: a total order, so the input's order never shows. */
const byWorst = (
  a: { severity: Severity; id: string },
  b: { severity: Severity; id: string },
): number => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.id < b.id ? -1 : 1);

function headline(added: number, worsened: number): string {
  const parts = [
    added > 0 ? plural(added, "new finding", "new findings") : "",
    worsened > 0 ? plural(worsened, "finding went", "findings went") + " up in severity" : "",
  ].filter((p) => p !== "");
  // One kind alone reads "1 new finding got worse"; two kinds read "1 new finding and 1 finding went up".
  if (parts.length === 1 && added > 0)
    return `${plural(added, "new finding", "new findings")} got worse since the last run.`;
  return `${parts.join(" and ")} since the last run.`;
}

/** A report that compared nothing: it says why, counts nothing and never says "worse". */
function blank(
  cur: Snapshot,
  prev: Snapshot | null,
  status: "no-baseline" | "not-compared",
  note: string | null,
  headline: string,
): RegressionReport {
  return {
    status,
    note,
    previous: prev ? info(prev) : null,
    current: info(cur),
    headline,
    worse: false,
    counts: {
      added: 0,
      worsened: 0,
      improved: 0,
      resolved: 0,
      unchanged: 0,
      skipped: { previous: prev?.skipped ?? 0, current: cur.skipped },
    },
    added: [],
    worsened: [],
    resolved: [],
    omitted: { added: 0, worsened: 0, resolved: 0 },
  };
}

/**
 * The latest run against the one before it. `previous` is null (or undefined) on a site's first run. A run is
 * `{ runId, takenAt, findings, complete? }`; `findings` are rows with an id, a severity and a title, and a row
 * that is not one is skipped and counted. Two runs that cannot be compared (the earlier one is unreadable,
 * the same run, out of order, or either did not read the whole site) give a report that says why and never
 * says "worse": a half-read run would make every finding look new or fixed. A current run that is not a run,
 * or either list over MAX_REGRESSION_FINDINGS, is refused.
 */
export function buildRegressionReport(previous: unknown, current: unknown): RegressionReport {
  const cur = snapshot(current, "current")!;
  if (previous === null || previous === undefined) {
    const note = "This is the first run: there is nothing to compare it with.";
    return blank(cur, null, "no-baseline", null, note);
  }
  const prev = snapshot(previous, "previous");
  const refuse = (note: string): RegressionReport =>
    blank(cur, prev, "not-compared", note, `${note.replace(/\.$/, "")}, so nothing was compared.`);
  if (!prev) return refuse("The previous run could not be read.");
  if (!prev.complete || !cur.complete)
    return refuse("A run that could not read the whole site is not compared.");
  if (prev.runId === cur.runId) return refuse("The two runs are the same run.");
  if (!(Date.parse(prev.takenAt) < Date.parse(cur.takenAt)))
    return refuse("The earlier run is not earlier than the later one.");

  const added: RegressionListed[] = [];
  const worsened: RegressionWorsened[] = [];
  let improved = 0;
  let unchanged = 0;
  for (const [id, now] of cur.byId) {
    const before = prev.byId.get(id);
    if (!before) added.push({ id, severity: now.severity, title: title(now.title) });
    else if (SEVERITY_ORDER[now.severity] < SEVERITY_ORDER[before.severity])
      worsened.push({ id, severity: now.severity, from: before.severity, title: title(now.title) });
    else if (SEVERITY_ORDER[now.severity] > SEVERITY_ORDER[before.severity]) improved += 1;
    else unchanged += 1;
  }
  const resolved: RegressionListed[] = [];
  for (const [id, was] of prev.byId)
    if (!cur.byId.has(id)) resolved.push({ id, severity: was.severity, title: title(was.title) });
  added.sort(byWorst);
  worsened.sort(byWorst);
  resolved.sort(byWorst);

  const worse = added.length + worsened.length > 0;
  return {
    status: "compared",
    note: null,
    previous: info(prev),
    current: info(cur),
    headline: worse
      ? headline(added.length, worsened.length)
      : "Nothing got worse since the last run.",
    worse,
    counts: {
      added: added.length,
      worsened: worsened.length,
      improved,
      resolved: resolved.length,
      unchanged,
      skipped: { previous: prev.skipped, current: cur.skipped },
    },
    added: added.slice(0, MAX_REGRESSION_LISTED),
    worsened: worsened.slice(0, MAX_REGRESSION_LISTED),
    resolved: resolved.slice(0, MAX_REGRESSION_LISTED),
    omitted: {
      added: Math.max(0, added.length - MAX_REGRESSION_LISTED),
      worsened: Math.max(0, worsened.length - MAX_REGRESSION_LISTED),
      resolved: Math.max(0, resolved.length - MAX_REGRESSION_LISTED),
    },
  };
}

/**
 * A Gaugeline result as the rows the comparison reads: the id is the check and the address, so the same
 * problem on the same page matches from one run to the next. Evidence and the source line are left behind.
 */
export function regressionFindingsFromResult(result: Result): RegressionFinding[] {
  return result.findings.map((f) => ({
    id: `${f.checkId} ${f.url}`,
    severity: f.severity,
    title: f.title,
  }));
}
