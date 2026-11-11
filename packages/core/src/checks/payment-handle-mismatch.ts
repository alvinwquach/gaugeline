import { defineCheck } from "../model.js";
import { HANDLE_KINDS, KIND_NAME, type HandleKind } from "../payments/types.js";
import type { PageSnapshot } from "../snapshot.js";
import { around, configured, groupPayments, onPages, paymentPages } from "./payments/common.js";

const HANDLES: ReadonlySet<string> = new Set(HANDLE_KINDS);

export const paymentHandleMismatch = defineCheck<PageSnapshot>({
  id: "payment-handle-mismatch",
  size: "S",
  done: "The handle is correct everywhere and opens your payment page on a phone.",
  estimateChanges:
    "One shared footer or CMS field is one edit. Handles typed into many pages are one edit each.",
  area: "Sales & prices",
  severity: "high",
  title: "A payment handle differs from yours",
  what: "A page shows a Zelle, Cash App, Venmo or PayPal handle that is not the one you set for that service.",
  why: "Customers who copy it send their money to someone else, and nobody finds out until you ask where the money went.",
  fix: "Correct the handle where it is written (usually one shared footer or CMS field), then open it on a phone to check it is yours.",
  tech: "Handles read from links, visible text, image descriptions and aria-labels (text handles only within 40 characters of the provider's name, in the same sentence) on the pages checked, compared case-insensitively with gaugeline.payments.json; Zelle phone numbers by their digits",
  async run(page, ctx) {
    if (!ctx.payments) return [];
    const mine = configured(ctx.payments);
    const groups = groupPayments(await paymentPages(page, ctx));
    return groups.flatMap((g) => {
      const values = mine.get(g.kind);
      if (!HANDLES.has(g.kind) || !values || values.has(g.value)) return [];
      const want = [...values.values()].map((v) => `"${v}"`).join(" or ");
      return [
        {
          checkId: "payment-handle-mismatch",
          severity: "high" as const,
          title: this.title,
          evidence: `${KIND_NAME[g.kind as HandleKind]} "${g.raw}" on ${onPages(g.paths)}${around(g)}; configured ${want}`,
          url: page.finalUrl,
        },
      ];
    });
  },
});
