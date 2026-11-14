import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";
import { buyButtons, linksToPaymentPage, showsPrice } from "./paid-files.js";

/** How many buttons a line of evidence lists before it says "and N more". */
const SHOWN = 5;

export const checkoutJsOnly = defineCheck<PageSnapshot>({
  id: "checkout-js-only",
  size: "M",
  done: "The page has a real link or a form that posts to checkout, and the script only improves it.",
  estimateChanges:
    "A buy button built entirely by a script means rebuilding that button, and each product page that uses it.",
  area: "Sales & prices",
  severity: "medium",
  title: "Nothing on the page can be linked to buy",
  what: "A page shows a price and a buy button, but no button is a link with an address or a submit button in a form with an action.",
  why: "Nobody can share a link to the purchase, search engines see no offer, and if the script fails the page is a brochure.",
  fix: "Make the buy button a link to your checkout or payment link, or a submit button in a form that posts to your cart, and let the script improve it from there.",
  tech: "a price (a currency next to a number in the visible text, or an Offer price in the structured data) and at least one button or link whose text matches buy, add to cart, checkout, get it, purchase or download now; none is an a[href] with an address (not empty, #, javascript:, mailto: or tel:) or a submit button in a form with an action or its own formaction; a link to a hosted payment page (Stripe, Square, PayPal.me) anywhere on the page is a pass; the page is read as sent, so a button drawn by a script is not seen",
  run(page) {
    if (!isHtmlPage(page) || !showsPrice(page)) return [];
    const buttons = buyButtons(page);
    if (buttons.length === 0 || buttons.some((b) => b.linkable) || linksToPaymentPage(page))
      return [];
    const shown = buttons.slice(0, SHOWN).map((b) => `"${escapeInvisible(b.text, 40)}" (${b.how})`);
    const more = buttons.length > SHOWN ? ` and ${buttons.length - SHOWN} more` : "";
    const n = buttons.length;
    return [
      {
        checkId: "checkout-js-only",
        severity: "medium",
        title: this.title,
        evidence: `The page shows a price and ${n} buy button${n === 1 ? "" : "s"}, and none can be linked to: ${shown.join(", ")}${more}.`,
        url: page.finalUrl,
      },
    ];
  },
});
