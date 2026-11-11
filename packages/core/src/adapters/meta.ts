import type { AdapterDescription } from "./types.js";

// What each built adapter says about itself, known without loading it (see registry.ts).

/**
 * Sanity asks for a token with the Viewer role (read only); a public dataset needs none. The page is
 * Gaugeline's own: it lists the endpoints used and how to make the token.
 */
export const SANITY_DESCRIPTION: AdapterDescription = {
  name: "Sanity",
  docsUrl: "https://gaugeline.dev/docs/private-datasets",
  keyKind: "read-only",
};

/**
 * The sitemap and feed adapter asks for no key: it reads the files a site already hands every visitor.
 * `keyKind` is "read-only" because nothing it does can change anything; `noKey` makes the run header
 * say there is no key at all.
 */
export const SITEMAP_FEED_DESCRIPTION: AdapterDescription = {
  name: "Sitemap and feeds",
  docsUrl: "https://gaugeline.dev/docs/integrations/sitemap-feed",
  keyKind: "read-only",
  noKey: true,
};

/**
 * The Wix adapter asks for no key: it reads what the live site publishes, the same files every visitor can
 * read. `keyKind` is "read-only" because nothing it does can change anything; `noKey` makes the run header say
 * there is no key at all. Wix does have a key that can be limited to read permissions (an API key with only
 * the Wix Data read permissions ticked), and docs/integrations/wix.md says how to make it; Gaugeline does not
 * ask for it yet, because the call that key is for is not one Gaugeline may send (see WIX_CMS_READ_PATH).
 */
export const WIX_DESCRIPTION: AdapterDescription = {
  name: "Wix",
  docsUrl: "https://gaugeline.dev/docs/integrations/wix",
  keyKind: "read-only",
  noKey: true,
};

/**
 * The Framer adapter is beta because Framer's own API is. It asks for no key: it reads what the live
 * site publishes, the same files every visitor can read. `keyKind` is "read-only" because nothing it
 * does can change anything; `noKey` makes the run header say there is no key at all.
 */
export const FRAMER_DESCRIPTION: AdapterDescription = {
  name: "Framer",
  docsUrl: "https://gaugeline.dev/docs/integrations/framer",
  keyKind: "read-only",
  noKey: true,
  beta: true,
};

/**
 * Webflow asks for a site token whose scopes are `sites:read` and `cms:read` and nothing else, so the
 * token can read and cannot change anything. The page is Gaugeline's own: it lists the endpoints used
 * and how to make the token.
 */
export const WEBFLOW_DESCRIPTION: AdapterDescription = {
  name: "Webflow",
  docsUrl: "https://gaugeline.dev/docs/integrations/webflow",
  keyKind: "read-only",
};

/**
 * WordPress asks for no key at all to read what is published: the REST API lists published posts, pages and
 * custom types to any visitor. A key is asked for only for drafts and members, and WordPress has no read-only
 * key: an application password acts with the role of the user it belongs to. So the narrowest key is an
 * application password on a dedicated user with the lowest role that does the job, and the kind is "scoped".
 */
export const WORDPRESS_DESCRIPTION: AdapterDescription = {
  name: "WordPress",
  docsUrl: "https://gaugeline.dev/docs/integrations/wordpress",
  keyKind: "scoped",
};

export const WORDPRESS_URL = "WORDPRESS_URL";
export const WORDPRESS_USER = "WORDPRESS_USER";
export const WORDPRESS_APP_PASSWORD = "WORDPRESS_APP_PASSWORD";

/** Every variable the WordPress adapter may read. Only the last two hold a key, and only for drafts and members. */
export const WORDPRESS_ENV_VARS = [WORDPRESS_URL, WORDPRESS_USER, WORDPRESS_APP_PASSWORD] as const;
