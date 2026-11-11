import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findings, noTracking } from "./forms.js";

export const crmNoTracking = defineCheck<PageSnapshot>({
  id: "crm-no-tracking",
  size: "M",
  done: "The tracking code is on every page that has the form, and a test lead shows where it came from in the CRM.",
  estimateChanges:
    "Pages built from several templates each need the snippet. A cookie banner that blocks the script adds setup.",
  area: "Leads",
  severity: "high",
  title: "Leads from this form arrive without where they came from",
  what: "A form from Pardot, HubSpot or Marketo is on the page, but that service's tracking code is not.",
  why: "The service can't connect a new lead to the ad, email or search that brought them.",
  fix: "Add the service's tracking code to every page that has its form (for Pardot: Account Engagement Settings, Domain Management, Tracking Code Generator).",
  tech: "A form or iframe of Pardot, HubSpot or Marketo in the HTML, and no script of that service's tracking code anywhere in it (pi.pardot.com/pd.js or piAId, js.hs-scripts.com or _hsq, munchkin.js or Munchkin.init); Web-to-Lead, Formstack and Typeform have no tracking script and are skipped; a form drawn by JavaScript is could-not-check; code a tag manager adds at run time is not seen",
  run(page, ctx) {
    return findings(this, noTracking(page, ctx), page.finalUrl);
  },
});
