/**
 * Kill switches (ADR-0010 part 5). Any one stops every write, and they are checked before each request,
 * not once at start: the worker's environment variable, and the organisation's "pause applying".
 */
export const KILL_SWITCH_ENV = "GAUGELINE_WRITER_STOP";

export interface Switches {
  /** The environment read before each request (the worker's process.env by default). */
  env: Readonly<Record<string, string | undefined>>;
  /** True while the organisation has paused applying in the hosted app. */
  orgPaused: () => Promise<boolean>;
}

/**
 * The reason to stop now, or null to go on. It fails closed: if the pause cannot be read (the database
 * is down), the answer is "organisation paused", never "go on".
 */
export async function stopReason(s: Switches): Promise<string | null> {
  const v = s.env[KILL_SWITCH_ENV];
  if (v !== undefined && v !== "" && v !== "0") return "kill switch";
  let paused: boolean;
  try {
    paused = (await s.orgPaused()) !== false;
  } catch {
    paused = true;
  }
  return paused ? "organisation paused" : null;
}

/** What a worker's configuration says about a kind: only the exact word "write" turns writing on. */
export type Mode = "dry-run" | "write";

/** The mode when the configuration says nothing. */
export const DEFAULT_MODE: Mode = "dry-run";

/** Any value but the exact string "write" (also "Write", "true", "", undefined) is a dry run. */
export function resolveMode(configured: unknown): Mode {
  return configured === "write" ? "write" : DEFAULT_MODE;
}
