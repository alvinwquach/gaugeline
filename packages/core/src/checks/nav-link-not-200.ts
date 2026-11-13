import { LIMITS } from "../limits.js";
import { defineCheck, type Finding } from "../model.js";
import { navTargets, navTrailsOf, type NavTrail } from "../nav/probe.js";
import { classifyHop, describeRefusal } from "../refusal.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** "301 /catering, 302 /catering/, 200 /events": each hop's status and where it was asked. */
function trailText(t: NavTrail, origin: string): string {
  return t.hops
    .map((h) => {
      let where = h.url;
      try {
        const u = new URL(h.url);
        where = u.origin === origin ? `${u.pathname}${u.search}` : h.url;
      } catch {
        // keep the address as written
      }
      return `${h.status} ${where}`;
    })
    .join(", ");
}

/**
 * NAV-02. Every header and footer destination (at most LIMITS.navLinks) is read with its whole trail.
 * The ones the run's link sample already asked are not asked again. A single redirect is
 * `links-via-redirect`'s, a 4xx or 5xx that sample found is `broken-links`'s, and a link into a hidden
 * section or a draft is `hidden-linked`'s and `drafts-live`'s: this check adds the chain, the hop
 * count, the 2xx that is not a page, the loop, and the dead menu link the sample never reached.
 *
 * // [docs] uncited: that search engines follow only a few redirect hops (the statement the existing redirect checks rely on); this check states the hop count it saw and nothing about what a crawler does.
 */
export const navLinkNot200 = defineCheck<PageSnapshot>({
  id: "nav-link-not-200",
  size: "S",
  done: "Every menu link answers 200 at once, or through a single redirect.",
  estimateChanges:
    "A moved page with a rule for the old address and another for the slash is one rule each; a menu link edited to point at the final address needs no rule.",
  area: "Visitors",
  severity: "high",
  title: "Menu links don't answer 200 at once",
  what: "A link in the header or footer menu takes two or more redirects, ends in a redirect loop, answers 4xx or 5xx, or answers a 2xx that is not 200 (204, for one).",
  why: "The menu is the part of the site every visitor and every crawler follows first. Each extra hop is a round trip and a place for tracking and rankings to be lost, and a menu link that does not land on a page is a dead end on every page of the site.",
  fix: "Point the menu link at the address it ends at, so it needs no redirect, and fix or remove one that errors. Where an old address must keep working, redirect it once, straight to the final page.",
  tech: `header and footer a[href] of the checked page on the same site, each once (at most ${LIMITS.navLinks}, header first; a longer menu is listed under could not check); one HEAD each (GET if HEAD answers 405 or 501), every hop kept, with an address the link sample already asked reused and not asked again. Two or more 3xx hops is a chain (the count and each hop's status and address are the evidence); a loop or more than ${LIMITS.redirectHops} hops is reported as such; a final status that is not 200 is reported (a 4xx or 5xx that the link sample found is broken-links's and is left to it); 401, 403 and 429 are could-not-check. A single redirect is links-via-redirect's, and a link into a hidden section or a draft is hidden-linked's and drafts-live's: nothing is added for them`,
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
    const sample = await ctx.links?.();
    const all = await navTrailsOf(page, ctx.fetcher, ctx.navRules, sample);
    const origin = new URL(page.finalUrl).origin;
    const errors: string[] = [];
    const chains: string[] = [];
    for (const t of all) {
      const last = t.hops.at(-1);
      if (t.error === "loop" || t.error === "too-many-redirects") {
        errors.push(
          `${t.where} ${t.error === "loop" ? "redirects in a loop" : `redirects more than ${LIMITS.redirectHops} times`} (${trailText(t, origin)})`,
        );
        continue;
      }
      if (last === undefined || t.error !== undefined) {
        ctx.couldNotCheck?.(t.url, `the menu link did not answer: ${t.where}`);
        continue;
      }
      const outcome = classifyHop(last);
      if (outcome.kind === "refused") {
        ctx.couldNotCheck?.(t.url, `${t.where} ${describeRefusal(outcome)}`);
        continue;
      }
      const redirects = t.hops.filter((h) => REDIRECT.has(h.status)).length;
      if (REDIRECT.has(last.status)) {
        errors.push(`${t.where} ends on a ${last.status} (${trailText(t, origin)})`);
      } else if (last.status >= 400) {
        // broken-links reports the ones its sample asked: this is the dead menu link it never reached.
        if (!t.sampled) errors.push(`${t.where} answers ${last.status}, not 200`);
      } else if (last.status !== 200) {
        chains.push(`${t.where} answers ${last.status}, not 200`);
      } else if (redirects >= 2) {
        chains.push(`${t.where} takes ${redirects} redirects (${trailText(t, origin)})`);
      }
    }
    const out: Finding[] = [];
    const add = (severity: Finding["severity"], items: string[]) => {
      if (items.length === 0) return;
      out.push({
        checkId: "nav-link-not-200",
        severity,
        title: this.title,
        evidence: `${items.length} of ${all.length} menu ${all.length === 1 ? "link" : "links"} ${items.length === 1 ? "does" : "do"} not answer 200 at once: ${firstFew(items, 3)}`,
        url: page.finalUrl,
      });
    };
    add("high", errors);
    add("medium", chains);
    return out;
  },
});
