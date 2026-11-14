import type { PageSnapshot } from "../snapshot.js";

/** The six form providers Gaugeline recognises. */
export type FormProviderId =
  "pardot" | "salesforce-web-to-lead" | "hubspot" | "formstack" | "marketo" | "typeform";

/** A form with no recognised provider is still a sighting, so the http check can test it. */
export type SightingProvider = FormProviderId | "unknown";

/**
 * One place a form, or the code that draws one, appears in the HTML. `position` is the element's
 * index among every form, iframe and script element in the document (the snapshot's `position`).
 */
export type FormSighting = {
  provider: SightingProvider;
  kind: "form" | "iframe" | "embed-script";
  position: number;
  action?: string;
  src?: string;
  hiddenFields: string[];
};

export type FormProvider = {
  id: FormProviderId;
  label: string;
  /** The provider's sightings on the page, from the snapshot alone. Sends no request. */
  detect(s: PageSnapshot): FormSighting[];
  /** What the provider's tracking code looks like in a script src or an inline body. */
  trackingScript?: RegExp;
  /** Field names the provider maps by default, besides utm_* and gclid. */
  campaignFields: string[];
};
