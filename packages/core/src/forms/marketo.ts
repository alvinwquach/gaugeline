import { sightingsFor } from "./evidence.js";
import type { FormProvider } from "./types.js";

/**
 * Marketo Forms 2.0. Evidence: a form action or iframe on marketo.com, the forms2 script under
 * /js/forms2/ on marketo.com, or an inline MktoForms2.loadForm call. Munchkin (munchkin.marketo.net)
 * is the tracking code, not a form.
 */
export const marketo: FormProvider = {
  id: "marketo",
  label: "Marketo",
  detect: (s) =>
    sightingsFor("marketo", s, {
      hosts: ["marketo.com"],
      scripts: [{ domain: "marketo.com", path: /^\/js\/forms2\// }],
      inline: [/\bMktoForms2\.(?:loadForm|whenReady|whenRendered)\b/],
    }),
  trackingScript: /munchkin(?:\.min)?\.js|\bMunchkin\.init\b/i,
  campaignFields: ["leadSource"],
};
