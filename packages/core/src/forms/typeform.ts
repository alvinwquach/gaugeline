import { sightingsFor } from "./evidence.js";
import type { FormProvider } from "./types.js";

/**
 * Typeform. Evidence: an iframe on typeform.com (form.typeform.com/to/..., or an account
 * subdomain), a form action on typeform.com, the embed script on embed.typeform.com, or an inline
 * tf.createWidget or typeformEmbed.make... call. A link to a typeform is not evidence.
 */
export const typeform: FormProvider = {
  id: "typeform",
  label: "Typeform",
  detect: (s) =>
    sightingsFor("typeform", s, {
      hosts: ["typeform.com"],
      scripts: [{ domain: "typeform.com", path: /^\/(?:next\/)?embed\.js$|^\/embed\// }],
      inline: [/\btf\.createWidget\s*\(/, /\btypeformEmbed\.make[A-Za-z]*\s*\(/],
    }),
  campaignFields: [],
};
