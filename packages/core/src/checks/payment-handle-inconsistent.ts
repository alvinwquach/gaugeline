import { defineCheck } from "../model.js";
import { HANDLE_KINDS, KIND_NAME } from "../payments/types.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";
import { groupPayments, paymentPages } from "./payments/common.js";

export const paymentHandleInconsistent = defineCheck<PageSnapshot>({
  id: "payment-handle-inconsistent",
  size: "S",
  done: "One handle is shown everywhere and is set in gaugeline.payments.json.",
  estimateChanges: "Handles typed into several pages are one edit each.",
  area: "Sales & prices",
  severity: "medium",
  title: "The site shows two different handles for one payment service",
  what: "With no payment details set, the pages checked show two or more different handles for the same service.",
  why: "At most one of them is right. Customers can't tell which, and some pay the other one.",
  fix: "Keep the right handle everywhere, and set it in gaugeline.payments.json so Gaugeline checks against it.",
  tech: "Only without gaugeline.payments.json: a Zelle, Cash App, Venmo or PayPal handle with more than one distinct value (compared case-insensitively; Zelle phones by digits) across the pages checked",
  async run(page, ctx) {
    if (ctx.payments) return [];
    const groups = groupPayments(await paymentPages(page, ctx));
    return HANDLE_KINDS.flatMap((kind) => {
      const of = groups.filter((g) => g.kind === kind);
      if (of.length < 2) return [];
      const values = of.map((g) => `"${g.raw}" on ${firstFew(g.paths)}`).join("; ");
      return [
        {
          checkId: "payment-handle-inconsistent",
          severity: "medium" as const,
          title: this.title,
          evidence: `${KIND_NAME[kind]} has ${of.length} values: ${values}`,
          url: page.finalUrl,
        },
      ];
    });
  },
});
