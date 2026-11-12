/**
 * Where two checks could say the same thing about one site, the framework's own pack wins and the
 * generic check steps aside, so a site is not told one problem twice. Each function here names the
 * packs that cover a kind of finding, using each pack's own detector, so the generic check and the
 * pack cannot disagree about which sites are covered. Pure functions over the page already fetched.
 */
import { isAngularSite } from "./angular/detect.js";
import { isAstroSite } from "./astro/detect.js";
import { isGatsbySite } from "./gatsby/detect.js";
import { isHydrogenSite } from "./hydrogen/detect.js";
import { frameworkOf as qwikOrSolidStart } from "./checks/qwik-solid-shared.js";
import { isNextSite } from "./next/detect.js";
import { isRemixSite } from "./remix/detect.js";
import type { PageSnapshot } from "./snapshot.js";
import { generatorOf } from "./static-generators/detect.js";
import { isSveltekitSite } from "./sveltekit/detect.js";

/**
 * True when the page's framework pack has its own check for a preview or placeholder canonical,
 * og:url and sitemap (next-, astro-, sveltekit-, angular-, gatsby-, hydrogen-, remix-, qwik-solid- and static-preview-canonical).
 * host-preview-named and host-preview-indexable then leave those three places to that check.
 * A pack without such a check (and a site no pack recognises) is not listed: the generic checks
 * are the only ones that report there.
 */
export function frameworkCoversPreviewCanonical(page: PageSnapshot): boolean {
  return (
    isNextSite(page) ||
    isAstroSite(page) ||
    isSveltekitSite(page) ||
    isAngularSite(page) ||
    isGatsbySite(page) ||
    isHydrogenSite(page) ||
    isRemixSite(page) ||
    qwikOrSolidStart(page) !== undefined ||
    generatorOf(page) !== undefined
  );
}
