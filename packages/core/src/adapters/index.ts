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
  adaptersOrDefault,
  createAdapter,
  createAdapters,
  onAdapterLoad,
  resolveAdapters,
} from "./registry.js";
export type { AdapterContext, AdapterFactory, BuiltAdapter, PlannedAdapter } from "./registry.js";
// Metadata only: what each adapter says about itself and the names of the variables it reads. The adapters'
// own code is reached through the loaders in registry.ts and never exported from here, so importing the
// engine does not load it (see the loader rule in registry.ts).
export {
  FRAMER_DESCRIPTION,
  SANITY_DESCRIPTION,
  SITEMAP_FEED_DESCRIPTION,
  WEBFLOW_DESCRIPTION,
  WIX_DESCRIPTION,
  WORDPRESS_APP_PASSWORD,
  WORDPRESS_DESCRIPTION,
  WORDPRESS_ENV_VARS,
  WORDPRESS_URL,
  WORDPRESS_USER,
} from "./meta.js";
export { BUILDERS, BUILDER_IDS, builderById, builderDescription } from "./builder-platforms.js";
export type { BuilderPlatform } from "./builder-platforms.js";
export type { SitemapFeedOptions } from "./sitemap-feed.js";
export type { BuilderAdapterOptions, BuilderSuggestion } from "./builders.js";
export type { FramerAdapterOptions } from "./framer.js";
export type { SanityAdapterOptions } from "./sanity.js";
export type { WixAdapterOptions } from "./wix.js";
export type { WordPressAdapter, WordPressAdapterOptions } from "./wordpress.js";
export type {
  WebflowAdapter,
  WebflowAdapterOptions,
  WebflowCollection,
  WebflowItemState,
  WebflowStagedItem,
} from "./webflow.js";
export type {
  PageAnswer,
  PageRead,
  ReadWebflowOptions,
  StagedRead,
  WebflowReading,
} from "./webflow-read.js";
