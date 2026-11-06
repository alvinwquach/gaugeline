import { defineCheck } from "../model.js";
import { buildRunSnapshot, diffSnapshots } from "../run-snapshot.js";
import type { PageSnapshot } from "../snapshot.js";

export const priceChanged = defineCheck<PageSnapshot>({
  id: "price-changed",
  area: "Sales & prices",
  severity: "low",
  title: "A price changed since the last run",
  what: "A product's price in the page's structured data is different from the last run's.",
  why: "Sometimes that is the plan. When it isn't (a sync from the shop, an edit to the wrong product), customers and search results see the wrong price.",
  fix: "If the change wasn't meant, correct the price at its source (the shop or CMS) and rebuild; if it was, nothing to do.",
  tech: "With --since last only: the JSON-LD Offer price (integer minor units; anything but 48 or 48.00 is unread) for a product key (sku or name plus currency) present in both runs",
  run(page, ctx) {
    if (!ctx.previous) return [];
    const next = buildRunSnapshot(page, ctx.now);
    return diffSnapshots(ctx.previous, next)
      .filter((c) => c.checkId === "price-changed")
      .map((c) => ({
        checkId: c.checkId,
        severity: c.severity,
        title: this.title,
        evidence: c.evidence,
        url: page.finalUrl,
      }));
  },
});
