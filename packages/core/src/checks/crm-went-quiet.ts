import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { crmPart, day, formProvidersOnPage, joined } from "./crm-shared.js";

/** Fewer leads than this over the lookback and a quiet spell proves nothing. */
export const MIN_BASELINE_LEADS = 5;
const DAY = 86_400_000;

export const crmWentQuiet = defineCheck<PageSnapshot>({
  id: "crm-went-quiet",
  size: "M",
  done: "A test lead sent through the form reaches the CRM, and real leads arrive again.",
  estimateChanges:
    "The break may be in the form, the connection or a rule inside the CRM, and finding which is most of the work.",
  area: "Leads",
  severity: "high",
  title: "Leads have stopped arriving",
  what: "The CRM was getting new leads every few days, and none has been created for several days, while the form is still on the page.",
  why: "A form can load, accept the visitor's details and thank them while the lead goes nowhere: a changed field, an expired integration user, a full queue. Nobody sees it until the phone stays quiet.",
  fix: "Submit the form yourself with a test lead (your own, in a sandbox if you have one), see whether it reaches the CRM, and check the form's connection to Salesforce and the integration user's access.",
  tech: "Through Salesforce's read-only MCP server (soqlQuery on Lead: COUNT and MAX(CreatedDate) since 14 days ago, or four times quietDays if longer): no lead created for quietDays whole days (default 3) after at least 5 in the lookback, on a page that has a form or embed from Pardot, Web-to-Lead, HubSpot, Formstack, Marketo or Typeform; a page with no recognised form, or too few leads to call it quiet, is could-not-check",
  async run(page, ctx) {
    const read = await crmPart(page, ctx, "window");
    const window = read?.window;
    if (!read || !window) return [];
    const providers = formProvidersOnPage(page);
    if (providers.length === 0) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "No recognised form is on this page, so Gaugeline can't tell whether leads stopped because the form did. Check a page that has the form.",
      );
      return [];
    }
    const now = (ctx.now?.() ?? new Date()).getTime();
    const { count, days, quietDays: limit } = window;
    if (count.total < MIN_BASELINE_LEADS || !count.latest) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        `Only ${count.total} lead${count.total === 1 ? "" : "s"} in the last ${days} days, too few to say leads went quiet.`,
      );
      return [];
    }
    const quiet = Math.floor((now - count.latest.getTime()) / DAY);
    if (quiet < limit) return [];
    const rate = Math.round((count.total / days) * 10) / 10;
    return [
      {
        checkId: "crm-went-quiet",
        severity: "high",
        title: this.title,
        evidence: `No lead has been created for ${quiet} days (the last was on ${day(count.latest)}); ${count.total} came in over the last ${days} days, about ${rate} a day. A ${joined(providers)} form is still on the page`,
        url: page.finalUrl,
      },
    ];
  },
});
