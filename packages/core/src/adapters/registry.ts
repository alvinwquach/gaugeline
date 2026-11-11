import type { Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import type { AdaptersConfig } from "./config.js";
import { BUILDERS, builderDescription } from "./builder-platforms.js";
import {
  FRAMER_DESCRIPTION,
  SANITY_DESCRIPTION,
  SITEMAP_FEED_DESCRIPTION,
  WEBFLOW_DESCRIPTION,
  WIX_DESCRIPTION,
  WORDPRESS_DESCRIPTION,
} from "./meta.js";
import type { AdapterDescription, AdapterSettings, ContentAdapter } from "./types.js";

// LOADER RULE: this file, index.ts and every other file outside adapters/<id>*.ts reach an adapter's
// code only through the `import()` in its loader below, never through a static import (a type-only
// import is fine: it is erased). The bundler then keeps each adapter out of start-up, so a run that
// uses WordPress never loads the Shopify code and start-up does not grow with the adapter count.
// adapters/__tests__/lazy.test.ts enforces it.

export interface AdapterContext {
  env: Env;
  fetcher: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  /** The address of the site being checked. The sitemap and feed adapter reads it unless its settings give one. */
  site?: string;
}

/** Builds an adapter over this environment and fetcher: what a loader gives back. */
export type AdapterFactory = (
  context: AdapterContext,
  settings?: AdapterSettings,
) => ContentAdapter;

/**
 * An adapter that is built. Its row in docs/integrations is "built" and a test keeps the two in step.
 * `describe` is metadata, known without loading the adapter (the docs table and the run header read it).
 * `load` imports the adapter's module, once, the first time it is used.
 */
export interface BuiltAdapter {
  describe: AdapterDescription;
  id: string;
  load(): Promise<AdapterFactory>;
}

type LoadListener = (id: string) => void;
const loadListeners = new Set<LoadListener>();

/**
 * Calls `listener` with the id of each adapter the first time its code is loaded. The CLI wires it to
 * stderr when GAUGELINE_TRACE_ADAPTER_LOADS=1, which is how the start-up test proves that `--version`,
 * `--help` and a run that names one adapter load no other. Returns a function that removes it.
 */
export function onAdapterLoad(listener: LoadListener): () => void {
  loadListeners.add(listener);
  return () => void loadListeners.delete(listener);
}

/** A loader that imports once, tells the listeners, and tries again if the import failed. */
function lazy(
  id: string,
  importFactory: () => Promise<AdapterFactory>,
): () => Promise<AdapterFactory> {
  let loading: Promise<AdapterFactory> | undefined;
  return () => {
    loading ??= importFactory().then(
      (factory) => {
        for (const listener of loadListeners) listener(id);
        return factory;
      },
      (err: unknown) => {
        loading = undefined;
        throw err;
      },
    );
    return loading;
  };
}

/**
 * The adapters that exist. A new adapter adds one entry here (metadata plus a loader that dynamically
 * imports its module: never a static import, see the loader rule above), one entry to the contract suite
 * (adapters/__tests__/entries.ts) and its row in docs/integrations/index.md.
 */
export const BUILT_ADAPTERS: ReadonlyMap<string, BuiltAdapter> = new Map<string, BuiltAdapter>([
  [
    "sanity",
    {
      id: "sanity",
      describe: SANITY_DESCRIPTION,
      load: lazy("sanity", async () => {
        const { createSanityAdapter } = await import("./sanity.js");
        return (c, settings) =>
          createSanityAdapter({
            env: c.env,
            fetcher: c.fetcher,
            settings,
            ...(c.sleep ? { sleep: c.sleep } : {}),
          });
      }),
    },
  ],
  [
    "sitemap-feed",
    {
      id: "sitemap-feed",
      describe: SITEMAP_FEED_DESCRIPTION,
      load: lazy("sitemap-feed", async () => {
        const { createSitemapFeedAdapter } = await import("./sitemap-feed.js");
        return (c, settings) =>
          createSitemapFeedAdapter({
            fetcher: c.fetcher,
            site: c.site,
            settings,
            ...(c.sleep ? { sleep: c.sleep } : {}),
          });
      }),
    },
  ],
  [
    "wix",
    {
      id: "wix",
      describe: WIX_DESCRIPTION,
      load: lazy("wix", async () => {
        const { createWixAdapter } = await import("./wix.js");
        return (c, settings) =>
          createWixAdapter({
            fetcher: c.fetcher,
            site: c.site,
            settings,
            ...(c.sleep ? { sleep: c.sleep } : {}),
          });
      }),
    },
  ],
  [
    "wordpress",
    {
      id: "wordpress",
      describe: WORDPRESS_DESCRIPTION,
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
    },
  ],
  [
    "webflow",
    {
      id: "webflow",
      describe: WEBFLOW_DESCRIPTION,
      load: lazy("webflow", async () => {
        const { createWebflowAdapter } = await import("./webflow.js");
        return (c, settings) =>
          createWebflowAdapter({
            env: c.env,
            fetcher: c.fetcher,
            settings,
            ...(c.sleep ? { sleep: c.sleep } : {}),
          });
      }),
    },
  ],
  [
    "framer",
    {
      id: "framer",
      describe: FRAMER_DESCRIPTION,
      load: lazy("framer", async () => {
        const { createFramerAdapter } = await import("./framer.js");
        return (c, settings) =>
          createFramerAdapter({
            fetcher: c.fetcher,
            site: c.site,
            settings,
            ...(c.sleep ? { sleep: c.sleep } : {}),
          });
      }),
    },
  ],
  // One adapter id per hosted builder with no content API (adapters/builders.ts): the live site only.
  ...BUILDERS.map((platform): [string, BuiltAdapter] => [
    platform.id,
    {
      id: platform.id,
      describe: builderDescription(platform),
      load: lazy(platform.id, async () => {
        const { createBuilderAdapter } = await import("./builders.js");
        return (c, settings) =>
          createBuilderAdapter(platform, {
            fetcher: c.fetcher,
            site: c.site,
            settings,
            ...(c.sleep ? { sleep: c.sleep } : {}),
          });
      }),
    },
  ]),
]);

/** A content system the docs list and the build order names, and no adapter yet. */
export interface PlannedAdapter {
  id: string;
  name: string;
  /** The branch that builds it, as PROGRESS.md names it. */
  branch: string;
}

/**
 * What is planned, in build order (PROGRESS.md). C-08 Storyblok, C-09 Payload, C-10 Ghost and C-11
 * Drupal ship first as C-14 recipes; a native adapter for them is built when someone asks.
 */
export const PLANNED_ADAPTERS: readonly PlannedAdapter[] = [
  { id: "generic-api", name: "Any headless CMS with a read API", branch: "C-14" },
  { id: "git-content", name: "Content kept in git", branch: "C-15" },
  { id: "strapi", name: "Strapi", branch: "C-02" },
  { id: "tina", name: "TinaCMS", branch: "C-03" },
  { id: "contentful", name: "Contentful", branch: "C-07" },
];

/**
 * The built adapter for each entry of a settings file, or a ConfigError: an id that is planned says
 * which branch builds it, one nobody has heard of lists the built ones. Nothing is requested.
 */
export function resolveAdapters(config: AdaptersConfig): BuiltAdapter[] {
  return config.adapters.map((entry) => {
    const built = BUILT_ADAPTERS.get(entry.id);
    if (built) return built;
    const planned = PLANNED_ADAPTERS.find((p) => p.id === entry.id);
    const known = [...BUILT_ADAPTERS.keys()].join(", ");
    throw new ConfigError(
      planned
        ? `gaugeline.adapters.json: the "${entry.id}" adapter is planned (${planned.branch}) and not built yet.`
        : `gaugeline.adapters.json: "${entry.id}" is not an adapter Gaugeline has.`,
      { hint: `Built adapters: ${known}. See docs/integrations for what is planned.` },
    );
  });
}

/** One built adapter, loaded now and built over this environment and fetcher. */
export async function createAdapter(
  built: BuiltAdapter,
  context: AdapterContext,
  settings?: AdapterSettings,
): Promise<ContentAdapter> {
  return (await built.load())(context, settings);
}

/**
 * The adapters a settings file names, built over this environment and fetcher. Only the adapters it
 * names are loaded, and none until this is called.
 */
export async function createAdapters(
  config: AdaptersConfig,
  context: AdapterContext,
): Promise<ContentAdapter[]> {
  const built = resolveAdapters(config);
  return Promise.all(built.map((b, i) => createAdapter(b, context, config.adapters[i])));
}

/**
 * The adapters to use for a run. A settings file that names some gets exactly those. With no settings
 * file the sitemap and feed adapter is the default, so every check that needs "what is published"
 * works on a site built on any CMS. It needs only the site's address; with none there is no adapter
 * and nothing is requested.
 */
export async function adaptersOrDefault(
  config: AdaptersConfig | undefined,
  context: AdapterContext,
): Promise<ContentAdapter[]> {
  if (config !== undefined) return createAdapters(config, context);
  if (context.site === undefined || context.site.trim() === "") return [];
  return createAdapters({ adapters: [{ id: "sitemap-feed" }] }, context);
}
