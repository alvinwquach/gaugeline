import { AI_AGENTS, type AiAgent } from "../ai-agents.js";
import { defineCheck } from "../model.js";
import { hasOwnGroup, isAllowed } from "../robots.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

function label(a: AiAgent): string {
  return `${a.token} (${a.owner})`;
}

export const aiCrawlersBlocked = defineCheck<PageSnapshot>({
  id: "ai-crawlers-blocked",
  area: "Search & sharing",
  severity: "low",
  title: "Some AI assistants can't read your site",
  what: "robots.txt stops one or more known AI crawlers from reading the home page. Gaugeline says which, and whether the block names them or comes from a rule for every crawler.",
  why: "People ask assistants about a business before they open its site. Blocking AI crawlers is a fair choice; blocking them by accident means assistants answer from old or second-hand information.",
  fix: "If the block is on purpose, there is nothing to do. If it comes from a Disallow: / meant for a staging site, remove it, or add groups for the assistants you want to allow.",
  tech: "known AI user-agent tokens (packages/core/src/data/ai-agents.json) are disallowed / by robots.txt",
  async run(page, ctx) {
    const site = await ctx.site?.();
    if (!site) return [];
    if (site.robotsState === "unknown") {
      // A 5xx robots.txt says nothing about the rules: could not check, not "allowed".
      throw new Error(
        `${site.robotsUrl} did not answer, so AI crawler access could not be checked.`,
      );
    }
    if (!site.robots) return [];
    const robots = site.robots;
    const path = new URL(page.finalUrl).pathname || "/";
    const blocked = AI_AGENTS.filter((a) => !isAllowed(robots, a.token, path));
    if (blocked.length === 0) return [];
    const named = blocked.filter((a) => hasOwnGroup(robots, a.token));
    const blanket = blocked.filter((a) => !hasOwnGroup(robots, a.token));
    const parts: string[] = [];
    if (named.length > 0)
      parts.push(`blocked by name (looks intentional): ${firstFew(named.map(label), 6)}`);
    if (blanket.length > 0)
      parts.push(
        `blocked by the rule for every crawler (may be accidental): ${firstFew(blanket.map(label), 6)}`,
      );
    return [
      {
        checkId: "ai-crawlers-blocked",
        severity: "low",
        title: this.title,
        evidence: `${blocked.length} of ${AI_AGENTS.length} known AI crawlers cannot read ${path}; ${parts.join("; ")}`,
        url: site.robotsUrl,
      },
    ];
  },
});
