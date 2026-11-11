import { LIBRARY_CHECKS } from "../checks/libraries.js";
import type { CheckRegistry } from "../model.js";

/**
 * The library check, added to whichever registry the run uses, for a run with --libraries. It is not in
 * createPageRegistry(), so the default run and its output do not change. A check already there is left alone.
 */
export function addLibraryChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of LIBRARY_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}
