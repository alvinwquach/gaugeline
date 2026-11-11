import { defineCheck } from "../model.js";
import { getOrNull } from "../probe.js";
import { KIND_NAME, type PaymentKind } from "../payments/types.js";
import type { PageSnapshot } from "../snapshot.js";
import { groupPayments, onPages, paymentPages } from "./payments/common.js";

/**
 * What a provider's page says when a payment link has been turned off, matched case-insensitively
 * in the page's text. Kept short on purpose: each phrase is a provider's own wording.
 */
export const INACTIVE_PHRASES: Readonly<Record<"square-link" | "stripe-link", readonly string[]>> =
  Object.freeze({
    "square-link": ["This link is no longer active", "This checkout link is no longer available"],
    "stripe-link": ["This link is no longer active", "This link has been deactivated"],
  });

/** Gone for good. A 5xx can be a bad minute at the provider, so it is not called dead. */
const GONE: ReadonlySet<number> = new Set([404, 410]);

function pageText(body: string): string {
  return body
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|\s+/g, " ")
    .toLowerCase();
}

export const paymentLinkDead = defineCheck<PageSnapshot>({
  id: "payment-link-dead",
  size: "S",
  done: "The new payment link works on a phone and the old one appears nowhere on the site.",
  estimateChanges:
    "One link used in many places is one edit. Links in emails and printed material are out of reach from here.",
  area: "Sales & prices",
  severity: "high",
  title: "A payment link no longer works",
  what: "A Square or Stripe payment link on the site answers 404, or shows the provider's page for a link that has been turned off.",
  why: "Customers who are ready to pay hit a dead end, and most of them don't come back to try another way.",
  fix: "Make a new payment link in Square or Stripe and replace the old one everywhere it appears.",
  tech: "square.link, checkout.square.site and buy.stripe.com links on the pages checked, requested once each with GET (nothing is submitted), at most 5: dead on 404 or 410, or a 2xx page with the provider's inactive-link wording",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget) return [];
    const fetcher = ctx.fetcher;
    const links = groupPayments(await paymentPages(page, ctx)).filter(
      (g) => g.kind === "square-link" || g.kind === "stripe-link",
    );
    const taken = ctx.budget.take("checkoutLinks", links);
    const answers = await Promise.all(taken.map((g) => getOrNull(fetcher, g.value)));
    return taken.flatMap((g, i) => {
      const last = answers[i]?.at(-1);
      if (!last) return [];
      let what: string | undefined;
      if (GONE.has(last.status)) what = `returned ${last.status}`;
      else if (last.status >= 200 && last.status < 300) {
        const text = pageText(last.body ?? "");
        const phrase = INACTIVE_PHRASES[g.kind as "square-link" | "stripe-link"].find((p) =>
          text.includes(p.toLowerCase()),
        );
        if (phrase) what = `says "${phrase}"`;
      }
      if (!what) return [];
      return [
        {
          checkId: "payment-link-dead",
          severity: "high" as const,
          title: this.title,
          evidence: `${KIND_NAME[g.kind as PaymentKind]} ${g.value} on ${onPages(g.paths)} ${what}`,
          url: page.finalUrl,
        },
      ];
    });
  },
});
