import { RESULT_SCHEMA_VERSION, resultSchema, type Result, type RunResult } from "@gaugeline/core";
import type { Counts, Run, Store } from "./store.js";

/** Where the example results are inside the built client folder (scripts/embed-client.mjs puts them there). */
export const DEMO_PATH = "demo/results.json";

/** The version of the demo file's own layout. A different number means the file must be made again. */
export const DEMO_FILE_VERSION = 1;

/** Said by the API when a check is asked for in demo mode, and shown by the app under "Example results". */
export const DEMO_SENTENCE =
  "This is the demo. Run npx gaugeline open yoursite.com to check a real page.";

const REBUILD =
  "Run pnpm demo:build to make them again, and commit packages/app-server/demo/results.json.";

/** The example results are missing, damaged or made for another version. `gaugeline open --demo` exits 2 with this. */
export class DemoError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DemoError";
  }
}

/** One example run: what the API serves for a run, without an id (the store makes one). */
export interface DemoRun {
  startedAt: string;
  result: Result;
  checked: NonNullable<Run["checked"]>;
  /**
   * The checks the report lists as "failed to run". The result's own `failed` also holds the mail
   * record checks the app lists as not run (no DNS), which the report never calls failures.
   */
  reportFailed: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read and check the example results. Every run's result must be a valid result of the schema this
 * version writes (parseResult's schema), so a file made for an older schema is a clear error and
 * not a half-drawn app. Nothing here touches the network; the text is data.
 */
export function parseDemo(text: string): DemoRun[] {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new DemoError(`The example results are not valid JSON. ${REBUILD}`);
  }
  if (!isObject(file) || file.demo !== DEMO_FILE_VERSION)
    throw new DemoError(
      `The example results were made for another layout (demo ${String(isObject(file) ? file.demo : undefined)}, this version reads ${DEMO_FILE_VERSION}). ${REBUILD}`,
    );
  if (file.resultSchema !== RESULT_SCHEMA_VERSION)
    throw new DemoError(
      `The example results are out of date: they use result schema ${String(file.resultSchema)} and this version writes ${RESULT_SCHEMA_VERSION}. ${REBUILD}`,
    );
  if (!Array.isArray(file.runs) || file.runs.length === 0)
    throw new DemoError(`The example results hold no runs. ${REBUILD}`);
  return file.runs.map((run: unknown, i): DemoRun => {
    if (!isObject(run) || typeof run.startedAt !== "string" || !isObject(run.checked))
      throw new DemoError(`Example run ${i + 1} is not the expected shape. ${REBUILD}`);
    const parsed = resultSchema.safeParse(run.result);
    if (!parsed.success)
      throw new DemoError(
        `Example run ${i + 1} is not a valid result (${parsed.error.issues[0]?.message ?? "unknown"}). ${REBUILD}`,
      );
    if (!isObject(run.checked.page))
      throw new DemoError(`Example run ${i + 1} has no page data. ${REBUILD}`);
    const reportFailed = run.reportFailed ?? [];
    if (!Array.isArray(reportFailed) || !reportFailed.every((x) => typeof x === "string"))
      throw new DemoError(`Example run ${i + 1} has a reportFailed that is not a list. ${REBUILD}`);
    return {
      startedAt: run.startedAt,
      result: parsed.data,
      checked: run.checked as DemoRun["checked"],
      reportFailed: reportFailed as string[],
    };
  });
}

/**
 * The report is made from the same result as for a real run. The result stores the failed checks by
 * id only, so each is given an empty error: the report shows the id and its own fixed sentence.
 */
function reportResult(result: Result, failed: readonly string[]): RunResult {
  return {
    findings: result.findings,
    passed: result.passed,
    failed: failed.map((id) => ({ id, error: "" })),
    warnings: [],
    couldNotCheck: result.couldNotCheck,
    sampled: result.sampled as RunResult["sampled"],
  };
}

/** Put the example runs into a store, oldest first, all finished. No check is run and nothing is requested. */
export function fillDemo(store: Store, runs: readonly DemoRun[]): void {
  for (const d of runs) {
    const r = store.add(d.result.url, new Date(d.startedAt));
    const counts: Counts = { high: 0, medium: 0, low: 0 };
    for (const f of d.result.findings) counts[f.severity]++;
    r.result = d.result;
    r.checked = d.checked;
    r.report = { result: reportResult(d.result, d.reportFailed), url: d.checked.page.url };
    r.counts = counts;
    r.state = "done";
    store.emit(r, { event: "done", data: { counts } });
  }
}
