import {
  CUTOVER_ONLY_CHECKS,
  PLAN_CHECKS,
  PRINTED_CHECKS,
  createPageRegistry,
} from "../../packages/core/src/index.js";

/** Every check the docs list: page checks, plan checks, printed-link checks and the cutover-only ones. */
export function CATALOGUE_IDS(): string[] {
  const registry = createPageRegistry();
  for (const c of PLAN_CHECKS) registry.register(c);
  for (const c of PRINTED_CHECKS) registry.register(c);
  for (const c of CUTOVER_ONLY_CHECKS) registry.register(c);
  return registry.all().map((c) => c.id);
}
