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

/** The reason to stop now, or null to go on. */
export async function stopReason(s: Switches): Promise<string | null> {
  const v = s.env[KILL_SWITCH_ENV];
  if (v !== undefined && v !== "" && v !== "0") return "kill switch";
  if (await s.orgPaused()) return "organisation paused";
  return null;
}
