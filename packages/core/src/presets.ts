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
  // A Stripe test key on the live site (G23): skipped until that check ships.
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
