import {
  CUTOVER_ONLY_CHECKS,
  PLAN_CHECKS,
  PRESENCE_CHECKS,
  PRICE_CHECKS,
  PRINTED_CHECKS,
  SUBSCRIPTION_CHECKS,
  createPageRegistry,
} from "../../packages/core/src/index.js";

/** Every check the docs list: page checks, plan checks, printed-link checks, price and subscription checks and the cutover-only ones. */
export function CATALOGUE_IDS(): string[] {
  const registry = createPageRegistry();
  for (const c of PLAN_CHECKS) registry.register(c);
  for (const c of PRINTED_CHECKS) registry.register(c);
  for (const c of PRESENCE_CHECKS) registry.register(c);
  for (const c of PRICE_CHECKS) registry.register(c);
  for (const c of SUBSCRIPTION_CHECKS) registry.register(c);
  for (const c of CUTOVER_ONLY_CHECKS) registry.register(c);
  return registry.all().map((c) => c.id);
}
