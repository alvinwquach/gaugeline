import { sightingsFor } from "./evidence.js";
import type { FormProvider } from "./types.js";

/**
 * Salesforce Web-to-Lead. The form posts to the WebToLead servlet on webto.salesforce.com (or
 * test.salesforce.com for a sandbox). The path is part of the evidence because salesforce.com
 * hosts much more than this. There is no iframe or embed script: the form is plain HTML.
 */
export const salesforceWebToLead: FormProvider = {
  id: "salesforce-web-to-lead",
  label: "Salesforce Web-to-Lead",
  detect: (s) =>
    sightingsFor("salesforce-web-to-lead", s, {
      hosts: ["salesforce.com"],
      actionPath: /\/servlet\/servlet\.webtolead\/?$/,
      scripts: [],
      inline: [],
    }),
  campaignFields: ["lead_source", "Campaign_ID"],
};
