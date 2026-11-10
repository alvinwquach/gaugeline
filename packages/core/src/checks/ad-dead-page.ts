import { adsLine, classifyLanding, endsAtHomePage, shown } from "../ads/landing.js";
import type { StockRead } from "../ads/landing.js";
import type { TagProbe } from "../ads/tags.js";
import { defineCheck, type Finding } from "../model.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * What the ad landing page checks read: the destinations with the hops the fetcher recorded for
 * them (ads/check.ts), and, for each Shopify product page, what its stock endpoint said. The
 * requests are made before the checks run, so the same input always gives the same findings.
 */
export interface AdPagesInput {
  probes: readonly TagProbe[];
  stock: ReadonlyMap<string, StockRead>;
}

const TITLE = "The page doesn't load";
const NOTE_TITLE = "The ad no longer lands on a product";

function whyDead(probe: TagProbe, why: string, status: number | undefined): string {
  const last = probe.hops.at(-1);
  const redirected = probe.hops.length > 1 && last !== undefined;
  if (status !== undefined && probe.error === undefined)
    return redirected
      ? `${shown(probe.url)} redirects to ${shown(last.url)}, which answers ${status}.`
      : `${shown(probe.url)} answers ${status}.`;
  const cause = escapeInvisible(why, 160);
  return `${shown(probe.url)} could not be loaded: ${cause.replace(/\.$/, "")}.`;
}

export const adDeadPage = defineCheck<AdPagesInput>({
  id: "ad-dead-page",
  area: "Visitors",
  severity: "high",
  title: TITLE,
  what: "An ad sends people to a page that answers 404, 410 or a server error, or that cannot be reached at all.",
  why: "Everyone clicking that ad lands on an error, so every click is paid for and nobody can buy, book or call.",
  fix: "Bring the page back, or redirect its address to the page that replaced it, then check the ad's link. Pause the ad until it works.",
  tech: "per landing page, the final answer of the one GET the ads command already made (the campaign tag check's): a status of 400 or more, or a request that failed (not found, refused, timeout, TLS, a redirect loop, too many redirects), is a finding; 401, 403, 429 and a bot challenge page, a storefront closed with a password, and an address Gaugeline does not ask for (non-public; see --allow-private) are could-not-check, never dead; a deeper address that redirects to its own site's home page and ends 200 is a low note that the ad no longer lands on a product",
  run: (input, ctx) => {
    const findings: Finding[] = [];
    for (const probe of input.probes) {
      const landing = classifyLanding(probe);
      if (landing.kind === "dead")
        findings.push({
          checkId: "ad-dead-page",
          severity: "high",
          title: TITLE,
          evidence: `${whyDead(probe, landing.why, landing.status)} Everyone clicking an ad that links here lands on an error. ${adsLine(probe)}`,
          url: probe.url,
        });
      else if (landing.kind === "unreadable")
        ctx.couldNotCheck?.(
          probe.url,
          `the page could not be read: ${landing.why}`.replace(/\.$/, ""),
        );
      else {
        const home = endsAtHomePage(probe);
        if (home)
          findings.push({
            checkId: "ad-dead-page",
            severity: "low",
            title: NOTE_TITLE,
            evidence: `${shown(probe.url)} redirects to the home page, ${shown(home.url)}, which answers ${home.status}. The page loads, but the ad no longer lands on a product. ${adsLine(probe)}`,
            url: probe.url,
          });
      }
    }
    return findings;
  },
});
