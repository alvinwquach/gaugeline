import { defineCheck } from "../model.js";
import { decidingRule } from "../robots.js";
import type { PageSnapshot } from "../snapshot.js";

export const robotsBlock = defineCheck<PageSnapshot>({
  id: "robots-block",
  area: "Search & sharing",
  severity: "high",
  title: "Your robots.txt tells every search engine to stay away",
  what: "robots.txt has a group for every crawler (User-agent: *) that disallows the whole site.",
  why: "Search engines stop crawling the site, so new pages never appear and old ones fade out of results.",
  fix: "Remove the Disallow: / line from the User-agent: * group, or replace it with the paths you mean to hide. This line is often left over from a staging site.",
  tech: "robots.txt: User-agent: * with Disallow: / and no Allow that overrides it",
  async run(_page, ctx) {
    const site = await ctx.site?.();
    if (!site?.robots) return [];
    const rule = decidingRule(site.robots, "*", "/");
    if (!rule || rule.allow || rule.path !== "/") return [];
    return [
      {
        checkId: "robots-block",
        severity: "high",
        title: this.title,
        evidence: `${site.robotsUrl} has User-agent: * with Disallow: /`,
        url: site.robotsUrl,
      },
    ];
  },
});
