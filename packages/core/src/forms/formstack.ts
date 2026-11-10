import { sightingsFor } from "./evidence.js";
import type { FormProvider } from "./types.js";

/**
 * Formstack. Evidence: a form action or an iframe on formstack.com (an account subdomain such as
 * baybakery.formstack.com counts), or the form's script, /forms/js.php, on the same domain.
 */
export const formstack: FormProvider = {
  id: "formstack",
  label: "Formstack",
  detect: (s) =>
    sightingsFor("formstack", s, {
      hosts: ["formstack.com"],
      scripts: [{ domain: "formstack.com", path: /^\/forms\/js\.php(?:\/|$)/ }],
      inline: [],
    }),
  campaignFields: [],
};
