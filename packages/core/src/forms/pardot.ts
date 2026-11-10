import { sightingsFor } from "./evidence.js";
import type { FormProvider } from "./types.js";

/**
 * Pardot (now Marketing Cloud Account Engagement). A form handler posts to, and an iframe shows a
 * page on, go.pardot.com or another pardot.com host. The tracking script (pi.pardot.com/pd.js, or
 * the piAId variable that loads it) is on every page of a site, so it is a tracking pattern and not
 * a form sighting. A form handler on a company's own tracker domain cannot be told from any other
 * form: it is returned as unknown.
 */
export const pardot: FormProvider = {
  id: "pardot",
  label: "Pardot (Marketing Cloud Account Engagement)",
  detect: (s) => sightingsFor("pardot", s, { hosts: ["pardot.com"], scripts: [], inline: [] }),
  trackingScript: /\b(?:pi|cdn)\.pardot\.com\/pd\.js|\bpiAId\s*=/i,
  campaignFields: ["campaign_id"],
};
