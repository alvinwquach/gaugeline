import type { Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import type { AdaptersConfig } from "./config.js";
import { GIT_CONTENT_DESCRIPTION, createGitContentAdapter } from "./git-content.js";
import { SANITY_DESCRIPTION, createSanityAdapter } from "./sanity.js";
import { SITEMAP_FEED_DESCRIPTION, createSitemapFeedAdapter } from "./sitemap-feed.js";
import { WORDPRESS_DESCRIPTION, createWordPressAdapter } from "./wordpress.js";
import type { AdapterDescription, AdapterSettings, ContentAdapter } from "./types.js";
import { WEBFLOW_DESCRIPTION, createWebflowAdapter } from "./webflow.js";

export interface AdapterContext {
  env: Env;
  fetcher: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  /** The address of the site being checked. The sitemap and feed adapter reads it unless its settings give one. */
  site?: string;
  /** What a relative `path` in the git-content settings is relative to. Default: the working folder. */
  cwd?: string;
}

/** An adapter that is built. Its row in docs/integrations is "built" and a test keeps the two in step. */
export interface BuiltAdapter {
  /** What it says about itself, known without building it (the docs table and the run header read it). */
  describe: AdapterDescription;
  id: string;
  create(context: AdapterContext, settings?: AdapterSettings): ContentAdapter;
}

/**
 * The adapters that exist. A new adapter adds one line here, one entry to the contract suite
 * (adapters/__tests__/entries.ts) and its row in docs/integrations/index.md.
 */
export const BUILT_ADAPTERS: ReadonlyMap<string, BuiltAdapter> = new Map<string, BuiltAdapter>([
  [
    "sanity",
    {
      id: "sanity",
      describe: SANITY_DESCRIPTION,
      create: (c, settings) =>
        createSanityAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        }),
    },
  ],
  [
    "sitemap-feed",
    {
      id: "sitemap-feed",
      describe: SITEMAP_FEED_DESCRIPTION,
      create: (c, settings) =>
        createSitemapFeedAdapter({
          fetcher: c.fetcher,
          site: c.site,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        }),
    },
  ],
  [
    "wordpress",
    {
      id: "wordpress",
      describe: WORDPRESS_DESCRIPTION,
      create: (c, settings) =>
        createWordPressAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        }),
    },
  ],
  [
    "git-content",
    {
      id: "git-content",
      describe: GIT_CONTENT_DESCRIPTION,
      create: (c, settings) =>
        createGitContentAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
          ...(c.site !== undefined ? { site: c.site } : {}),
          ...(c.sleep ? { sleep: c.sleep } : {}),
        }),
    },
  ],
  [
    "webflow",
    {
      id: "webflow",
      describe: WEBFLOW_DESCRIPTION,
      create: (c, settings) =>
        createWebflowAdapter({
          env: c.env,
          fetcher: c.fetcher,
          settings,
          ...(c.sleep ? { sleep: c.sleep } : {}),
        }),
    },
  ],
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
  { id: "framer", name: "Framer", branch: "C-06" },
  { id: "wix", name: "Wix", branch: "C-05" },
  { id: "generic-api", name: "Any headless CMS with a read API", branch: "C-14" },
  { id: "builders", name: "Squarespace and other builders without a content API", branch: "C-12" },
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

/** The adapters a settings file names, built over this environment and fetcher. */
export function createAdapters(config: AdaptersConfig, context: AdapterContext): ContentAdapter[] {
  return resolveAdapters(config).map((built, i) => built.create(context, config.adapters[i]));
}

/**
 * The adapters to use for a run. A settings file that names some gets exactly those. With no settings
 * file the sitemap and feed adapter is the default, so every check that needs "what is published"
 * works on a site built on any CMS. It needs only the site's address; with none there is no adapter
 * and nothing is requested.
 */
export function adaptersOrDefault(
  config: AdaptersConfig | undefined,
  context: AdapterContext,
): ContentAdapter[] {
  if (config !== undefined) return createAdapters(config, context);
  if (context.site === undefined || context.site.trim() === "") return [];
  return createAdapters({ adapters: [{ id: "sitemap-feed" }] }, context);
}
