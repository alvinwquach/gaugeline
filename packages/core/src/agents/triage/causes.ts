/**
 * The root causes the triage agent knows by name (AG-12). Several checks often report one mistake: eleven
 * framework checks all say "the preview address is in the canonical links", and fixing the one setting clears
 * them together. A cause is a short, fixed list of check ids; a check on no list is its own cause (see
 * plan.ts). This is a plain table, not a guess: the same findings give the same causes, and a test checks
 * that every id is a real check and in only one cause.
 *
 * Both Maps are built once. A Map from check id to cause answers "which cause?" in constant time for a
 * run's thousands of findings, and building it from the list makes a check named twice easy to refuse.
 */

export interface Cause {
  /** A short code, lower case with hyphens. It is the draft's identity for "already drafted". */
  readonly key: string;
  /** One plain line for a person, written here and never taken from a page. */
  readonly label: string;
  /**
   * An optional sentence the draft carries under the priority line. Written here, never taken from a page. A
   * cause Gaugeline can only infer from outside (a stale page, a webhook it cannot watch) says "likely" in its
   * label and in this note, and states nothing it cannot see as a fact.
   */
  readonly note?: string;
  readonly checks: readonly string[];
}

export const CAUSES: readonly Cause[] = [
  {
    key: "canonical-links",
    label: "Canonical links",
    checks: ["canonical-missing", "canonical-elsewhere"],
  },
  {
    key: "preview-canonical",
    label: "Preview address used in canonical links",
    checks: [
      "angular-preview-canonical",
      "astro-preview-canonical",
      "gatsby-preview-canonical",
      "headless-wp-preview-canonical",
      "hydrogen-preview-canonical",
      "next-preview-canonical",
      "nuxt-preview-canonical",
      "qwik-solid-preview-canonical",
      "remix-preview-canonical",
      "static-preview-canonical",
      "sveltekit-preview-canonical",
    ],
  },
  {
    key: "image-alt-text",
    label: "Images without alt text",
    checks: ["images-alt-missing", "images-alt-empty", "sanity-image-alt-unrendered"],
  },
  {
    key: "certificate",
    label: "Certificate problems",
    checks: ["certificate-expiring", "cert-name-mismatch"],
  },
  {
    key: "domain-registration",
    label: "Domain registration",
    checks: ["domain-expired", "domain-expires-soon"],
  },
  {
    key: "email-sender-records",
    label: "Email sender records",
    checks: ["email-spf-missing", "email-spf-multiple", "email-dmarc-missing", "email-dmarc-none"],
  },
  {
    key: "broken-links",
    label: "Broken links",
    checks: ["broken-links", "nav-link-not-200", "sitemap-dead"],
  },
  {
    key: "dev-tools-live",
    label: "Development tools left on the live site",
    checks: [
      "angular-dev-tools-public",
      "astro-dev-tools-public",
      "dev-tools-in-production",
      "gatsby-dev-server-live",
      "hydrogen-dev-tools-live",
      "nuxt-dev-build-live",
      "nuxt-devtools-public",
      "qwik-solid-dev-server-live",
      "remix-dev-tools-live",
      "static-dev-server-live",
      "sveltekit-dev-server-live",
    ],
  },
  {
    key: "draft-content-live",
    label: "Draft content reachable on the live site",
    checks: [
      "datocms-drafts-reachable",
      "drafts-live",
      "next-draft-public",
      "qwik-solid-draft-public",
      "remix-draft-public",
      "strapi-drafts-public",
      "sveltekit-draft-public",
    ],
  },
  // The four stale-content causes. Gaugeline reads a site from outside: it sees a page, its cache headers and
  // the code it is given, never the CMS's webhook log or the host's cache settings, so each of these is named a
  // likely cause and none is stated as found. A check id is in one cause only; the three one-check causes are
  // the owner's four causes spread over five checks (a webhook that clears draft ids belongs with the webhook).
  {
    key: "stale-no-revalidate",
    label: "Pages likely not refreshed when content is published",
    note: "Likely cause: these pages are saved copies that nothing refreshes when content is published, so an edit does not reach them until the copy is rebuilt. Gaugeline sees the page and when its content changed, not the site's settings, so this is likely, not certain.",
    checks: ["next-stale-after-publish"],
  },
  {
    key: "fetch-cache-time-and-tag",
    label: "Likely cached by time and by tag, so a publish is not seen",
    note: "Likely cause: a read is cached for a time and by a tag, so it also changes on a timer and a missed publish is hidden until the timer runs out. Gaugeline reads the code, not the live cache, so this is likely, not certain.",
    checks: ["revalidate-time-and-tag-mixed"],
  },
  {
    key: "publish-webhook-gap",
    label: "Publish webhook likely missing or clearing the wrong things",
    note: "Likely cause: a publish never reaches the live pages because the CMS webhook is missing, or clears the wrong things. Gaugeline reads the site from outside, so we cannot see whether the CMS called the site, so check the webhook's delivery log in the CMS.",
    checks: ["published-not-live", "webhook-purges-draft-ids"],
  },
  {
    key: "stacked-caches",
    label: "Likely two caches stacked: the CMS CDN and the app cache",
    note: "Likely cause: a read goes through the CMS's own CDN and then the app's cache, so a publish can be served from an older copy in either. Gaugeline reads the code, not the live caches, so this is likely, not certain.",
    checks: ["sanity-cdn-tagged-reads"],
  },
];

/** Check id to its named cause. A check on no list is absent. */
export const causeOfCheck: ReadonlyMap<string, Cause> = new Map(
  CAUSES.flatMap((c) => c.checks.map((id) => [id, c] as const)),
);
