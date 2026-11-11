import { load } from "cheerio/slim";
import type { Fetcher } from "../fetcher.js";
import { createSitemapFeedAdapter } from "./sitemap-feed.js";
import {
  AdapterCouldNotCheck,
  type AdapterDescription,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
} from "./types.js";

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

/**
 * Why a platform's content cannot be read, in one place so the answer, the docs page and the tests say
 * the same thing.
 */
export function builderCannotRead(platform: BuilderPlatform): string {
  return `Not applicable to what Gaugeline can read from a ${platform.name} site. Gaugeline has not confirmed a read-only content API for ${platform.name}'s pages and blog posts (${platform.apiNote}), and it never reads a site's admin screens. Its fields, drafts and members are therefore not read. What the live site publishes is read from its sitemap instead.`;
}

export interface BuilderAdapterOptions {
  fetcher: Fetcher;
  /** The site's address, from the run. The settings entry's `site` wins. */
  site?: string | undefined;
  /** The settings entry (`site`, `sitemaps`, `feeds`). `fingerprint` and `urls` mean nothing here. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * The adapter for a hosted builder with no content API: what the live site publishes, read from the
 * files it hands every visitor (the sitemap and feeds, through the sitemap and feed adapter's reader),
 * and could-not-check, with the platform's reason, for fields. It never reads the environment, so no
 * key can reach a request, a message or a report.
 *
 * Types are the first folder of an address (`/blog/spring-sale` is `blog`, a Squarespace blog's usual
 * path). There are no fields, so every `fieldHashes` is empty; unpublished work lives in the platform's
 * editor, so `draftsReachable` is "not-applicable" and asks for nothing.
 */
export function createBuilderAdapter(
  platform: BuilderPlatform,
  options: BuilderAdapterOptions,
): ContentAdapter {
  const settings = options.settings;
  const site = settings?.site ?? options.site;
  const pages = createSitemapFeedAdapter({
    fetcher: options.fetcher,
    site,
    settings,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  /** The run must name a web address before anything is asked, in this adapter's own words. */
  const requireSite = (): void => {
    let url: URL | undefined;
    try {
      url = site === undefined || site.trim() === "" ? undefined : new URL(site.trim());
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:"))
      throw new AdapterCouldNotCheck(
        `No site address to read the ${platform.name} site's sitemap from. Give the site on the command line, or set "site" on the ${platform.id} entry in gaugeline.adapters.json.`,
      );
  };

  async function* published(opts?: PublishedOptions): AsyncGenerator<PublishedDoc> {
    requireSite();
    yield* pages.published(opts);
  }

  return {
    id: platform.id,
    describe: () => builderDescription(platform),
    types: async () => {
      requireSite();
      return pages.types();
    },
    fieldCounts: () => Promise.reject(new AdapterCouldNotCheck(builderCannotRead(platform))),
    published,
    draftsReachable: () => Promise.resolve("not-applicable"),
    ...(pages.resolveUrl ? { resolveUrl: pages.resolveUrl } : {}),
  };
}

/** What a page shows of the builder it is built on. */
export interface BuilderSuggestion {
  /** The adapter id to write in gaugeline.adapters.json. */
  id: string;
  name: string;
  /** The sign that matched, for a message: "generator tag" or the asset host. */
  evidence: string;
}

const hostIn = (host: string, wanted: readonly string[]): boolean =>
  wanted.some((w) => host === w || host.endsWith(`.${w}`));

/**
 * A HINT, never a decision: which builder a page's own markup points to, from the generator meta tag
 * and the hosts its scripts, stylesheets and images come from. A link to a builder's own website, or a
 * word in the page's text, is never a sign. Pure (no request), deterministic (the same markup gives
 * the same answer, in the order of BUILDERS), and undefined for anything else. It is used to suggest an
 * `adapters` entry and by the docs; it never switches an adapter on, and a run uses the adapters it was
 * given.
 */
export function suggestBuilder(html: string, pageUrl: string): BuilderSuggestion | undefined {
  const $ = load(html);
  let generator = "";
  $("meta[name]").each((_, el) => {
    if (generator === "" && (el.attribs.name ?? "").toLowerCase() === "generator")
      generator = (el.attribs.content ?? "").trim().toLowerCase();
  });
  const hosts = new Set<string>();
  $("script[src], link[href], img[src], source[src]").each((_, el) => {
    const raw = el.attribs.src ?? el.attribs.href ?? "";
    // <link> is an asset only when it loads one; an alternate or canonical link is a link to a page.
    if (
      el.tagName === "link" &&
      !/\b(stylesheet|preload|icon|modulepreload)\b/i.test(el.attribs.rel ?? "")
    )
      return;
    try {
      hosts.add(new URL(raw.trim(), pageUrl).hostname.toLowerCase());
    } catch {
      // not an address
    }
  });
  for (const platform of BUILDERS) {
    const g = platform.hints.generator?.find((prefix) => generator.startsWith(prefix));
    if (g !== undefined) return { id: platform.id, name: platform.name, evidence: "generator tag" };
    const host = [...hosts].sort().find((h) => hostIn(h, platform.hints.hosts));
    if (host !== undefined) return { id: platform.id, name: platform.name, evidence: host };
  }
  return undefined;
}
