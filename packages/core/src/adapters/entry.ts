import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import type { AdapterDescription, AdapterSettings, ContentAdapter } from "./types.js";

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
  /** What this adapter adds to the settings file's rules (config.ts). */
  settings?: {
    /** Reads the live site's sitemap and feeds: takes `site`, `sitemaps` and `feeds`, and no fields. */
    pageReader?: true;
    /** The platform names its fields with hyphens. */
    hyphenFields?: true;
  };
  /** The row in docs/integrations/index.md: what key it asks for and what it reads (Markdown, one line). */
  docs: { key: string; reads: string };
  /** Its docs page in the sidebar. One page can serve several entries (the builders): give it to one of them. */
  page?: { slug: string; title: string };
}
