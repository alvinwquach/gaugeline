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
