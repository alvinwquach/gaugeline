import { ATTRIBUTION_CHECKS } from "../checks/perf-attribution.js";
import type { CheckRegistry } from "../model.js";

/**
 * The attribution check, added to whichever registry the run uses, for a run with --attribution. It is not in
 * createPageRegistry(), so the default run and its output do not change. A check already there is left alone.
 */
export function addAttributionChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of ATTRIBUTION_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}
