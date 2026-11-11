import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findings, lateTracking } from "./forms.js";

export const crmLateTracking = defineCheck<PageSnapshot>({
  id: "crm-late-tracking",
  size: "S",
  done: "The tracking script loads in the page head before the form.",
  estimateChanges: "A tag manager that fires it late is a rule change, not a code change.",
  area: "Leads",
  severity: "medium",
  title: "Tracking starts after the form loads",
  what: "The service's tracking code comes after its form in the page, or waits for the page to finish loading while the form is an iframe that loads first.",
  why: "Salesforce documents that this can lose first-touch tracking, the referring site and UTM parameters.",
  fix: "Load the tracking script directly in the page head, before the form, not from a window load handler.",
  tech: 'Position of the tracking script after the form in document order (counted over every form, iframe and script element), or inline tracking code started by addEventListener("load"), attachEvent("onload") or window.onload while the form is an iframe; no timing is measured, and code a tag manager moves at run time is not seen',
  run(page, ctx) {
    return findings(this, lateTracking(page, ctx), page.finalUrl);
  },
});
