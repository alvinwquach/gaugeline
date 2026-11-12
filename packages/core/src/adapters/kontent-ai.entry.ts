import type { AdapterDescription } from "./types.js";
import type { AdapterEntry } from "./entry.js";
import { lazy } from "./load.js";

/**
 * Kontent.ai's Delivery API answers for published content with no key, and with a "secure access" key when the
 * project turned that on. Gaugeline asks for the narrowest key there is: none for a public project, and a secure
 * access key (it can only read what is published) for a secured one. The key goes in an `Authorization: Bearer`
 * header and never in an address. The Preview API reads unpublished content with its own key, so it is used only by the
 * one probing check, only with `readPreview` in the settings and --owner-consent. The page is Gaugeline's own.
 */
export const KONTENT_DESCRIPTION: AdapterDescription = {
  name: "Kontent.ai",
  docsUrl: "https://gaugeline.dev/docs/integrations/kontent-ai",
  keyKind: "read-only",
  optionalKey: true,
};

/** The environment's id (a UUID), from Environment settings, API keys in Kontent.ai. It names the project and is not a key. */
export const KONTENT_ENVIRONMENT_ID = "KONTENT_ENVIRONMENT_ID";
/** A Delivery API secure access key. Optional: a project that did not turn secure access on needs none. Sent as a header only. */
export const KONTENT_SECURE_ACCESS_KEY = "KONTENT_SECURE_ACCESS_KEY";
/** A Preview API key. Used only by the probing check, never for a published read. Sent as a header only, to the Preview host only. */
export const KONTENT_PREVIEW_API_KEY = "KONTENT_PREVIEW_API_KEY";

/** Every variable the Kontent.ai adapter may read. The last two are keys. */
export const KONTENT_ENV_VARS = [
  KONTENT_ENVIRONMENT_ID,
  KONTENT_SECURE_ACCESS_KEY,
  KONTENT_PREVIEW_API_KEY,
] as const;

/** The two hosts the adapter ever asks. They are fixed: nothing from the environment or from an answer chooses a host. */
export const KONTENT_DELIVERY_HOST = "deliver.kontent.ai";
export const KONTENT_PREVIEW_HOST = "preview-deliver.kontent.ai";

/** Items asked for in one request. */
export const KONTENT_PAGE_SIZE = 100;

/** The element that holds an item's slug when the settings do not say (the codename of Kontent.ai's URL slug element in its starter models). */
export const KONTENT_DEFAULT_SLUG_ELEMENT = "url";

/**
 * Bounds a run keeps to, in the platform's terms. There are no flags to raise them. They live here, in plain
 * data, because the Kontent.ai check quotes them and a check may not import the adapter module.
 */
export const KONTENT_LIMITS = {
  /** Items read from one list (the whole environment's published items, or its Preview list). A bigger one is could-not-check, never a count of part of it. */
  items: 10_000,
  /** Unpublished items whose live page is asked for in one run. More are could-not-check, never skipped quietly. */
  pages: 40,
} as const;

export const entries: readonly AdapterEntry[] = [
  {
    id: "kontent-ai",
    name: "Kontent.ai",
    status: "built",
    describe: KONTENT_DESCRIPTION,
    envVars: KONTENT_ENV_VARS,
    settings: { previewRead: true, slugElement: true },
    // The only way the adapter's code is reached: a dynamic import, so the bundler gives it its own chunk.
    // An entry file imports only types, `lazy` and plain data, never the adapter module.
    load: lazy("kontent-ai", async () => {
      const { createKontentAdapter } = await import("./kontent-ai.js");
      return (c, settings) =>
        createKontentAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        });
    }),
    // The row in docs/integrations/index.md is generated from this (pnpm gen:adapters).
    docs: {
      key: "none for a public project; a Delivery API secure access key for a secured one (it can only read published content)",
      reads:
        "The published items of the environment, through the Delivery API: counts, field counts and published items as fingerprints. With --owner-consent and a settings entry, items that are not published and still have a live page. [Endpoints and the key](/docs/integrations/kontent-ai)",
    },
    page: {
      slug: "integrations/kontent-ai",
      title: "Kontent.ai: content checks for sites built on Kontent.ai",
    },
  },
];
