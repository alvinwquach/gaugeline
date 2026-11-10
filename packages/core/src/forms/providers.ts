import type { PageSnapshot } from "../snapshot.js";
import { formstack } from "./formstack.js";
import { hubspot } from "./hubspot.js";
import { marketo } from "./marketo.js";
import { pardot } from "./pardot.js";
import { salesforceWebToLead } from "./salesforce-web-to-lead.js";
import { typeform } from "./typeform.js";
import type { FormProvider, FormProviderId, FormSighting } from "./types.js";

export type { FormProvider, FormProviderId, FormSighting, SightingProvider } from "./types.js";

/** Six records, one small file each. Adding a seventh is one file, one test table and one line here. */
export const PROVIDERS: readonly FormProvider[] = [
  pardot,
  salesforceWebToLead,
  hubspot,
  formstack,
  marketo,
  typeform,
];

export const FORM_PROVIDER_IDS: readonly FormProviderId[] = PROVIDERS.map((p) => p.id);

/** The note a page gets when an embed script is there but its form is not in the HTML. */
export const FORM_JS_NOTE = "forms may be added by JavaScript";

/**
 * Every form, iframe and embed script of the six providers on the page, and every other form as
 * provider "unknown", sorted by position in the document. Reads the snapshot only; sends nothing.
 * Elements are not merged: the same embed twice is two sightings, and the usual HubSpot snippet (the
 * loader script and the create call) is two script elements, so two sightings.
 */
export function detectForms(s: PageSnapshot): FormSighting[] {
  const known = PROVIDERS.flatMap((p) => p.detect(s));
  const knownForms = new Set(known.filter((x) => x.kind === "form").map((x) => x.position));
  const unknown: FormSighting[] = [];
  for (const [i, f] of s.forms.entries()) {
    const position = f.position ?? i;
    if (knownForms.has(position)) continue;
    unknown.push({
      provider: "unknown",
      kind: "form",
      position,
      ...(f.action === undefined ? {} : { action: f.action }),
      hiddenFields: [...f.hiddenFields],
    });
  }
  return [...known, ...unknown].sort((a, b) => a.position - b.position);
}

/**
 * Notes about what detection could not see. One note, FORM_JS_NOTE, when a provider's embed script
 * is on the page and the HTML holds no form or iframe of that provider: the form is probably drawn
 * by JavaScript after the page loads, which Gaugeline does not run.
 */
export function formNotes(s: PageSnapshot): string[] {
  const sightings = detectForms(s);
  const drawn = new Set(sightings.filter((x) => x.kind !== "embed-script").map((x) => x.provider));
  const lonely = sightings.some((x) => x.kind === "embed-script" && !drawn.has(x.provider));
  return lonely ? [FORM_JS_NOTE] : [];
}
