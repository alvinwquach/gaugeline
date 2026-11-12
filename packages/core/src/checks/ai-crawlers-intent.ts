import { hasOwnGroup } from "../robots.js";
import { intentMismatches, AI_CONFIG_FILE, type AiIntent } from "../ai-intent.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

const WORDS: Record<AiIntent, string> = {
  allow: "allow every AI crawler",
  block: "block every AI crawler",
  "training-block": "block crawlers that collect training data and allow the rest",
  "search-only": "allow only crawlers that build a search index",
};

export const aiCrawlersIntent = defineCheck<PageSnapshot>({
  id: "ai-crawlers-intent",
  size: "S",
  done: "robots.txt does for each known AI crawler what gaugeline.ai.json says you want.",
  estimateChanges:
    "A rule set in a firewall or a CDN rather than robots.txt is found by looking at those settings.",
  area: "Search & sharing",
  severity: "medium",
  title: "Your robots.txt does not do what you said you want for AI crawlers",
  what: "You said what AI crawlers should be able to do (aiCrawlers in gaugeline.ai.json), and robots.txt does the opposite for one or more known crawlers. Gaugeline names them and says whether a rule names them or the rule for every crawler decides.",
  why: "A rule copied from a staging site, or a plugin's default, can shut assistants out of a site that wants to be found by them, or let training crawlers in when you meant to keep them out.",
  fix: "Edit robots.txt so each crawler listed gets the group you want, or change aiCrawlers in gaugeline.ai.json if the rules are right and the intent changed.",
  tech: "for each known AI user-agent token (packages/core/src/data/ai-agents.json), isAllowed(robots.txt, token, /) differs from the aiCrawlers intent for its purpose; no robots.txt means every crawler is allowed",
  async run(page, ctx) {
    const intent = ctx.ai?.aiCrawlers;
    if (!intent) return [];
    const site = await ctx.site?.();
    if (!site) return [];
    if (site.robotsState === "unknown") {
      // A 5xx robots.txt says nothing about the rules: could not check, never "allowed".
      throw new Error(
        `${site.robotsUrl} did not answer, so AI crawler access could not be compared with ${AI_CONFIG_FILE}.`,
      );
    }
    const path = new URL(page.finalUrl).pathname || "/";
    const bad = intentMismatches(site.robots, intent, path);
    if (bad.length === 0) return [];
    const robots = site.robots;
    const label = (m: (typeof bad)[number]) => `${m.agent.token} (${m.agent.owner})`;
    const blocked = bad.filter((m) => !m.allowed);
    const open = bad.filter((m) => m.allowed);
    const parts: string[] = [];
    if (blocked.length > 0) {
      const blanket = blocked.filter((m) => !robots || !hasOwnGroup(robots, m.agent.token));
      parts.push(
        `blocked but should be allowed: ${firstFew(blocked.map(label), 6)}` +
          (blanket.length > 0 ? ` (${blanket.length} by the rule for every crawler)` : ""),
      );
    }
    if (open.length > 0) {
      parts.push(
        `allowed but should be blocked: ${firstFew(open.map(label), 6)}` +
          (robots ? "" : " (there is no robots.txt, so nothing stops them)"),
      );
    }
    return [
      {
        checkId: "ai-crawlers-intent",
        severity: "medium",
        title: this.title,
        evidence: `${AI_CONFIG_FILE} says to ${WORDS[intent]}; for ${path}, ${parts.join("; ")}`,
        url: site.robotsUrl,
      },
    ];
  },
});
