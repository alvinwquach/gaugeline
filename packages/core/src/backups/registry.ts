import { BACKUPS_CHECKS } from "../checks/backups.js";
import { createPageRegistry } from "../checks/index.js";
import type { CheckRegistry } from "../model.js";

/**
 * The backups checks, added to whichever registry the run uses, for a run with --backups. They are not
 * in createPageRegistry(), so the default run and its output do not change. A check already there is left alone.
 */
export function addBackupsChecks(registry: CheckRegistry): CheckRegistry {
  for (const check of BACKUPS_CHECKS) if (!registry.has(check.id)) registry.register(check);
  return registry;
}

/** Every page check and the backups checks, for `gaugeline backups`. */
export function createBackupsRegistry(): CheckRegistry {
  return addBackupsChecks(createPageRegistry());
}
