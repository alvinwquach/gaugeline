import { TRACKER_CHECKS } from "../checks/trackers.js";
import type { CheckRegistry } from "../model.js";

/**
 * The tracker checks, added to whichever registry the run uses, for a run with --trackers. They are not in
 * createPageRegistry(), so the default run and its output do not change. A check already there is left alone.
 */
export function addTrackerChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of TRACKER_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}
