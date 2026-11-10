import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findings, manyProviders } from "./forms.js";

export const formsManyProviders = defineCheck<PageSnapshot>({
  id: "forms-many-providers",
  area: "Leads",
  severity: "low",
  title: "Several form services on one page",
  what: "Forms or form scripts from more than one service (for example HubSpot and Typeform) are on the same page.",
  why: "Leads from one page end up in different places, and each service needs its own tracking, consent and follow-up.",
  fix: "Check that each form is meant to be there, and move the page to one service if you can.",
  tech: "Sightings of more than one of Pardot, Web-to-Lead, HubSpot, Formstack, Marketo and Typeform on one page (form action, iframe src, embed script); the tracking code alone is not a sighting",
  run(page) {
    return findings(this, manyProviders(page), page.finalUrl);
  },
});
