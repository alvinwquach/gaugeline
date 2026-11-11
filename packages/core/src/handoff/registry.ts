import { createPageRegistry } from "../checks/index.js";
import { HANDOFF_CHECKS } from "../checks/handoff.js";
import type { CheckRegistry } from "../model.js";

/**
 * Every page check and the handoff checks, for `gaugeline handoff`. The handoff checks are not in
 * createPageRegistry(), so no other run changes: they need a handoff reader, which only the command builds.
 */
export function createHandoffRegistry(): CheckRegistry {
  const registry = createPageRegistry();
  for (const check of HANDOFF_CHECKS) registry.register(check);
  return registry;
}
