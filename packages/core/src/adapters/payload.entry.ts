import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Payload gives a user of an auth collection an API key, and what that key may read is whatever the collection's
 * access rules allow that user. Gaugeline asks for a key on a user whose access is read-only: no create, update or
 * delete on any collection. Payload has no key type that is read-only by itself, so the narrowing is the user's,
 * and the docs page says how to make it. The page is Gaugeline's own.
 */
export const PAYLOAD_DESCRIPTION: AdapterDescription = {
  name: "Payload",
  docsUrl: "https://gaugeline.dev/docs/integrations/payload",
  keyKind: "read-only",
};

export const PAYLOAD_URL = "PAYLOAD_URL";
export const PAYLOAD_API_KEY = "PAYLOAD_API_KEY";

/** Every variable the Payload adapter may read. Only the API key is a key. */
export const PAYLOAD_ENV_VARS = [PAYLOAD_URL, PAYLOAD_API_KEY] as const;

/** Documents asked for in one request. */
export const PAYLOAD_PAGE_SIZE = 100;

/** The auth collection whose API key is used when the settings do not say (Payload's own starter template names it this). */
export const PAYLOAD_DEFAULT_AUTH_COLLECTION = "users";

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Payload check quotes them and a check may not import the adapter module.
 */
export const PAYLOAD_LIMITS = {
  /** Documents read from one collection. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "payload",
    name: "Payload",
    status: "built",
    describe: PAYLOAD_DESCRIPTION,
    envVars: PAYLOAD_ENV_VARS,
    load: lazy("payload", async () => {
      const { createPayloadAdapter } = await import("./payload.js");
      return (c, settings) =>
        createPayloadAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    settings: { privateCollections: true, authCollection: true },
    docs: {
      key: "read-only (an API key on a user whose access rules only allow reading the collections you name)",
      reads:
        "Collections you name, through the REST API: counts, field counts, published documents as fingerprints, whether unpublished work is reachable, and (with consent) collections you mark private that a visitor with no key can read. [Endpoints and the key](/docs/integrations/payload)",
    },
    page: {
      slug: "integrations/payload",
      title: "Payload: content checks for sites built on Payload",
    },
  },
];
