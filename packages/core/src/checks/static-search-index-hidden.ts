import { escapeInvisible } from "./hidden-text/escape.js";
import { defineCheck, type CheckContext } from "../model.js";
import { getOrNull } from "../probe.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import {
  draftMarker,
  generatorOf,
  isIndexable,
  normalizePath,
  readSearchIndex,
} from "../static-generators/detect.js";
import { isHtmlPage } from "./page.js";
import { firstFew } from "./site-helpers.js";

/** Addresses a Hugo, Jekyll or Docusaurus search plugin conventionally writes its index to. Not documented by the generators: uncited. */
export const INDEX_PATHS: readonly string[] = Object.freeze([
  "/index.json",
  "/search.json",
  "/search-index.json",
]);

export const NO_CONSENT_REASON =
  "this check asks for the site's search index at its usual addresses, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

const clip = (s: string): string => escapeInvisible(s, 120);
const JSON_CHUNK = /@localSearchIndex[\w-]*\.[\w-]+\.js/;

/** The search index addresses the page's own markup and modules name: a JSON alternate link, a VitePress chunk. */
async function linked(page: PageSnapshot, ctx: CheckContext): Promise<string[]> {
  const origin = new URL(page.finalUrl).origin;
  const out: string[] = [];
  const html = (page.hops.at(-1)?.body ?? "").slice(0, 300_000);
  for (const m of html.matchAll(/<link\b[^>]{0,800}>/gi)) {
    const tag = m[0];
    if (
      /\brel\s*=\s*["']?alternate\b/i.test(tag) &&
      /\btype\s*=\s*["']?application\/json\b/i.test(tag)
    ) {
      const href = /\bhref\s*=\s*(["'])([^"']{1,300})\1/i.exec(tag)?.[2];
      if (href !== undefined && normalizePath(href, origin) !== undefined)
        out.push(new URL(href, `${origin}/`).href);
    }
  }
  if (generatorOf(page)?.name === "vitepress" && ctx.fetcher && ctx.budget) {
    const modules = [
      ...html.matchAll(/<link\b[^>]{0,800}\bhref\s*=\s*(["'])([^"']{1,300}\.js)\1/gi),
    ]
      .map((m) => m[2] ?? "")
      .concat(page.scripts)
      .map((h) => {
        try {
          return new URL(h, page.finalUrl);
        } catch {
          return undefined;
        }
      })
      .filter((u): u is URL => u !== undefined && u.origin === origin);
    for (const u of ctx.budget.take("scripts", [
      ...new Map(modules.map((x) => [x.href, x])).values(),
    ])) {
      const last = (await getOrNull(ctx.fetcher, u.href)).at(-1);
      const name = JSON_CHUNK.exec(last?.body ?? "")?.[0];
      if (name !== undefined) {
        out.push(new URL(`./${name}`, u.href).href);
        break;
      }
    }
  }
  return out;
}

export const staticSearchIndexHidden = defineCheck<PageSnapshot>({
  id: "static-search-index-hidden",
  size: "M",
  done: "The site's search index lists only pages the sitemap lists and search engines may index.",
  estimateChanges:
    "The index and the sitemap are built by different plugins, and each needs the same filter on drafts and noindex pages.",
  area: "Launch day",
  severity: "high",
  title: "The site's search lists pages that are meant to be hidden",
  what: "The search index a static site generator built lists pages that the sitemap leaves out and that are marked noindex or draft.",
  why: "Anyone who types a word into your site search, or who downloads the index file, is shown those pages, even though you told search engines to skip them.",
  fix: "Leave drafts, unlisted and noindex pages out of the search index at build time (the same filter as the sitemap's), and rebuild.",
  tech: "Probing check: off unless --owner-consent or gaugeline.consent.json; run only on sites you own or have permission to test. Sites with a Hugo, Jekyll, Eleventy, Docusaurus or VitePress generator tag only. The index is the file the page's own markup names (a JSON alternate link, or VitePress's @localSearchIndex chunk named in its modules: read without consent, it is what every visitor's browser loads), else /index.json, /search.json, /search-index.json (conventions: uncited). Read up to 5 MB and 50,000 addresses; a larger, cut or unrecognised index is could not check. Addresses the sitemaps do not list are asked once each with GET (up to 4); a finding needs one that says noindex or shows a draft marker. Paths and counts only; reads use the run's script and page allowances",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || !isHtmlPage(page) || generatorOf(page) === undefined)
      return [];
    const origin = new URL(page.finalUrl).origin;
    let candidates = await linked(page, ctx);
    if (candidates.length === 0) {
      if (ctx.ownerConsent !== true) {
        ctx.couldNotCheck?.(page.finalUrl, NO_CONSENT_REASON);
        return [];
      }
      candidates = INDEX_PATHS.map((p) => `${origin}${p}`);
    }
    for (const url of ctx.budget.take("scripts", candidates)) {
      const hops = await getOrNull(ctx.fetcher, url);
      const last = hops.at(-1);
      if (!last || last.status !== 200) continue;
      const path = new URL(url).pathname;
      if (last.truncated === true) {
        ctx.couldNotCheck?.(url, `${path} was cut short, so its list was not read in full`);
        return [];
      }
      const read = readSearchIndex(last.body ?? "", origin);
      if ("unread" in read) {
        ctx.couldNotCheck?.(url, `${path}: ${read.unread}`);
        return [];
      }
      const sitemap = new Set(
        ((await ctx.site?.())?.sitemapUrls ?? []).flatMap((u) => normalizePath(u, origin) ?? []),
      );
      if (sitemap.size === 0) {
        ctx.couldNotCheck?.(url, "the site has no sitemap to compare its search index with");
        return [];
      }
      const unlisted = read.paths.filter((p) => !sitemap.has(p));
      const hidden: string[] = [];
      let readPages = 0;
      for (const p of ctx.budget.take("pages", unlisted.slice(0, 4))) {
        const got = (await getOrNull(ctx.fetcher, `${origin}${p}`)).at(-1);
        if (!got || got.status !== 200) continue;
        readPages += 1;
        const snap = buildSnapshot([got]);
        if (!isIndexable(snap) || draftMarker(snap) !== undefined) hidden.push(p);
      }
      if (hidden.length === 0) return [];
      const n = unlisted.length;
      return [
        {
          checkId: "static-search-index-hidden",
          severity: "high",
          title: this.title,
          evidence: `${clip(path)} lists ${n} page${n === 1 ? "" : "s"} the sitemap leaves out (first: ${firstFew(unlisted.map(clip))}); ${hidden.length} of ${readPages} read ${hidden.length === 1 ? "is" : "are"} noindex or marked draft`,
          url: page.finalUrl,
        },
      ];
    }
    return [];
  },
});
