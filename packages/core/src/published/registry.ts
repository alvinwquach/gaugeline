import { PUBLISHED_CHECKS } from "../checks/published-not-live.js";
import type { CheckRegistry } from "../model.js";

/**
 * The published-not-live checks, added to whichever registry the run uses, for a run with --published. They are
 * not in createPageRegistry(), so the default run and its output do not change. A check already there is left alone.
 */
export function addPublishedChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of PUBLISHED_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}
