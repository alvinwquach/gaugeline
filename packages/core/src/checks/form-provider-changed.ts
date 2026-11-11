import { defineCheck } from "../model.js";
import { buildRunSnapshot, diffSnapshots } from "../run-snapshot.js";
import type { PageSnapshot } from "../snapshot.js";

export const formProviderChanged = defineCheck<PageSnapshot>({
  id: "form-provider-changed",
  size: "S",
  done: "The form posts to the service you use, confirmed with whoever changed it.",
  estimateChanges:
    "An unnoticed plugin update takes longer to trace. A move that was meant needs your follow-up changed to match.",
  area: "Leads",
  severity: "high",
  title: "A form now sends to a different service",
  what: "A form that sent its entries to one service (HubSpot, say) now posts to another.",
  why: "Leads go somewhere nobody is watching, or to an account you don't control, from the moment it changed.",
  fix: "Check who changed the form's action; point it back at your service, or update your follow-up to the new one.",
  tech: "With --since last only: the same form key (id, else name, else position) now posts to a host in a different provider row of the frozen table; position keys can swap and read as a change",
  run(page, ctx) {
    if (!ctx.previous) return [];
    const next = buildRunSnapshot(page, ctx.now);
    return diffSnapshots(ctx.previous, next)
      .filter((c) => c.checkId === "form-provider-changed")
      .map((c) => ({
        checkId: c.checkId,
        severity: c.severity,
        title: this.title,
        evidence: c.evidence,
        url: page.finalUrl,
      }));
  },
});
