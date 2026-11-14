import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { analyticsLoads } from "../trackers/loads.js";
import { CONTAINER_CAP } from "../trackers/reader.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 80);

/**
 * NAV-07. The page's own script tags are counted (no request). With --trackers, the public file of
 * each container the page loads (the same read the tracker checks make, at most CONTAINER_CAP) is
 * searched for the GA4 measurement ids the page also sends itself.
 *
 * // [docs] uncited: that a second install of one container, or a second gtag config call for one id, sends its events twice (Google Tag Manager and gtag.js documentation was not reachable from this session). The evidence says what was counted ("installed 2 times") and "can" fire twice, not that it did.
 */
export const analyticsLoadedTwice = defineCheck<PageSnapshot>({
  id: "analytics-loaded-twice",
  size: "S",
  done: "Each Tag Manager container is installed once, and each Google Analytics 4 id is sent from one place.",
  estimateChanges:
    "Usually deleting one snippet. Which copy is the real one has to be decided by whoever owns the Tag Manager and Analytics accounts.",
  area: "Leads",
  severity: "high",
  title: "Analytics are loaded twice on this page",
  what: "The page installs the same Tag Manager container twice, loads or configures the same Google Analytics 4 id twice, or sends a Google Analytics 4 id both from its own gtag code and from its Tag Manager container.",
  why: "Every visit, lead and sale is counted twice, so conversion numbers and the ad bidding that learns from them are wrong, and a before-and-after comparison of a new menu measures the doubling, not the menu.",
  fix: "Keep one install: delete the second snippet, or take the Google Analytics 4 tag out of the page's code (or out of the container) so the id is sent from one place.",
  tech: `The page's script tags (addresses and inline code), no request: a Tag Manager container id (GTM-...) found in 2 or more of them (the noscript iframe is the other half of one install and is not counted); a GA4 measurement id (G-...) named by 2 or more gtag.js addresses, or by 2 or more gtag('config', id) calls. With --trackers and a hard-coded GA4 id on a page that also loads a container, the container's public file (one GET each of www.googletagmanager.com/gtm.js?id=..., at most ${CONTAINER_CAP}, the file every visitor receives, read as text and never run) is searched for the same measurement id; a container that cannot be read, or is longer than the size cap, is could-not-check. A tag a script adds after the page loads is not seen, and the finding says "can" be counted twice: a tag that is paused or has a trigger that does not fire here is not visible`,
  async run(page, ctx) {
    const loads = analyticsLoads(page);
    const out: Finding[] = [];
    const add = (evidence: string) =>
      out.push({
        checkId: "analytics-loaded-twice",
        severity: "high",
        title: this.title,
        evidence,
        url: clip(page.finalUrl),
      });
    for (const [id, n] of loads.containers)
      if (n >= 2)
        add(
          `Tag Manager container ${clip(id)} is installed ${n} times on this page, so every tag in it can fire twice`,
        );
    for (const [id, n] of loads.gtagScripts)
      if (n >= 2)
        add(
          `Google Analytics 4 id ${clip(id)} is loaded by gtag.js ${n} times, so each visit can be counted twice`,
        );
    for (const [id, n] of loads.gtagConfigs)
      if (n >= 2)
        add(
          `Google Analytics 4 id ${clip(id)} is configured ${n} times, so each page view is sent twice`,
        );
    const trackers = ctx.trackers;
    const containers = [...loads.containers.keys()];
    if (trackers && loads.ga4Ids.length > 0 && containers.length > 0) {
      for (const extra of containers.slice(CONTAINER_CAP))
        ctx.couldNotCheck?.(
          page.finalUrl,
          `${extra} was not read: at most ${CONTAINER_CAP} Tag Manager containers are read for one page.`,
        );
      for (const id of containers.slice(0, CONTAINER_CAP)) {
        const read = await trackers.container(id);
        if (!read.ok) {
          ctx.couldNotCheck?.(
            page.finalUrl,
            `The Tag Manager container ${read.reason} Whether it also sends the page's Google Analytics 4 id was not checked.`,
          );
          continue;
        }
        const inside = new Set(read.trackers.filter((t) => t.kind === "ga4").flatMap((t) => t.ids));
        const shared = loads.ga4Ids.filter((g) => inside.has(g));
        for (const g of shared)
          add(
            `Google Analytics 4 id ${clip(g)} is sent by the page's own gtag code and by Tag Manager container ${clip(id)}, so each visit can be counted twice`,
          );
        if (read.truncated && shared.length === 0)
          ctx.couldNotCheck?.(
            page.finalUrl,
            `The Tag Manager container ${id} is longer than Gaugeline reads, so whether it also sends the page's Google Analytics 4 id was not fully checked.`,
          );
      }
    }
    return out;
  },
});
