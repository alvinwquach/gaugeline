import type { Transport } from "../../fetcher.js";
import { serve, urlset, type Reply } from "./sitemap-feed-fixture.js";

/**
 * Lantern Row's invented site: a ceramics pop-up shop whose freelancer built the site on Framer. It has
 * the files a Framer site publishes (a robots.txt that names /sitemap.xml, and the sitemap), pages made
 * by hand, and two CMS collections, a journal and a drops collection, whose pages live under the
 * collection's path. Nothing here was recorded from a real site. The text in the pages (titles, prices)
 * is what an adapter must never return.
 */
export const LANTERN = "https://lantern-row.example";

export const LANTERN_MARKERS = {
  title: "Lantern Row, a ceramics pop-up with a secret second location",
  drop: "Moonglaze mug set, 38 pounds, only twelve made",
  journal: "Why the autumn kiln firing was delayed",
} as const;

const HOME = `<!doctype html><html><head><title>${LANTERN_MARKERS.title}</title>
<meta name="generator" content="Framer 0a1b2c3"></head><body><h1>${LANTERN_MARKERS.title}</h1></body></html>`;

/** The healthy site's routes. A test changes one by spreading it into a new object. */
export function lanternRoutes(): Record<string, Reply> {
  return {
    "/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nAllow: /\nSitemap: ${LANTERN}/sitemap.xml\n`,
    },
    "/sitemap.xml": urlset([
      { loc: `${LANTERN}/`, lastmod: "2026-11-02" },
      { loc: `${LANTERN}/about`, lastmod: "2026-09-14" },
      { loc: `${LANTERN}/visit`, lastmod: "2026-11-08" },
      { loc: `${LANTERN}/journal/kiln-firing`, lastmod: "2026-10-19" },
      { loc: `${LANTERN}/journal/glaze-notes`, lastmod: "2026-11-06" },
      { loc: `${LANTERN}/drops/moonglaze-mugs`, lastmod: "2026-11-09" },
      { loc: `${LANTERN}/drops/ember-bowls`, lastmod: "2026-10-28" },
    ]),
    "/": { status: 200, headers: { "content-type": "text/html" }, body: HOME },
    "/drops/moonglaze-mugs": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${LANTERN_MARKERS.drop}</body></html>`,
    },
    "/journal/kiln-firing": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${LANTERN_MARKERS.journal}</body></html>`,
    },
  };
}

/** The answers of the Lantern Row site: anything not listed is 404. Every request is a GET or HEAD answered from memory. */
export function lanternServe(routes: Readonly<Record<string, Reply>>): Transport {
  return serve(routes, new URL(LANTERN).host);
}

/** The site with these paths taken away. */
export function lanternWithout(...paths: string[]): Record<string, Reply> {
  return Object.fromEntries(Object.entries(lanternRoutes()).filter(([p]) => !paths.includes(p)));
}
