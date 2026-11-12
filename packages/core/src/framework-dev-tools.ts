/**
 * Where a framework pack already reports a development server or its tools, the generic
 * dev-tools-in-production check steps aside, so a site is not told one problem twice. This runs the
 * same test each pack's own check runs, with that pack's own detector and markers, so the two
 * cannot disagree about which pages are covered. Pure functions over the page already fetched.
 */
import {
  devMarkers as angularMarkers,
  isAngularSite,
  pageBody as angularBody,
} from "./angular/detect.js";
import { devMarkers as astroMarkers, isAstroSite, pageBody as astroBody } from "./astro/detect.js";
import { isHtmlPage } from "./checks/page.js";
import { frameworkOf } from "./checks/qwik-solid-shared.js";
import { devMarkers as gatsbyMarkers, isGatsbySite } from "./gatsby/detect.js";
import { devMarkers as hydrogenMarkers, isHydrogenSite, readEmbedded } from "./hydrogen/detect.js";
import { isNuxtSite, NUXT_DEV_SCRIPT } from "./nuxt/detect.js";
import { devMarkers as qwikMarkers } from "./qwik/detect.js";
import { devMarkers as remixMarkers } from "./remix/detect.js";
import type { PageSnapshot } from "./snapshot.js";
import { devMarkers as solidMarkers } from "./solidstart/detect.js";
import { devMarkers as staticMarkers } from "./static-generators/detect.js";
import { devMarkers as sveltekitMarkers } from "./sveltekit/detect.js";

/** The markers qwik-solid-dev-server-live reports: Qwik's on a Qwik page, SolidStart's on a SolidStart page. */
function qwikSolidMarkers(page: PageSnapshot): string[] {
  const framework = frameworkOf(page);
  if (framework === undefined) return [];
  return framework === "qwik" ? qwikMarkers(page) : solidMarkers(page);
}

/**
 * True when a framework pack's own check (angular-dev-tools-public, astro-dev-tools-public,
 * sveltekit-dev-server-live, hydrogen-dev-tools-live, gatsby-dev-server-live,
 * remix-dev-tools-live, nuxt-dev-build-live, qwik-solid-dev-server-live or static-dev-server-live) reports development tools on this page. A framework page that pack
 * finds nothing on is not covered, so the generic check still reads its scripts; a site no pack
 * recognises, and a Next.js site (which has no such pack check), is never covered.
 */
export function frameworkCoversDevTools(page: PageSnapshot): boolean {
  return (
    (isAngularSite(page) && angularMarkers(angularBody(page).html).length > 0) ||
    (isAstroSite(page) && astroMarkers(astroBody(page).html).length > 0) ||
    sveltekitMarkers(page).length > 0 ||
    (hydrogenMarkers(page).length > 0 &&
      (isHydrogenSite(page) || readEmbedded(page) !== undefined)) ||
    (isGatsbySite(page) && gatsbyMarkers(page).length > 0) ||
    remixMarkers(page).length > 0 ||
    (isNuxtSite(page) && page.scripts.some((src) => NUXT_DEV_SCRIPT.test(src))) ||
    qwikSolidMarkers(page).length > 0 ||
    (isHtmlPage(page) && staticMarkers(page).length > 0)
  );
}
