import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { kindWords } from "../tags/analyse.js";

export const tagsDeadRules = defineCheck<PageSnapshot>({
  id: "tags-dead-rules",
  area: "Leads",
  severity: "medium",
  title: "A tracking rule points at something that no longer exists",
  what: "A Tag Manager trigger waits for a page address, link, form or element that no page on the site has, so its tags never fire.",
  why: "Tag rules outlive the pages they were written for: a download or form trigger tied to a retired address goes quiet, and the report just shows fewer leads.",
  fix: "Point the trigger at what the site uses now (the nearest match is in the evidence), or delete it and the tags that only it fires.",
  tech: "The container export named in gaugeline.tags.json (no Tag Manager account is used). Page address conditions are compared with the pages read, their same-site links and the sitemap; click and form conditions (Click URL, ID, Classes, Text, Element; Form ID, Classes, Text, URL, Element) with the elements of the pages read. A trigger type, variable or comparison it doesn't read, a custom event, or a trigger limited to pages the run didn't read is listed under could not check",
  async run(page, ctx) {
    if (!ctx.tagRules) return [];
    const analysis = await ctx.tagRules();
    const findings = [];
    for (const v of analysis.verdicts) {
      if (v.state === "unchecked")
        ctx.couldNotCheck?.(page.finalUrl, `trigger "${v.trigger.name}": ${v.reason}`);
      if (v.state !== "dead") continue;
      findings.push({
        checkId: "tags-dead-rules",
        severity: "medium" as const,
        title: this.title,
        evidence: `Trigger "${v.trigger.name}" (${kindWords(v.trigger)}): ${v.rule} matches ${v.where}${v.nearest ? `; nearest that exists: ${v.nearest}` : ""}`,
        url: page.finalUrl,
      });
    }
    return findings;
  },
});
