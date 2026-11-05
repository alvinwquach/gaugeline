import { defineCheck } from "../model.js";
import { probe } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus, firstFew } from "./site-helpers.js";

const PAYMENT_HOST = /^(?:www\.)?(?:cash\.app|venmo\.com)$/i;

export const factsPaymentLink = defineCheck<PageSnapshot>({
  id: "facts-payment-link",
  area: "Sales & prices",
  severity: "high",
  title: "A payment link goes nowhere",
  what: "A Cash App or Venmo link on the site answers with an error: the profile it names doesn't exist.",
  why: "Customers who tap Pay land on an error, or worse, find a look-alike profile and pay a stranger.",
  fix: "Correct the handle in the link, and check it by opening the link on a phone.",
  tech: "cash.app/$handle and venmo.com/(u/)handle links on the pages checked are requested (HEAD, then GET on 405/501) and answer 4xx or 5xx; at most 5, and only the address the page names is sent (ADR-0004)",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget) return [];
    const fetcher = ctx.fetcher;
    // With declared facts, the pages they are checked on; otherwise only this page (no extra requests).
    const pages = ctx.facts ? ((await ctx.pages?.()) ?? [page]) : [page];
    const links = new Map<string, string>();
    for (const p of pages) {
      for (const l of p.links) {
        try {
          if (PAYMENT_HOST.test(new URL(l.href).hostname) && !links.has(l.href))
            links.set(l.href, new URL(p.finalUrl).pathname);
        } catch {
          // not an address
        }
      }
    }
    const taken = ctx.budget.take("paymentLinks", [...links.keys()]);
    const hops = await Promise.all(taken.map((u) => probe(u, fetcher)));
    const dead = taken.flatMap((u, i) => {
      const status = finalStatus(hops[i] ?? []);
      return status !== undefined && status >= 400
        ? [`${u} on ${links.get(u) ?? "/"} returned ${status}`]
        : [];
    });
    if (dead.length === 0) return [];
    return [
      {
        checkId: "facts-payment-link",
        severity: "high",
        title: this.title,
        evidence: firstFew(dead),
        url: page.finalUrl,
      },
    ];
  },
});
