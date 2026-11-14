import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

export const WORDPRESS_URL = "WORDPRESS_URL";
export const WORDPRESS_USER = "WORDPRESS_USER";
export const WORDPRESS_APP_PASSWORD = "WORDPRESS_APP_PASSWORD";

/** Every variable the WordPress adapter may read. Only the last two hold a key, and only for drafts and members. */
export const WORDPRESS_ENV_VARS = [WORDPRESS_URL, WORDPRESS_USER, WORDPRESS_APP_PASSWORD] as const;

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

export const entries: readonly AdapterEntry[] = [
  {
    id: "wordpress",
    name: "WordPress",
    status: "built",
    describe: WORDPRESS_DESCRIPTION,
    envVars: WORDPRESS_ENV_VARS,
    detect: {
      generator: ["wordpress"],
      paths: ["/wp-content/", "/wp-includes/"],
      headers: { link: "api.w.org" },
    },
    load: lazy("wordpress", async () => {
      const { createWordPressAdapter } = await import("./wordpress.js");
      return (c, settings) =>
        createWordPressAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "scoped (an application password on a dedicated low-role user, for drafts and members only; published content needs no key)",
      reads:
        "Published posts, pages and custom types through the REST API: type names and counts, how many items have each field, published items as fingerprints, whether drafts are reachable, who has access; and two checks, `wp-outdated` and `wp-users-exposed`, with `--wordpress`. [WordPress](wordpress.md)",
    },
    page: {
      slug: "integrations/wordpress",
      title: "WordPress: what the client published, against the page",
    },
  },
];
