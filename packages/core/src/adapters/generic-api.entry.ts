import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * The generic adapter reads whatever a headless CMS's read API says, from a mapping in the settings. Its key kind
 * is the narrowest the platform offers, which only the platform's recipe can say (a read-only role's static token,
 * a delivery token): `scoped` is what it claims, and each recipe names the actual key.
 */
export const GENERIC_API_DESCRIPTION: AdapterDescription = {
  name: "Any headless CMS with a read API",
  docsUrl: "https://gaugeline.dev/docs/integrations/generic-api",
  keyKind: "scoped",
};

export const entries: readonly AdapterEntry[] = [
  {
    id: "generic-api",
    name: "Any headless CMS with a read API",
    status: "built",
    describe: GENERIC_API_DESCRIPTION,
    // No `envVars`: the variable is named by the mapping (`GAUGELINE_API_<NAME>`), so the CLI copies the ones that
    // match GENERIC_ENV (generic-api-config.ts) from its own environment.
    load: lazy("generic-api", async () => {
      const { createGenericApiAdapter } = await import("./generic-api.js");
      return (c, settings) =>
        createGenericApiAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    docs: {
      key: "scoped (the narrowest key the platform offers; each recipe says which)",
      reads:
        "Items from a REST or GraphQL read API through a mapping in settings: type names and counts, field counts, published items as fingerprints. [Mapping and recipes](/docs/integrations/generic-api) for Storyblok, Payload, Ghost, Drupal JSON:API, Directus, Prismic, Hygraph, DatoCMS, Builder.io, Kontent.ai and Joomla",
    },
    page: {
      slug: "integrations/generic-api",
      title: "Generic API adapter: content checks for any headless CMS with a read API",
    },
  },
];
