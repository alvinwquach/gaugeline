import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findings, insecure } from "./forms.js";

export const crmInsecure = defineCheck<PageSnapshot>({
  id: "crm-insecure",
  area: "Leads",
  severity: "high",
  title: "A form sends details over an insecure connection",
  what: "A form, its iframe, its embed script or its tracking script loads over plain http on an https page.",
  why: "Browsers may block it on a secure page, and what people type isn't encrypted.",
  fix: "Use https for the form, the tracker domain and the tracking script (pd.js for Pardot).",
  tech: "http:// in a form action, a recognised iframe src, an embed script src or a tracking script src on an https page; the code inside an inline script is not read",
  run(page) {
    return findings(this, insecure(page), page.finalUrl);
  },
});
