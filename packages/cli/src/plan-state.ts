import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError, PLAN_STATE_SCHEMA, readPlanState, type PlanState } from "@gaugeline/core";

/** --progress without a file name: a state file beside the plan. */
export function defaultPlanStatePath(planPath: string): string {
  return join(dirname(planPath), ".gaugeline", "plan-state.json");
}

export type PlanStateFile =
  | { kind: "none" }
  | { kind: "ok"; state: PlanState }
  /** Unreadable: moved aside to `backup`, and this run is a first run. */
  | { kind: "corrupt"; backup: string };

/**
 * The last run's state. A file from a later schema is refused (exit 2) and left alone: this
 * version can't read it, and writing over it would lose a newer version's history.
 */
export function readPlanStateFile(path: string): PlanStateFile {
  if (!existsSync(path)) return { kind: "none" };
  const read = readPlanState(readFileSync(path, "utf8"));
  if (read.kind === "ok") return read;
  if (read.kind === "newer")
    throw new ConfigError(
      `${path} was written by a later version of Gaugeline (schema ${String(read.schema)}); this version reads schema ${PLAN_STATE_SCHEMA}. It was left as it is.`,
      { hint: "Update Gaugeline, or give --progress another file." },
    );
  const backup = `${path}.bak`;
  renameSync(path, backup);
  return { kind: "corrupt", backup };
}

/** Write beside the real file, then rename it into place: a killed run leaves the old file whole. */
export function writePlanStateFile(path: string, state: PlanState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}
