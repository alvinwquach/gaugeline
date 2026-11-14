import { defineCheck } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { appSegments, indexingOff, robotsSource } from "./indexing-source.js";

const SITEMAP_FILE =
  /(^|\/)app\/(?:.*\/)?sitemap\.(?:ts|js|tsx|jsx|mjs)$|(^|\/)app\/sitemap\.xml\/route\.(?:ts|js)$|(^|\/)public\/sitemap[^/]*\.xml$/;

/**
 * FF-02. The sitemap files are the Next.js file conventions (app/sitemap.ts, a route handler, or a
 * static public/sitemap.xml) plus a Sitemap line in robots.txt.
 *
 * // [docs] next@16.4.1 > sitemap.xml file convention - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.mdx (page: https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap). Line 11: the file "helps search engine crawlers index your site more efficiently". That supports only what the file is for.
 * // [GC] no source found (uncited): that listing pages in it "invites crawling" of pages meant to stay hidden. The check text says a sitemap is for crawlers and does not state more.
 */
export const sitemapWhileIndexingOff = defineCheck<LocalSourceInput>({
  id: "sitemap-while-indexing-off",
  size: "S",
  done: "While the site is set to stay out of search, it has no sitemap file and no Sitemap line in robots.txt.",
  estimateChanges:
    "Deleting a file is minutes. A sitemap the build needs for something else, or one that should return an empty list while hidden, takes a small code change.",
  area: "Search & sharing",
  severity: "high",
  title: "A sitemap is served while the site is set to stay out of search",
  what: "The site is set to stay out of search (noindex in the root layout, or Disallow: / in robots.txt), and the folder still has a sitemap file or a Sitemap line in robots.txt.",
  why: "A sitemap exists to give search engines a list of pages to crawl. Handing over that list for a site you have asked them not to index works against your own setting, and a pop-up, a staging copy or a client site before launch ends up listed for every crawler that reads robots.txt.",
  fix: "Remove the sitemap file and the Sitemap line while the site is hidden, or make the sitemap return an empty list when indexing is off, and put it back at launch.",
  tech: "static, reads the folder as text and makes no request; sitemap files are app/sitemap.(ts|js), app/sitemap.xml/route.(ts|js), public/sitemap*.xml and a Sitemap line in public/robots.txt or app/robots.txt; the site is off when the root layout's robots is noindex or robots.txt disallows /; when a setting decides it (an environment variable in the layout or in app/robots.ts) the check is not sure; no sitemap passes",
  run(input, ctx) {
    const tree = input.tree;
    const files = [...tree.files.keys()].filter((p) => SITEMAP_FILE.test(p));
    const src = robotsSource(tree);
    const line = src?.robots?.sitemaps[0] !== undefined ? src.file : undefined;
    if (line !== undefined) files.push(line);
    if (files.length === 0) return [];
    const url = `source:${tree.label}`;
    const state = indexingOff(tree, appSegments(tree));
    if (state.state === "depends") {
      ctx.couldNotCheck?.(
        url,
        `${files[0] ?? "a sitemap"} exists, and whether the site is set to stay out of search depends on a setting (${state.why}), which Gaugeline does not run`,
      );
      return [];
    }
    if (state.state === "on") return [];
    const first = files[0] ?? "";
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${first}${files.length > 1 ? ` and ${files.length - 1} more` : ""} serves a sitemap while the site is set to stay out of search (${state.why})`,
        url,
        source: { file: first, line: 1 },
      },
    ];
  },
});
