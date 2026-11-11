import type { Transport } from "../../fetcher.js";
import { serve, sitemapIndex, urlset, type Reply } from "./sitemap-feed-fixture.js";

/**
 * Marlow Coaching's invented site: a one-person career-coaching practice whose freelancer built the site
 * on Wix. It has the files a Wix site publishes (a robots.txt that names /sitemap.xml, a sitemap index
 * with one file for the pages, one for the blog and one for the programs collection), a few pages made by
 * hand, and two CMS-backed groups whose pages live under a path of their own. Nothing here was recorded
 * from a real site. The text in the pages (titles, prices) is what an adapter must never return.
 */
export const MARLOW = "https://marlow-coaching.example";

export const MARLOW_MARKERS = {
  title: "Marlow Coaching, for people who quit on Friday and have no plan yet",
  program: "Spring cohort, 12 weeks, 1,450 pounds, starts when the sixth person signs",
  post: "What I tell every client on the first call about salary",
} as const;

const HOME = `<!doctype html><html><head><title>${MARLOW_MARKERS.title}</title>
<meta name="generator" content="Wix.com Website Builder"></head><body><h1>${MARLOW_MARKERS.title}</h1></body></html>`;

/** The healthy site's routes. A test changes one by spreading it into a new object. */
export function marlowRoutes(): Record<string, Reply> {
  return {
    "/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nAllow: /\nSitemap: ${MARLOW}/sitemap.xml\n`,
    },
    "/sitemap.xml": sitemapIndex([
      `${MARLOW}/pages-sitemap.xml`,
      `${MARLOW}/blog-posts-sitemap.xml`,
      `${MARLOW}/dynamic-programs-sitemap.xml`,
    ]),
    "/pages-sitemap.xml": urlset([
      { loc: `${MARLOW}/`, lastmod: "2026-11-02" },
      { loc: `${MARLOW}/about`, lastmod: "2026-09-14" },
      { loc: `${MARLOW}/book-a-call`, lastmod: "2026-11-08" },
    ]),
    "/blog-posts-sitemap.xml": urlset([
      { loc: `${MARLOW}/post/ninety-day-plan`, lastmod: "2026-10-19" },
      { loc: `${MARLOW}/post/salary-first-call`, lastmod: "2026-11-06" },
      { loc: `${MARLOW}/post/sunday-dread`, lastmod: "2026-08-30" },
    ]),
    "/dynamic-programs-sitemap.xml": urlset([
      { loc: `${MARLOW}/programs/spring-cohort`, lastmod: "2026-11-09" },
      { loc: `${MARLOW}/programs/one-to-one`, lastmod: "2026-10-28" },
    ]),
    "/": { status: 200, headers: { "content-type": "text/html" }, body: HOME },
    "/programs/spring-cohort": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${MARLOW_MARKERS.program}</body></html>`,
    },
    "/post/salary-first-call": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${MARLOW_MARKERS.post}</body></html>`,
    },
  };
}

/** The answers of the Marlow Coaching site: anything not listed is 404. Every request is a GET or HEAD answered from memory. */
export function marlowServe(routes: Readonly<Record<string, Reply>>): Transport {
  return serve(routes, new URL(MARLOW).host);
}

/** The site with these paths taken away. */
export function marlowWithout(...paths: string[]): Record<string, Reply> {
  return Object.fromEntries(Object.entries(marlowRoutes()).filter(([p]) => !paths.includes(p)));
}
