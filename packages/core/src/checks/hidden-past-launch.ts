import { overdue } from "../hidden.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const hiddenPastLaunch = defineCheck<PageSnapshot>({
  id: "hidden-past-launch",
  size: "S",
  done: "The until date is moved, or the section is removed from gaugeline.hidden.json.",
  estimateChanges: "One entry in one file.",
  area: "Launch day",
  severity: "low",
  title: "A hidden section is past its launch date",
  what: "Today is after the launch date set for a hidden section, and gaugeline.hidden.json still lists it as hidden.",
  why: "Either the launch slipped and nobody updated the plan, or it launched and the hidden checks are now guarding the wrong thing.",
  fix: "Move the until date, or remove the section from gaugeline.hidden.json now that it's live.",
  tech: "A hidden section's until date (YYYY-MM-DD, the whole day in UTC) is before the run's clock; no request is made",
  run(page, ctx) {
    if (!ctx.hidden) return [];
    return overdue(ctx.hidden, ctx.now ?? (() => new Date())).map((s) => ({
      checkId: "hidden-past-launch",
      severity: "low" as const,
      title: this.title,
      evidence: `${s.match} was due to launch on ${s.until ?? ""} and is still listed as hidden`,
      url: page.finalUrl,
    }));
  },
});
