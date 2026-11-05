import { defineCheck } from "../model.js";
import { HANDLE_KINDS, KIND_NAME } from "../payments/types.js";
import type { PageSnapshot } from "../snapshot.js";
import { around, configured, groupPayments, onPages, paymentPages } from "./payments/common.js";

const HANDLES: ReadonlySet<string> = new Set(HANDLE_KINDS);

export const paymentHandleUnknown = defineCheck<PageSnapshot>({
  id: "payment-handle-unknown",
  area: "Sales & prices",
  severity: "high",
  title: "A payment detail you didn't set is on the site",
  what: "A page shows a payment handle for a service you didn't set up, or a Square or Stripe payment link that isn't one of yours.",
  why: "An old account, a copied template or a stranger's handle takes customers' money where you can't see it.",
  fix: "Remove it, or add it to gaugeline.payments.json if it really is yours.",
  tech: "Handles for a service with no entry in gaugeline.payments.json, and square.link, checkout.square.site and buy.stripe.com links not listed there, on the pages checked",
  async run(page, ctx) {
    if (!ctx.payments) return [];
    const mine = configured(ctx.payments);
    const groups = groupPayments(await paymentPages(page, ctx));
    return groups.flatMap((g) => {
      const values = mine.get(g.kind);
      // A handle for a configured service is a mismatch, not unknown; links are compared one by one.
      const known = HANDLES.has(g.kind) ? values !== undefined : (values?.has(g.value) ?? false);
      if (known) return [];
      return [
        {
          checkId: "payment-handle-unknown",
          severity: "high" as const,
          title: this.title,
          evidence: `${KIND_NAME[g.kind]} "${g.raw}" on ${onPages(g.paths)}${around(g)}, not configured`,
          url: page.finalUrl,
        },
      ];
    });
  },
});
