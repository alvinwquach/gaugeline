import { load } from "cheerio/slim";
import type { Fetcher } from "../fetcher.js";
import { createSitemapFeedAdapter } from "./sitemap-feed.js";
import {
  AdapterCouldNotCheck,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
} from "./types.js";

import { BUILDERS, builderDescription, type BuilderPlatform } from "./builder-platforms.js";
export { BUILDERS, builderDescription, type BuilderPlatform };
export { BUILDER_IDS, builderById } from "./builder-platforms.js";

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
