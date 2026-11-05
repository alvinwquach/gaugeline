import { CheckRegistry } from "../model.js";
import { canonicalElsewhere } from "./canonical-elsewhere.js";
import { canonicalMissing } from "./canonical-missing.js";
import { hostDuplicate } from "./host-duplicate.js";
import { noindex } from "./noindex.js";
import { redirectChain } from "./redirect-chain.js";
import { thinHtml } from "./thin-html.js";

/** Page checks in registration order: the order findings appear in within a severity. */
export const PAGE_CHECKS = [
  canonicalElsewhere,
  hostDuplicate,
  thinHtml,
  noindex,
  redirectChain,
  canonicalMissing,
] as const;

export function createPageRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of PAGE_CHECKS) registry.register(check);
  return registry;
}

export { alternateHost } from "./host-duplicate.js";
export { THIN_HTML_MIN_WORDS } from "./thin-html.js";
