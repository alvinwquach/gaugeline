import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findTestPublishableKeys } from "../connectors/stripe.js";
import { isTemporaryHost } from "./launch/hosts.js";
import { redact } from "./leaks/detectors.js";
import { isHtmlPage } from "./page.js";
import { shortUrl } from "./site-helpers.js";

export const stripeTestMode = defineCheck<PageSnapshot>({
  id: "stripe-test-mode",
  area: "Sales & prices",
  severity: "high",
  title: "This live site is using Stripe's test key",
  what: "The page, or a script on the same site, carries a Stripe test publishable key (it starts pk_test_) and the page is not on a hosting provider's preview address.",
  why: "A checkout built on a test key looks like it works and takes no real money: every order a customer places goes nowhere, and no card is charged.",
  fix: "In Stripe, switch to live mode, copy the live publishable key (pk_live_) and put it where the site reads its key, then redeploy and place one small real order to be sure.",
  tech: "The page's HTML and the same-site scripts already read by the leak check are searched for pk_test_ followed by at least 16 letters or digits, not inside a longer word; no new request is sent; pages on vercel.app, netlify.app and pages.dev are skipped",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const url = new URL(page.finalUrl);
    if (isTemporaryHost(url.hostname)) return [];
    const origin = url.origin;
    const sources: Array<{ where: string; text: string }> = [
      {
        where: `the HTML of ${shortUrl(page.finalUrl, origin)}`,
        text: page.hops.at(-1)?.body ?? "",
      },
      ...((await ctx.scripts?.()) ?? []).map((s) => ({
        where: shortUrl(s.url, origin),
        text: s.text,
      })),
    ];
    const seen = new Set<string>();
    return sources.flatMap(({ where, text }) =>
      findTestPublishableKeys(text).flatMap((key) => {
        const id = `${where}\n${key}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [
          {
            checkId: "stripe-test-mode",
            severity: "high" as const,
            title: this.title,
            // Only the start and end of the key, as for every key the leak check names.
            evidence: `Stripe test key ${redact(key)} in ${where}`,
            url: page.finalUrl,
          },
        ];
      }),
    );
  },
});
