import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_SNAPSHOT_SCHEMA, type RunSnapshot } from "@gaugeline/core";

/**
 * The last run of each site, for --since last: one JSON file per host. Storage is the CLI's
 * concern, not core's, so the same diff can run elsewhere with a different store.
 */
export const STATE_DIR = join(".gaugeline", "last-run");

/** The file for a host ("shop.example:8080" -> shop.example_8080.json). */
export function statePath(cwd: string, host: string): string {
  return join(cwd, STATE_DIR, `${host.toLowerCase().replace(/[^a-z0-9.-]/g, "_")}.json`);
}

export type LastRun =
  | { kind: "none" }
  | { kind: "ok"; snapshot: RunSnapshot }
  | { kind: "corrupt" }
  | { kind: "newer"; schema: unknown; writtenBy?: string };

export function readLastRun(cwd: string, host: string): LastRun {
  const path = statePath(cwd, host);
  if (!existsSync(path)) return { kind: "none" };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (data === null || typeof data !== "object") return { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
  if (data.schema !== RUN_SNAPSHOT_SCHEMA)
    return {
      kind: "newer",
      schema: data.schema,
      ...(typeof data.writtenBy === "string" ? { writtenBy: data.writtenBy } : {}),
    };
  const prices = data.prices;
  const forms = data.forms;
  if (typeof prices !== "object" || prices === null || typeof forms !== "object" || forms === null)
    return { kind: "corrupt" };
  return { kind: "ok", snapshot: data as unknown as RunSnapshot };
}

/**
 * Write to a temporary file beside the real one, then rename it into place: rename within one
 * directory replaces the file in one step, so a run killed mid-write leaves the previous file whole.
 */
export function writeLastRun(
  cwd: string,
  host: string,
  snapshot: RunSnapshot,
  writtenBy: string,
): string {
  const path = statePath(cwd, host);
  mkdirSync(join(cwd, STATE_DIR), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...snapshot, writtenBy }, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}
