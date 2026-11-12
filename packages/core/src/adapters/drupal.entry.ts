import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Drupal's JSON:API module serves published content to a visitor who is not logged in, so the adapter reads what is
 * published with no key at all. A credential (a bearer token, or a user name and password for Basic authentication)
 * is optional and is used for one thing only: listing unpublished nodes for the probing check, and only when the
 * settings and the owner's consent both say so. The credential belongs to a dedicated user whose role can only
 * view content; Drupal core has no read-only permission for unpublished content, so the docs page says what the
 * role needs. The page is Gaugeline's own.
 */
export const DRUPAL_DESCRIPTION: AdapterDescription = {
  name: "Drupal",
  docsUrl: "https://gaugeline.dev/docs/integrations/drupal",
  keyKind: "read-only",
  optionalKey: true,
};

export const DRUPAL_URL = "DRUPAL_URL";
export const DRUPAL_TOKEN = "DRUPAL_TOKEN";
export const DRUPAL_USER = "DRUPAL_USER";
export const DRUPAL_PASSWORD = "DRUPAL_PASSWORD";

/** Every variable the Drupal adapter may read. The token and the password are keys; the user name is not. */
export const DRUPAL_ENV_VARS = [DRUPAL_URL, DRUPAL_TOKEN, DRUPAL_USER, DRUPAL_PASSWORD] as const;

/** Drupal's own largest page (JSON:API's `page[limit]` is capped at 50 by the module). */
export const DRUPAL_PAGE_SIZE = 50;

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Drupal check quotes them and a check may not import the adapter module.
 */
export const DRUPAL_LIMITS = {
  /** Resources read from one type. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 5_000,
  /** Unpublished nodes listed for one type by the probing check. The rest are could-not-check, by count. */
  unpublishedPerType: 100,
  /** Node pages asked for in one run (one GET each). More are could-not-check, never skipped quietly. */
  pages: 100,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "drupal",
    name: "Drupal",
    status: "built",
    describe: DRUPAL_DESCRIPTION,
    envVars: DRUPAL_ENV_VARS,
    load: lazy("drupal", async () => {
      const { createDrupalAdapter } = await import("./drupal.js");
      return (c, settings) =>
        createDrupalAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    settings: { unpublishedRead: true },
    docs: {
      key: "none to read what is published; optional read-only (a token, or a user and password, of a dedicated user whose role can only view content) for the probing check on unpublished nodes",
      reads:
        "Content types you name, through JSON:API: counts, field counts, published nodes as fingerprints and, with consent, a credential and a settings entry, which unpublished nodes a visitor can open at /node/ID. [Endpoints and the credential](/docs/integrations/drupal)",
    },
    page: {
      slug: "integrations/drupal",
      title: "Drupal: content checks for sites built on Drupal",
    },
  },
];
