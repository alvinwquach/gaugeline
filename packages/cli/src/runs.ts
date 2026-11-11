import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HISTORY_SCHEMA, inOrder, pruneRuns, type RunRecord } from "@gaugeline/core";

/**
 * The local runs store: one JSON file per run, in a folder per host. Storage is the CLI's concern;
 * core only sees the records. A file that is not valid, or has another schema, is skipped (never
 * deleted), so a newer Gaugeline's history is left alone.
 */
export const RUNS_DIR = join(".gaugeline", "runs");
const PRUNED_FILE = "pruned-before.txt";

export const hostDir = (cwd: string, host: string): string =>
  join(cwd, RUNS_DIR, host.toLowerCase().replace(/[^a-z0-9.-]/g, "_"));

export function readRuns(cwd: string, host: string): { runs: RunRecord[]; prunedBefore?: string } {
  const dir = hostDir(cwd, host);
  if (!existsSync(dir)) return { runs: [] };
  const runs: RunRecord[] = [];
  for (const name of readdirSync(dir))
    if (name.endsWith(".json"))
      try {
        const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as RunRecord;
        if (
          r?.schema === HISTORY_SCHEMA &&
          typeof r.id === "string" &&
          typeof r.takenAt === "string"
        )
          runs.push(r);
      } catch {
        /* not a run file: skipped */
      }
  const marker = join(dir, PRUNED_FILE);
  const prunedBefore = existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
  return { runs: inOrder(runs), ...(prunedBefore ? { prunedBefore } : {}) };
}

/** Write a run (temp file, then rename), then drop the runs older than the retention and note the date. */
export function saveRun(
  cwd: string,
  host: string,
  run: RunRecord,
  now: Date,
  retentionDays: number,
): void {
  const dir = hostDir(cwd, host);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run.id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(tmp, path);
  const { dropped, cutoff } = pruneRuns(readRuns(cwd, host).runs, now, retentionDays);
  for (const r of dropped) rmSync(join(dir, `${r.id}.json`), { force: true });
  if (dropped.length > 0) writeFileSync(join(dir, PRUNED_FILE), `${cutoff}\n`);
}
