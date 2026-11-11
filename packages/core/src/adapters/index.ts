export { KEY_KINDS, AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
export type {
  AdapterDescription,
  AdapterMember,
  AdapterSettings,
  ContentAdapter,
  KeyKind,
  PublishedDoc,
  PublishedOptions,
  TypeCount,
} from "./types.js";
export { adapterHeader, collectPublished, describePartial } from "./collect.js";
export type { Collected, PartialRead } from "./collect.js";
export { ADAPTERS_CONFIG_FILE, adaptersConfigSchema } from "./config.js";
export type { AdaptersConfig } from "./config.js";
export { fillUrlTemplate, hashValue, isUrlTemplate } from "./fingerprint.js";
export {
  BUILT_ADAPTERS,
  PLANNED_ADAPTERS,
  adapterDescription,
  adapterEnvVars,
  adaptersOrDefault,
  createAdapter,
  createAdapters,
  onAdapterLoad,
  resolveAdapters,
} from "./registry.js";
export type {
  AdapterContext,
  AdapterEntry,
  AdapterFactory,
  BuiltAdapter,
  PlannedAdapter,
} from "./registry.js";
// Nothing per adapter is exported from here: an adapter's code is reached through its loader (see the loader rule
// in registry.ts), and its description and variable names through `adapterDescription` and `adapterEnvVars`, so a
// new adapter adds no line to this file. The builders' table is plain data the docs and the suggestions read.
export { BUILDERS, BUILDER_IDS, builderById, builderDescription } from "./builder-platforms.js";
export type { BuilderPlatform } from "./builder-platforms.js";
