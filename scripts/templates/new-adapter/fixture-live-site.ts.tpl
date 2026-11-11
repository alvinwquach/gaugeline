import type { Transport } from "../../fetcher.js";
import { serve, urlset, type Reply } from "./sitemap-feed-fixture.js";

/**
 * Larkspur Yoga Studio's invented site: a small studio whose freelancer built the site on $NAME$. It has the
 * files a $NAME$ site publishes (a robots.txt that names /sitemap.xml, and the sitemap), pages made by
 * hand, and two folders of pages that come from the platform's content. Nothing here was recorded from a
 * real site. The text in the pages (titles, prices) is what an adapter must never return.
 *
 * TODO(new:adapter) match what a real $NAME$ site publishes: where its sitemap lives, and whether it
 * has a feed (read the platform's documentation, and put the date you checked on the docs page).
 */
export const $P$_SITE = "https://larkspur-yoga.example";

export const $P$_MARKERS = {
  title: "Larkspur Yoga Studio, classes for people who think they are not flexible",
  klass: "Morning flow: slow breathing, then one long sun salutation",
  teacher: "Ana teaches the early classes and runs the retreat",
} as const;

const HOME = `<!doctype html><html><head><title>${$P$_MARKERS.title}</title></head><body><h1>${$P$_MARKERS.title}</h1></body></html>`;

/** The healthy site's routes. A test changes one by spreading it into a new object. */
export function $CAMEL$Routes(): Record<string, Reply> {
  return {
    "/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nAllow: /\nSitemap: ${$P$_SITE}/sitemap.xml\n`,
    },
    "/sitemap.xml": urlset([
      { loc: `${$P$_SITE}/`, lastmod: "2026-11-02" },
      { loc: `${$P$_SITE}/about`, lastmod: "2026-09-14" },
      { loc: `${$P$_SITE}/visit`, lastmod: "2026-11-08" },
      { loc: `${$P$_SITE}/classes/morning-flow`, lastmod: "2026-10-19" },
      { loc: `${$P$_SITE}/classes/evening-stretch`, lastmod: "2026-11-06" },
      { loc: `${$P$_SITE}/teachers/ana`, lastmod: "2026-11-09" },
      { loc: `${$P$_SITE}/teachers/ben`, lastmod: "2026-10-28" },
    ]),
    "/": { status: 200, headers: { "content-type": "text/html" }, body: HOME },
    "/classes/morning-flow": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${$P$_MARKERS.klass}</body></html>`,
    },
    "/teachers/ana": {
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>${$P$_MARKERS.teacher}</body></html>`,
    },
  };
}

/** The answers of the Larkspur site: anything not listed is 404. Every request is a GET or HEAD answered from memory. */
export function $CAMEL$Serve(routes: Readonly<Record<string, Reply>>): Transport {
  return serve(routes, new URL($P$_SITE).host);
}

/** The site with these paths taken away. */
export function $CAMEL$Without(...paths: string[]): Record<string, Reply> {
  return Object.fromEntries(Object.entries($CAMEL$Routes()).filter(([p]) => !paths.includes(p)));
}
