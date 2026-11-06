import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { duplicateTags } from "../tags/analyse.js";

export const tagsDuplicate = defineCheck<PageSnapshot>({
  id: "tags-duplicate",
  area: "Leads",
  severity: "medium",
  title: "Two tags send the same event at the same moment",
  what: "Two Tag Manager tags that aren't paused send the same event to the same place on the same trigger.",
  why: "Every lead, download or sale is counted twice, so conversion numbers and the ad bidding built on them are wrong.",
  fix: "Keep one of the tags and pause or delete the other (usually the copy).",
  tech: "The container export named in gaugeline.tags.json, read without requests. GA4 event tags are the same when the event name and the measurement ID match; any other tag type when its type and every setting match. Paused tags are left out",
  run(page, ctx) {
    if (!ctx.tagContainer) return [];
    return duplicateTags(ctx.tagContainer).map((d) => ({
      checkId: "tags-duplicate",
      severity: "medium" as const,
      title: this.title,
      evidence: `${d.tags.map((t) => `"${t}"`).join(" and ")} ${d.tags.length === 2 ? "both" : "all"} send ${d.label} on trigger "${d.trigger.name}"`,
      url: page.finalUrl,
    }));
  },
});
