import { A11Y_CHECKS } from "../checks/a11y-rendered.js";
import type { CheckRegistry } from "../model.js";

/**
 * The rendered accessibility checks, added to whichever registry the run uses, for a run with `--renderer`. They
 * are not in createPageRegistry(): they read what a browser computed, so without one there is nothing for them to
 * look at and the default run and its output do not change. A check already there is left alone.
 */
export function addRenderedA11yChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of A11Y_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}
