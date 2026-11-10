import { sightingsFor } from "./evidence.js";
import type { FormProvider } from "./types.js";

/**
 * HubSpot forms. Evidence: a form action on hsforms.com, hsforms.net or forms.hubspot.com; an
 * iframe on the same hosts (share.hsforms.com); the forms embed script on js.hsforms.net; or an
 * inline hbspt.forms.create call. js.hs-scripts.com is HubSpot's tracking code and is not a form.
 */
export const hubspot: FormProvider = {
  id: "hubspot",
  label: "HubSpot",
  detect: (s) =>
    sightingsFor("hubspot", s, {
      hosts: ["hsforms.com", "hsforms.net", "forms.hubspot.com"],
      scripts: [{ domain: "hsforms.net", path: /^\/forms\// }],
      inline: [/\bhbspt\.forms\.create\s*\(/],
    }),
  trackingScript: /js\.hs-scripts\.com\/\d+\.js|js\.hs-analytics\.net\/analytics|\b_hsq\b/i,
  campaignFields: ["hs_context"],
};
