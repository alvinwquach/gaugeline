import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { readRedirectLeaks } from "./form-redirect-shared.js";
import { findings } from "./forms.js";
import { isHtmlPage } from "./page.js";

/**
 * A lead-path leak, read from the page's own HTML: a form whose action, or whose thank-you field (retURL,
 * redirect_to, next, success_url...), is an address with an email or a phone number in its query string or
 * fragment, or is one. It makes no request beyond the page already fetched, never submits a form and never
 * follows a thank-you address. What only a submit would show is could-not-check, never a pass.
 */
// [GC] no source found (uncited): the Referer header, analytics page URLs and server logs carry the full
// address of a page, query string included. [docs] MDN Referer header, Referrer-Policy and the URL's search
// and hash: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referer
export const formRedirectLeaksDetails = defineCheck<PageSnapshot>({
  id: "form-redirect-leaks-details",
  size: "S",
  done: "No form's action or thank-you address has an email address or a phone number in its query string or fragment, and none of its thank-you fields is one.",
  estimateChanges:
    "A form service's thank-you setting is a quick change; a thank-you page built in code from the submitted values needs a code change, and each form with the same pattern adds to it.",
  area: "Leads",
  severity: "medium",
  title: "A form's thank-you address carries an email or phone number",
  what: "A form's action, or the field that says where to send visitors after they submit (retURL, redirect_to, next, success_url and the like), is an address with an email address or a phone number in its query string or after the #, or is one.",
  why: "An address is not private. It is copied into the browser's history, the website's logs, the Referer header sent to the next site and every analytics tool on the page, so a visitor's email or phone number reaches companies and people the form never mentioned.",
  fix: "Send visitors to a fixed thank-you address with nothing personal in it. A developer who builds the form stops adding the submitted values to the address and keeps them in a session or on the server. When the form provider builds the address (a Salesforce retURL, a HubSpot or Marketo redirect), whoever runs the provider's settings removes the merge field from the redirect there.",
  tech: "reads the page's own HTML only, with no further request: each form's action when it is a web address of its own, and the value of every input named retURL, redirect, redirect_to, redirectUrl, return, returnUrl, return_to, next, _next, thanks, thankyou, success_url, successUrl, goto, destination or continue (case, underscores and hyphens ignored); a relative address is resolved against the page; the query string and fragment are read as parameters (two addresses deep at most, 50 parameters, 2,000 characters) and a value that holds an email-shaped or phone-shaped detail, or a field whose whole value is one, is a finding; the line names the parameter and masks every value, never the detail; a form with no action of its own (none, #, javascript:) and no thank-you field, a recognised embedded form (another document), a form drawn by script, and an email or phone parameter with no value (filled when the form is submitted) are could-not-check, because Gaugeline never submits a form",
  run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const { hits, unseen } = readRedirectLeaks(page);
    for (const reason of unseen) ctx.couldNotCheck?.(page.finalUrl, reason);
    return findings(this, hits, page.finalUrl);
  },
});
