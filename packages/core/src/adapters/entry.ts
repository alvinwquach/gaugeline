import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import type { AdapterDescription, AdapterSettings, ContentAdapter } from "./types.js";

export interface AdapterContext {
  env: Env;
  fetcher: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  /** The address of the site being checked. The sitemap and feed adapter reads it unless its settings give one. */
  site?: string;
  /** What a relative folder in an adapter's settings (the repository `path`) is relative to. Default: the working folder. */
  cwd?: string;
}

/** Builds an adapter over this environment and fetcher: what a loader gives back. */
export type AdapterFactory = (
  context: AdapterContext,
  settings?: AdapterSettings,
) => ContentAdapter;

/**
 * How a page shows that a site is built on a platform, as plain data (`gaugeline init` reads it; nothing else
 * does). Every list is optional and every match is a HINT: the first one that matches says why, and no hint
 * switches an adapter on. Lower case throughout. An entry must not import its adapter to detect it (the loader
 * rule), which is why this is data and not a function.
 */
export interface AdapterDetection {
  /** The start of the generator meta tag's content, such as "wordpress". */
  generator?: readonly string[];
  /** Hosts the page loads scripts, styles or images from; a subdomain of one matches. */
  hosts?: readonly string[];
  /** A fragment of the path of a file the page loads, on any host, such as "/wp-content/". */
  paths?: readonly string[];
  /** A response header: its name, and a fragment of its value ("" for any value). */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Everything the rest of Gaugeline needs to know about one adapter without loading it. Each adapter has one
 * small file, `adapters/<id>.entry.ts`, that exports `entries: readonly AdapterEntry[]` (the builders file
 * exports one for each platform). `pnpm gen:adapters` collects every `*.entry.ts` into
 * `entries.generated.ts` and into the generated blocks of docs/integrations/index.md and docs/nav.ts, so a new
 * adapter adds files and edits no shared one.
 *
 * LOADER RULE: an entry file imports only types, `lazy` (load.ts) and plain data. The adapter module itself is
 * reached through `load`, by a dynamic `import()`, and nowhere else outside the adapter's own files
 * (adapters/__tests__/lazy.test.ts enforces it). The bundler then keeps each adapter out of start-up.
 */
export interface AdapterEntry {
  /** Lower case, digits and hyphens: the name used in gaugeline.adapters.json. */
  id: string;
  /** The platform as a person writes it. It is the first cell of the row in docs/integrations/index.md. */
  name: string;
  /** "planned" has no code yet: `branch` says which branch builds it, and asking for it is a ConfigError. */
  status: "built" | "planned";
  /** Planned only: the branch that builds it, as PROGRESS.md names it. */
  branch?: string;
  /** Built only: what it says about itself, known without loading it (the run header reads it). */
  describe?: AdapterDescription;
  /** Built only: imports the adapter's module, once, and returns its factory. */
  load?: () => Promise<AdapterFactory>;
  /** Built only: the environment variables the adapter may read, for a caller that copies them before loading it. */
  envVars?: readonly string[];
  /** Built only: what a page shows when a site is built on this platform, for `gaugeline init`. Absent: never detected. */
  detect?: AdapterDetection;
  /** What this adapter adds to the settings file's rules (config.ts). */
  settings?: {
    /** Reads the live site's sitemap and feeds: takes `site`, `sitemaps` and `feeds`, and no fields. */
    pageReader?: true;
    /**
     * A page reader that also reads the platform's own collections when a key is set: it takes `fingerprint`
     * and `urls` (the collections it reads are the names under them) and `siteId`.
     */
    fields?: true;
    /** The platform names its fields with hyphens. */
    hyphenFields?: true;
    /** Takes `expectPrivate`: the owner says the platform's public API is meant to be private (Umbraco's Delivery API, Joomla's Web Services API). */
    expectPrivate?: true;
    /** Reads one named site of a multi-site platform, in some languages: takes `siteName` and `languages` (Sitecore). */
    edgeSite?: true;
    /** Takes `checkReleases`: the owner agrees that Gaugeline reads the repository's releases with the token (Prismic). */
    checkReleases?: true;
    /** Takes `privateCollections`: collections the owner says the Public role must not read (Directus). */
    privateCollections?: true;
    /** Kontent.ai: takes `readPreview` (the owner lets the one probing check read the Preview API) and `slugElement`. */
    previewRead?: true;
    /** Takes `slugElement`: the codename of the element that holds an item's slug (Kontent.ai). */
    slugElement?: true;
    /** Takes `readUnpublished`: the owner lets the one probing check list unpublished nodes with the credential (Drupal). */
    unpublishedRead?: true;
    /** Takes `authCollection`: the slug of the auth collection whose API key is sent (Payload). */
    authCollection?: true;
    /** Takes `collections` (the GraphQL collection of each content type; DatoCMS and Hygraph) and, for DatoCMS, `expectPublishedOnly`. */
    graphqlCollections?: true;
    /** Hygraph: takes `readDraftStage` (the owner lets the one probing check read the DRAFT stage) and not DatoCMS's draft settings. */
    draftStageRead?: true;
    /**
     * Reads content kept in a repository: takes `path` or `github`, and `folders`; `urls` is replaced by each folder's
     * `permalink`. `true`: `folders` is required. "from-config": the platform's own config file names the folders (TinaCMS),
     * so `folders` is optional and, when given, names folders by hand.
     */
    contentFolders?: true | "from-config";
  };
  /** The row in docs/integrations/index.md: what key it asks for and what it reads (Markdown, one line). */
  docs: { key: string; reads: string };
  /** Its docs page in the sidebar. One page can serve several entries (the builders): give it to one of them. */
  page?: { slug: string; title: string };
}
