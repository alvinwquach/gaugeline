import { CheckRegistry, type Check } from "../model.js";
import { adDeadPage, type AdPagesInput } from "./ad-dead-page.js";
import { adSoldOut } from "./ad-sold-out.js";
import { CAMPAIGN_CHECKS } from "./campaign-fields-lost.js";

/** The checks of the ads command that read the landing pages it asked for (not the page checks). */
export const AD_LANDING_CHECKS: readonly Check<AdPagesInput>[] = [adDeadPage, adSoldOut];

/** Every check the ads command runs itself: the campaign tags, then the page and its stock. */
export function createAdsRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of CAMPAIGN_CHECKS) registry.register(c);
  for (const c of AD_LANDING_CHECKS) registry.register(c);
  return registry;
}
