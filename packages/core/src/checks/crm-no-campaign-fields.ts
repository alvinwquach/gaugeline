import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findings, noCampaignFields } from "./forms.js";

export const crmNoCampaignFields = defineCheck<PageSnapshot>({
  id: "crm-no-campaign-fields",
  size: "S",
  done: "The form has hidden utm_source, utm_medium, utm_campaign and gclid fields, filled from the address and mapped in the handler.",
  estimateChanges: "Several forms and a handler that needs a code change each add to it.",
  area: "Leads",
  severity: "medium",
  title: "A form has nowhere to put campaign details",
  what: "A form posts leads straight to Pardot, Web-to-Lead, HubSpot or Marketo with no hidden campaign fields.",
  why: "Every lead arrives with its campaign, source and ad click blank.",
  fix: "Add hidden utm_source, utm_medium, utm_campaign and gclid fields, fill them from the address, and map them in the form handler.",
  tech: "A form element posting to Pardot, Web-to-Lead, HubSpot or Marketo with no hidden input named utm_*, gclid, a lead source or that service's default mapped field; a visible input does not count; an iframe is another document and is could-not-check",
  run(page, ctx) {
    return findings(this, noCampaignFields(page, ctx), page.finalUrl);
  },
});
