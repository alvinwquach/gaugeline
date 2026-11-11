import { createPageRegistry } from "../checks/index.js";
import { RENEWALS_CHECKS } from "../checks/renewals.js";
import type { CheckRegistry } from "../model.js";

/**
 * Every page check and the renewals checks, for a run with --renewals or `gaugeline renewals`. The
 * renewals checks are not in createPageRegistry(), so the default run and its output do not change.
 */
export function createRenewalsRegistry(): CheckRegistry {
  const registry = createPageRegistry();
  for (const check of RENEWALS_CHECKS) registry.register(check);
  return registry;
}
