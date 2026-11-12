/**
 * Named sets of check ids: a different question asked of the same page, through the runner's
 * existing `only` filter. A preset may name a check from a later phase; the command skips ids that
 * aren't registered in this version and says so.
 */
export const LAUNCH_PRESET: readonly string[] = Object.freeze([
  "temp-host-links",
  "temp-host-canonical",
  "og-image-broken",
  "staging-indexable",
  "noindex",
  "robots-block",
  // A Stripe test key on the live site (G23b).
  "stripe-test-mode",
]);

/** The email record checks, added to the launch preset by --dns: mail records a DNS change would break. */
export const EMAIL_PRESET: readonly string[] = Object.freeze([
  "email-spf-missing",
  "email-spf-multiple",
  "email-dmarc-missing",
  "email-dmarc-none",
]);

/**
 * The listing checks: they compare Google, Yelp and Apple listings and social bio links with the
 * site, and run only when gaugeline.listings.json names a listing. They are not part of the launch
 * preset.
 */
export const LISTING_CHECKS: readonly string[] = Object.freeze([
  "listing-address-mismatch",
  "listing-hours-mismatch",
  "listing-name-mismatch",
  "listing-phone-mismatch",
  "listing-special-hours-missing",
  "listing-website-wrong",
]);

/**
 * The data assertion check: it runs the SELECTs in gaugeline.sources.json that must return no rows,
 * and only when the file has some. Without them it is not run (so not passed either), unless a
 * caller asked for it by id.
 */
export const ASSERTION_CHECKS: readonly string[] = Object.freeze(["data-assertion-failed"]);

/**
 * The switch, availability and capacity checks: they compare the site with the state in
 * gaugeline.switches.json, and run only when that file is there. Without it they are not run (so not
 * passed either), unless a caller asked for one by id: that one says it could not check.
 */
export const SWITCH_CHECKS: readonly string[] = Object.freeze([
  "switch-off-still-linked",
  "switch-page-wrong",
  "item-unavailable-shown",
  "capacity-zero-not-sold-out",
]);

/**
 * The data freshness checks: they compare the numbers and dates on a page with the limits in
 * gaugeline.freshness.json, and run only when that file is there. Without it they are not run (so
 * not passed either), unless a caller asked for one by id: that one says it could not check.
 */
export const FRESHNESS_CHECKS: readonly string[] = Object.freeze([
  "data-stale",
  "data-no-stamp",
  "data-behind-source",
  "forecast-for-past-event",
]);

/**
 * The CRM lead checks (X55): they read the lead object through the CRM's own read-only MCP server,
 * and run only when gaugeline.crm.json is there. Without it they are not run (so not passed either),
 * unless a caller asked for one by id: that one says it could not check.
 */
export const CRM_CHECKS: readonly string[] = Object.freeze([
  "crm-lead-source",
  "crm-field-names",
  "crm-went-quiet",
]);

/**
 * The probing checks (CLAUDE.md rule 14): they ask a gated route for what it protects, with no
 * credentials. Off by default; on with --owner-consent or gaugeline.consent.json. Without consent
 * they are not run (so not passed either), unless a caller asked for one by id: that one says it
 * did not ask.
 */
export const PROBING_CHECKS: readonly string[] = Object.freeze([
  "gated-download-open",
  "image-optimizer-open",
  "not-found-200",
  "nuxt-devtools-public",
  "nuxt-preview-public",
]);

/**
 * The content model checks: they compare a Sanity schema, its documents and the pages built from
 * them, and run only when gaugeline.model.json is there. Without it they are not run (so not passed
 * either), unless a caller asked for one by id: that one says it could not check.
 */
export const MODEL_CHECKS: readonly string[] = Object.freeze([
  "model-missing-required",
  "model-unexpanded",
  "model-listing-count",
  "model-dependents",
  "model-orphan-fields",
]);

/**
 * The Sanity image checks that read the dataset (the crop and hotspot set in Studio, the alt text, the
 * size of each upload): they run only when gaugeline.adapters.json names sanity, because they send the
 * Viewer token to Sanity. Without it they are not run (so not passed either), unless a caller asked for one
 * by id: that one says it could not check.
 */
export const SANITY_IMAGE_CHECKS: readonly string[] = Object.freeze([
  "sanity-image-alt-unrendered",
  "sanity-image-crop-ignored",
  "sanity-image-heavy",
]);
