import type { Transport } from "../../fetcher.js";
import { serve, urlset, type Reply } from "./sitemap-feed-fixture.js";

/**
 * Tidewater Pop-Up's invented site: a weekend pop-up shop for sea-glass jewellery whose freelancer built
 * the site on Squarespace. It has what a Squarespace site publishes (a robots.txt that names
 * /sitemap.xml, the sitemap with a lastmod on each address, a blog) and pages of the shop. Nothing here
 * was recorded from a real site. The text in the pages (titles, prices) is what an adapter must never
 * return.
 */
export const TIDEWATER = "https://tidewater-popup.example";

export const TIDEWATER_MARKERS = {
  title: "Tidewater Pop-Up, sea-glass jewellery with a secret second stall",
  product: "Sea-glass pendant, 42 pounds, only nine made",
  post: "Why Saturday's market stall moved to the harbour",
} as const;

/** The home page of a Squarespace-style site: the generator tag and the hosts its assets come from. */
export const TIDEWATER_HOME = `<!doctype html><html><head><title>${TIDEWATER_MARKERS.title}</title>
<meta name="generator" content="Squarespace 7.1">
<link rel="stylesheet" href="https://static1.squarespace.com/static/sitecss/tidewater.css">
<link rel="canonical" href="${TIDEWATER}/"></head>
<body><h1>${TIDEWATER_MARKERS.title}</h1>
<img src="https://images.squarespace-cdn.com/content/pendant.jpg" alt="${TIDEWATER_MARKERS.product}"></body></html>`;

/** The healthy site's routes. A test changes one by spreading it into a new object. */
export function tidewaterRoutes(): Record<string, Reply> {
  return {
    "/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nAllow: /\nSitemap: ${TIDEWATER}/sitemap.xml\n`,
    },
    "/sitemap.xml": urlset([
      { loc: `${TIDEWATER}/`, lastmod: "2026-11-03" },
      { loc: `${TIDEWATER}/about`, lastmod: "2026-09-14" },
      { loc: `${TIDEWATER}/visit`, lastmod: "2026-11-08" },
      { loc: `${TIDEWATER}/shop/sea-glass-pendant`, lastmod: "2026-11-09" },
      { loc: `${TIDEWATER}/shop/driftwood-studs`, lastmod: "2026-10-12" },
      { loc: `${TIDEWATER}/blog/harbour-stall`, lastmod: "2026-11-06" },
    ]),
    "/": { status: 200, headers: { "content-type": "text/html" }, body: TIDEWATER_HOME },
    "/shop/sea-glass-pendant": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${TIDEWATER_MARKERS.product}</body></html>`,
    },
    "/blog/harbour-stall": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${TIDEWATER_MARKERS.post}</body></html>`,
    },
  };
}

/** The answers of the Tidewater site: anything not listed is 404. Every request is a GET or HEAD answered from memory. */
export function tidewaterServe(routes: Readonly<Record<string, Reply>>): Transport {
  return serve(routes, new URL(TIDEWATER).host);
}

/** The site with these paths taken away. */
export function tidewaterWithout(...paths: string[]): Record<string, Reply> {
  return Object.fromEntries(Object.entries(tidewaterRoutes()).filter(([p]) => !paths.includes(p)));
}
