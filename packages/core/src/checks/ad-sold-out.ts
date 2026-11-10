import { adsLine, shown } from "../ads/landing.js";
import { defineCheck, type Finding } from "../model.js";
import type { AdPagesInput } from "./ad-dead-page.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const TITLE = "The advertised product is sold out";
const NOTE_TITLE = "Some options of the advertised product are sold out";

/** Names from the shop, escaped and cut, the first few of them. */
function names(list: readonly string[], n = 5): string {
  const first = list.slice(0, n).map((x) => escapeInvisible(x, 40));
  return list.length > n ? `${first.join(", ")} and ${list.length - n} more` : first.join(", ");
}

export const adSoldOut = defineCheck<AdPagesInput>({
  id: "ad-sold-out",
  area: "Sales & prices",
  severity: "high",
  title: TITLE,
  what: "An ad sends people to a Shopify product page where every variant is sold out.",
  why: "Each click is paid for by someone who wants to buy and cannot, so the money buys nothing until the product is back.",
  fix: "Pause the ad or point it at a product that is in stock, and turn it back on when the product returns. If some sizes are out, say so in the ad.",
  tech: "a landing page is a Shopify product page when its address ends /products/<handle> and its HTML carries Shopify's markers (cdn.shopify.com, window.Shopify, the checkout or digital-wallet meta tags); one GET of /products/<handle>.js on the same host, no key; sold out means every variant says available false (high); some variants out is a low note listing them; an empty variants list, an answer that is not that JSON, a 404, or a variant that does not say is could-not-check (stock could not be read), never sold out; a page that is not on Shopify is not asked",
  run: (input, ctx) => {
    const findings: Finding[] = [];
    for (const probe of input.probes) {
      const read = input.stock.get(probe.url);
      if (read === undefined) continue;
      if (read.kind === "unreadable") {
        ctx.couldNotCheck?.(probe.url, `stock could not be read: ${read.why}`);
        continue;
      }
      const a = read.availability;
      const product = escapeInvisible(read.handle, 60);
      if (a.kind === "sold-out")
        findings.push({
          checkId: "ad-sold-out",
          severity: "high",
          title: TITLE,
          evidence: `${
            a.variants === 1
              ? `The only variant of ${product} is sold out`
              : `All ${a.variants} variants of ${product} are sold out (${names(a.names)})`
          }, so nobody who clicks an ad that links to ${shown(probe.url)} can buy it. ${adsLine(probe)}`,
          url: probe.url,
        });
      else if (a.kind === "partial")
        findings.push({
          checkId: "ad-sold-out",
          severity: "low",
          title: NOTE_TITLE,
          evidence: `${a.unavailable.length} of ${a.variants} variants of ${product} are sold out: ${names(a.unavailable)}. The rest can still be bought. ${adsLine(probe)}`,
          url: probe.url,
        });
    }
    return findings;
  },
});
