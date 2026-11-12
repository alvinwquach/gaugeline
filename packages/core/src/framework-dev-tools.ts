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
import { devMarkers as gatsbyMarkers, isGatsbySite } from "./gatsby/detect.js";
import { devMarkers as hydrogenMarkers, isHydrogenSite, readEmbedded } from "./hydrogen/detect.js";
import type { PageSnapshot } from "./snapshot.js";
import { devMarkers as staticMarkers } from "./static-generators/detect.js";
import { devMarkers as sveltekitMarkers } from "./sveltekit/detect.js";

/**
 * True when a framework pack's own check (angular-dev-tools-public, astro-dev-tools-public,
 * sveltekit-dev-server-live, hydrogen-dev-tools-live, gatsby-dev-server-live or
 * static-dev-server-live) reports development tools on this page. A framework page that pack
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
    (isHtmlPage(page) && staticMarkers(page).length > 0)
  );
}
