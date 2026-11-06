import { defineCheck } from "../model.js";
import { buildRunSnapshot, diffSnapshots } from "../run-snapshot.js";
import type { PageSnapshot } from "../snapshot.js";

export const formDestinationChanged = defineCheck<PageSnapshot>({
  id: "form-destination-changed",
  area: "Leads",
  severity: "medium",
  title: "A form now posts to a different address",
  what: "A form still uses the same service, but posts to a different host than last run.",
  why: "A different host can mean a different account or region with the same service, so entries may land where nobody reads them.",
  fix: "Confirm the new address belongs to your account with that service.",
  tech: "With --since last only: the same form key and provider, with a different action host",
  run(page, ctx) {
    if (!ctx.previous) return [];
    const next = buildRunSnapshot(page, ctx.now);
    return diffSnapshots(ctx.previous, next)
      .filter((c) => c.checkId === "form-destination-changed")
      .map((c) => ({
        checkId: c.checkId,
        severity: c.severity,
        title: this.title,
        evidence: c.evidence,
        url: page.finalUrl,
      }));
  },
});
