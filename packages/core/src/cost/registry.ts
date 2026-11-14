import { COST_CHECKS } from "../checks/cost.js";
import { createPageRegistry } from "../checks/index.js";
import type { CheckRegistry } from "../model.js";

/**
 * Every page check and the cost checks, for a run with --cost or `gaugeline cost`. The cost checks are
 * not in createPageRegistry(), so the default run and its output do not change.
 */
export function createCostRegistry(): CheckRegistry {
  const registry = createPageRegistry();
  for (const check of COST_CHECKS) registry.register(check);
  return registry;
}
