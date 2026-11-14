import { PAGESPEED_CHECKS } from "../checks/pagespeed.js";
import type { CheckRegistry } from "../model.js";

/**
 * The two PageSpeed checks, added to whichever registry the run uses, for a run with --pagespeed. They are not in
 * createPageRegistry(), so the default run and its output do not change. A check already there is left alone.
 */
export function addPageSpeedChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of PAGESPEED_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}
