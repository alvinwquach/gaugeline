import { pageSignals, signalsAgainstIntent, type SignalMismatch } from "../ai-crawlers/signals.js";
import { AI_CONFIG_FILE } from "../ai-intent.js";
import { INTENT_WORDS } from "./ai-crawlers-intent.js";
import { defineCheck, type Finding } from "../model.js";
import type { SiteContext } from "../site-context.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";
import { firstFew } from "./site-helpers.js";

/** One report of the llms.txt mismatch per site, however many pages are checked. */
const reported = new WeakSet<SiteContext>();

function placeOf(m: SignalMismatch): string {
  if (m.where === "header") return "the X-Robots-Tag header";
  return m.scope === undefined ? "the robots meta tag" : `the ${m.scope} meta tag`;
}

function join(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * AI-14, extending ai-crawlers-intent (which compares robots.txt with the intent in gaugeline.ai.json): the same intent
 * compared with the signals a page carries itself (an X-Robots-Tag header, a robots or crawler meta tag) and with llms.txt.
 * Without a stated intent there is nothing to compare with, so nothing is said. It reads the page and the site context
 * the run already holds, sends no request, and never prints page text.
 *
 * // [docs] uncited: noai and noimageai (a convention some sites use to opt out of AI training) and the `Crawler: directive` form in X-Robots-Tag for AI crawlers are from memory; the pages that document them were unreachable when this was written. The check says what it saw and no more.
 */
export const aiCrawlersDirectives = defineCheck<PageSnapshot>({
  id: "ai-crawlers-directives",
  size: "S",
  done: "The page's headers and meta tags, and llms.txt, say about AI crawlers what gaugeline.ai.json says you want.",
  estimateChanges:
    "A header set by a CDN rule, a framework config or a plugin is found by looking at each; a meta tag from a theme is one template edit.",
  area: "Search & sharing",
  severity: "medium",
  title:
    "A page header, meta tag or llms.txt says something different about AI crawlers than you said you want",
  what: "You said what AI crawlers should be able to do (aiCrawlers in gaugeline.ai.json). The page sends a header or a meta tag that keeps a crawler you want away (noai, or noindex for one named crawler), or you want none of them and the site still publishes llms.txt, a guide written for AI assistants.",
  why: "robots.txt is only one place to say it. A header from a CDN rule or a meta tag from a theme can quietly shut out the assistants you want to be found by, and a published llms.txt invites the ones you said to keep out.",
  fix: "Remove the header or meta tag that blocks a crawler you want, or change aiCrawlers in gaugeline.ai.json if the signal is right and the intent changed. If you want no AI crawler on the site, remove llms.txt.",
  tech: "Only with an aiCrawlers intent in gaugeline.ai.json. Reads the page's X-Robots-Tag header (read to 4,096 characters) and its meta tags named robots or for a known AI crawler (packages/core/src/data/ai-agents.json); a directive counts only from a fixed list. noai and noimageai count against the training crawlers (or the one named); noindex and none count against a crawler named in the header or in a crawler's own meta tag; a general noindex is the noindex check's. A signal that agrees with the intent is fine, and one that fails to block a crawler you want blocked is left to ai-crawlers-intent, which reads robots.txt. With the intent block, /llms.txt (read by the run, found with a 2xx plain-text answer) is a finding, once per site. noai and the Crawler: directive form are conventions from memory (uncited). No request is made; page text is never printed",
  async run(page, ctx) {
    const intent = ctx.ai?.aiCrawlers;
    if (!intent || !isHtmlPage(page)) return [];
    const out: Finding[] = [];
    const path = new URL(page.finalUrl).pathname || "/";
    const bad = signalsAgainstIntent(pageSignals(page), intent);
    if (bad.length > 0) {
      // The same place naming the same crawlers with two directives (noai and noimageai) is one part.
      const grouped = new Map<
        string,
        { place: string; directives: string[]; agents: SignalMismatch["agents"] }
      >();
      for (const m of bad) {
        const key = `${placeOf(m)}|${m.agents.map((a) => a.token).join(",")}`;
        const g = grouped.get(key) ?? { place: placeOf(m), directives: [], agents: m.agents };
        g.directives.push(m.directive);
        grouped.set(key, g);
      }
      const parts = [...grouped.values()].map(
        (g) =>
          `${g.place} says ${join(g.directives)} for ${firstFew(
            g.agents.map((a) => `${a.token} (${a.owner})`),
            4,
          )}`,
      );
      out.push({
        checkId: "ai-crawlers-directives",
        severity: "medium",
        title: this.title,
        evidence: `${AI_CONFIG_FILE} says to ${INTENT_WORDS[intent]}; for ${path}, ${join(parts)}`,
        url: page.finalUrl,
      });
    }
    if (intent === "block") {
      const site = await ctx.site?.();
      if (site && site.llms.state === "found" && !reported.has(site)) {
        reported.add(site);
        out.push({
          checkId: "ai-crawlers-directives",
          severity: "medium",
          title: this.title,
          evidence: `${AI_CONFIG_FILE} says to ${INTENT_WORDS[intent]}, and the site publishes /llms.txt, a guide written for AI assistants`,
          url: site.llms.url,
        });
      }
    }
    return out;
  },
});
