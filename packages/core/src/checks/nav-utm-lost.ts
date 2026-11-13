import { tagSurvival, withoutQuery } from "../ads/tags.js";
import { LIMITS } from "../limits.js";
import { defineCheck } from "../model.js";
import { NAV_TAGS, navProbesOf, navTargets } from "../nav/probe.js";
import { classifyHop, describeRefusal } from "../refusal.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

/**
 * NAV-01. Each menu and footer destination is asked once with test utm_ tags (HEAD, GET only when
 * HEAD is refused) and the first address is compared with the last by the same function the ad and
 * printed-address checks use (`tagSurvival`, ads/tags.ts). Only redirects are followed: a script that
 * rewrites the address after the page loads is not seen.
 *
 * // [docs] uncited: that a redirect keeps a query string only when its Location carries it (RFC 9110 on Location and the 3xx statuses was not opened from this session). The check reads the Location values the fetcher recorded and states nothing more.
 */
export const navUtmLost = defineCheck<PageSnapshot>({
  id: "nav-utm-lost",
  size: "S",
  done: "Every menu link arrives with the campaign tags it was asked with, or goes straight to the page.",
  estimateChanges:
    "A redirect set in the host, a CDN and the app each need checking; a menu link that points at the final address needs no redirect at all.",
  area: "Visitors",
  severity: "medium",
  title: "A menu link drops campaign tags",
  what: "A link in the header or footer menu goes through a redirect that drops utm_source, utm_medium or utm_campaign.",
  why: "A visit that arrives with campaign tags loses them at the redirect, so the report credits no campaign and the menu pages look like they bring nothing in.",
  fix: "Make the redirect pass the query string on, or point the menu link at the address it ends at.",
  tech: `header and footer a[href] of the checked page on the same site, each once (at most ${LIMITS.navLinks}, header first; a longer menu is listed under could not check); one HEAD each (GET if HEAD answers 405 or 501) with ${Object.keys(NAV_TAGS).join(", ")} added after the link's own query, Gaugeline's own values and never a client's; the keys on the first address against the last, values compared after decoding, order ignored, the first redirect that drops a key named with its status. A final status of 4xx or 5xx is not judged here (broken-links does); 401, 403 and 429 are could-not-check; a script that rewrites the address is not seen`,
  async run(page, ctx) {
    if (!ctx.fetcher) return [];
    const targets = navTargets(page, ctx.navRules);
    const cut = targets.seen - targets.taken.length;
    if (cut > 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${targets.seen} menu links on the page and the check asks the first ${LIMITS.navLinks}, so ${cut} ${cut === 1 ? "was" : "were"} not asked`,
      );
    if (targets.taken.length === 0) return [];
    const probes = await navProbesOf(page, ctx.fetcher, ctx.navRules, "tagged");
    const origin = new URL(page.finalUrl).origin;
    const shown = (a: string) => {
      const bare = withoutQuery(a);
      return bare.startsWith(origin) ? bare.slice(origin.length) || "/" : bare;
    };
    const lost: string[] = [];
    for (const p of probes) {
      if (p.error === "loop" || p.error === "too-many-redirects") {
        ctx.couldNotCheck?.(
          p.url,
          `${p.where} ${p.error === "loop" ? "redirects in a loop" : "redirects too many times"}, so its tags were not followed to a page`,
        );
        continue;
      }
      if (p.hops.length === 0 || p.error !== undefined) {
        ctx.couldNotCheck?.(p.url, `the menu link did not answer: ${p.where}`);
        continue;
      }
      const outcome = classifyHop(p.hops.at(-1));
      if (outcome.kind === "refused") {
        ctx.couldNotCheck?.(p.url, `${p.where} ${describeRefusal(outcome)}`);
        continue;
      }
      const loss = tagSurvival(p.hops).lostAt;
      if (!loss) continue;
      lost.push(
        `${p.where}: the ${loss.status} at hop ${loss.hop} from ${shown(loss.from)} to ${shown(loss.to)} drops ${loss.keys.join(", ")}`,
      );
    }
    if (lost.length === 0) return [];
    const sent = Object.entries(NAV_TAGS)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return [
      {
        checkId: "nav-utm-lost",
        severity: "medium",
        title: this.title,
        evidence: `${lost.length} of ${probes.length} menu links lose campaign tags: ${firstFew(lost, 3)}. Gaugeline's own test values were used (${sent}).`,
        url: page.finalUrl,
      },
    ];
  },
});
