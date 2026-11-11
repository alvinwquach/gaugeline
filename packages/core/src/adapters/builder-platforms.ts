import type { AdapterDescription } from "./types.js";

// The hosted builders and what Gaugeline knows about each: plain data, so the settings file schema and the
// registry can name them without loading the builder adapter (builders.ts).

/**
 * One hosted website builder that has no content API Gaugeline can read with a read-only key.
 *
 * Every platform is its own adapter id (`squarespace`, `duda`, ...) built from this one module, and not
 * one `builders` id with a setting that picks the platform. The id is what a person writes in
 * gaugeline.adapters.json and what the run header and the report name, so "Content system: Squarespace"
 * says what was read, and each platform's reason for what it cannot check is its own words. The cost is
 * one registry entry per platform (generated below from this table, not written by hand).
 *
 * Everything in `hints` and `apiNote` was written without a connected documentation source and the
 * platforms' developer pages could not be reached (uncited, `verified: false`). A wrong hint only means
 * a suggestion that is not made or a wrong one that a person ignores: detection never changes what an
 * adapter does.
 */
export interface BuilderPlatform {
  /** The adapter id: lower case letters, digits and hyphens. */
  id: string;
  /** The platform as a person writes it. Also the row in docs/integrations. */
  name: string;
  /** The docs heading's anchor on docs/integrations/builders. */
  anchor: string;
  /** What the platform offers, in one sentence, and why Gaugeline does not use it. Goes into the reason. */
  apiNote: string;
  /** Signs a page is built on it, used only by `suggestBuilder`. Hosts are matched as the host or a subdomain. */
  hints: {
    hosts: readonly string[];
    /** Start of the generator meta tag's content, lower case. */
    generator?: readonly string[];
  };
}

export const BUILDERS: readonly BuilderPlatform[] = Object.freeze([
  {
    id: "squarespace",
    name: "Squarespace",
    anchor: "squarespace",
    apiNote:
      "its developer APIs cover the store, which is products, orders, inventory and profiles, and not pages or blog posts; store access is a separate adapter",
    hints: {
      hosts: ["static1.squarespace.com", "images.squarespace-cdn.com", "assets.squarespace.com"],
      generator: ["squarespace"],
    },
  },
  {
    id: "duda",
    name: "Duda",
    anchor: "duda",
    apiNote:
      "its API is for agencies and partners and its credentials can also change sites, so it is not a read-only key",
    hints: { hosts: ["irp.cdn-website.com", "lirp.cdn-website.com", "multiscreensite.com"] },
  },
  {
    id: "tilda",
    name: "Tilda",
    anchor: "tilda",
    apiNote:
      "it has an export API for a project's pages, and Gaugeline has not confirmed that its key pair is read-only",
    hints: { hosts: ["static.tildacdn.com", "tildacdn.com", "tildacdn.net"] },
  },
  {
    id: "godaddy",
    name: "GoDaddy Website Builder",
    anchor: "godaddy-website-builder",
    apiNote: "Gaugeline knows of no public API that reads a site's pages",
    hints: { hosts: ["img1.wsimg.com", "wsimg.com"], generator: ["go daddy website builder"] },
  },
  {
    id: "weebly",
    name: "Weebly",
    anchor: "weebly",
    apiNote: "Gaugeline knows of no public API that reads a site's pages or blog posts",
    hints: { hosts: ["editmysite.com", "weebly.com"] },
  },
  {
    id: "carrd",
    name: "Carrd",
    anchor: "carrd",
    apiNote: "Gaugeline knows of no public API that reads a site's content",
    hints: { hosts: ["carrd.co"] },
  },
  {
    id: "strikingly",
    name: "Strikingly",
    anchor: "strikingly",
    apiNote: "Gaugeline knows of no public API that reads a site's pages or blog posts",
    hints: { hosts: ["strikinglycdn.com", "mystrikingly.com"] },
  },
]);

export const BUILDER_IDS: readonly string[] = BUILDERS.map((b) => b.id);

/** A platform by adapter id. */
export function builderById(id: string): BuilderPlatform | undefined {
  return BUILDERS.find((b) => b.id === id);
}

/**
 * What a builder adapter says about itself. No key is asked for, and `keyKind` is "read-only" because
 * nothing it does can change anything; `noKey` makes the run header say there is no key at all.
 */
export function builderDescription(platform: BuilderPlatform): AdapterDescription {
  return {
    name: platform.name,
    docsUrl: `https://gaugeline.dev/docs/integrations/builders#${platform.anchor}`,
    keyKind: "read-only",
    noKey: true,
  };
}
