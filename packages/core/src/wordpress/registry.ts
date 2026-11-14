import { WORDPRESS_CHECKS } from "../checks/wordpress.js";
import type { CheckRegistry } from "../model.js";

/**
 * The WordPress checks, added to whichever registry the run uses, for a run with --wordpress. They are not in
 * createPageRegistry(), so the default run and its output do not change. A check already there is left alone.
 */
export function addWordPressChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of WORDPRESS_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}
