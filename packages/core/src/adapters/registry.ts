import { ConfigError } from "../errors.js";
import type { AdaptersConfig } from "./config.js";
import { ADAPTER_ENTRIES } from "./entries.generated.js";
import type { AdapterContext, AdapterFactory } from "./entry.js";
import type { AdapterDescription, AdapterSettings, ContentAdapter } from "./types.js";

export type { AdapterContext, AdapterEntry, AdapterFactory } from "./entry.js";
export { onAdapterLoad } from "./load.js";

// LOADER RULE: this file and every other file outside adapters/<id>*.ts reach an adapter's code only through
// its entry's `load` (a dynamic `import()` in adapters/<id>.entry.ts), never through a static import. A
// type-only import is fine: it is erased. The bundler then keeps each adapter out of start-up, so a run that
// uses WordPress never loads the Shopify code. adapters/__tests__/lazy.test.ts enforces it.

/**
 * An adapter that is built. Its row in docs/integrations is "built". `describe` is metadata, known without
 * loading the adapter (the docs table and the run header read it); `load` imports the adapter's module, once,
 * the first time it is used.
 */
export interface BuiltAdapter {
  describe: AdapterDescription;
  id: string;
  /** The environment variables the adapter may read, when it reads any beyond the key. */
  envVars: readonly string[];
  load(): Promise<AdapterFactory>;
}

/**
 * The adapters that exist, from the entry files (adapters/<id>.entry.ts, collected by `pnpm gen:adapters`
 * into entries.generated.ts). A new adapter adds its entry file, one contract entry and its docs page; it
 * edits no shared file.
 */
export const BUILT_ADAPTERS: ReadonlyMap<string, BuiltAdapter> = new Map<string, BuiltAdapter>(
  ADAPTER_ENTRIES.flatMap((e): [string, BuiltAdapter][] =>
    e.status === "built" && e.describe && e.load
      ? [[e.id, { id: e.id, describe: e.describe, envVars: e.envVars ?? [], load: e.load }]]
      : [],
  ),
);

/** A content system the docs list and the build order names, and no adapter yet. */
export interface PlannedAdapter {
  id: string;
  name: string;
  /** The branch that builds it, as PROGRESS.md names it. */
  branch: string;
}

/** What is planned (adapters/<id>.entry.ts with status "planned"), in the order of the entry files. */
export const PLANNED_ADAPTERS: readonly PlannedAdapter[] = ADAPTER_ENTRIES.flatMap(
  (e): PlannedAdapter[] =>
    e.status === "planned" && e.branch ? [{ id: e.id, name: e.name, branch: e.branch }] : [],
);

/** What a built adapter says about itself, without loading it. Throws for an id that is not built. */
export function adapterDescription(id: string): AdapterDescription {
  const built = BUILT_ADAPTERS.get(id);
  if (!built) throw new Error(`"${id}" is not a built adapter.`);
  return built.describe;
}

/** The environment variables a built adapter may read, without loading it. */
export function adapterEnvVars(id: string): readonly string[] {
  const built = BUILT_ADAPTERS.get(id);
  if (!built) throw new Error(`"${id}" is not a built adapter.`);
  return built.envVars;
}

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
