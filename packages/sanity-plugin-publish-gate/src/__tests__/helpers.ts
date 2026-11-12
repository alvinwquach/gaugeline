import { Readable } from "node:stream";
import type { Transport } from "@gaugeline/core";

/** An invented bar's site, held in memory: no socket and no DNS. Every request is written to `seen`. */
export const SITE = "https://lantern-yard.example";

export interface MemoryPage {
  status?: number;
  body: string;
  type?: string;
}

const HEAD =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';

const FILLER =
  "Lantern Yard is an invented neighbourhood bar with a short list of cocktails, a changing menu of small plates, a quiz on Thursdays and a back room that seats twenty. " +
  "The kitchen opens at five, the bar at four, and the last order is half an hour before closing. Bookings for groups are taken by email and answered the same day. " +
  "Gift cards, cocktail kits and tickets for tasting nights are sold in the shop and posted within two working days.";

/** A page with every basic in place, so a finding in a test is the one the test planted. */
export function page(path: string, title: string, body: string): MemoryPage {
  return {
    body:
      `<!doctype html><html lang="en"><head>${HEAD}<title>${title} | Lantern Yard</title>` +
      `<meta name="description" content="${title} at Lantern Yard, an invented bar used in tests.">` +
      `<meta property="og:image" content="${SITE}/share.png">` +
      `<link rel="canonical" href="${SITE}${path}"></head><body><main><h1>${title}</h1><p>${FILLER}</p>${body}</main></body></html>`,
  };
}

/** The bar's site: a home page, a menu page whose body the test chooses, robots.txt and a sitemap. */
export function barSite(menuBody: string, extra: Readonly<Record<string, MemoryPage>> = {}) {
  return {
    "/": page("/", "Lantern Yard", '<a href="/menu">Menu</a>'),
    "/menu": page("/menu", "Menu", menuBody),
    "/robots.txt": {
      body: `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`,
      type: "text/plain",
    },
    "/sitemap.xml": {
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc></url><url><loc>${SITE}/menu</loc></url></urlset>`,
      type: "application/xml",
    },
    "/share.png": { body: "png", type: "image/png" },
    ...extra,
  } satisfies Record<string, MemoryPage>;
}

export function memorySite(
  pages: Readonly<Record<string, MemoryPage>>,
  seen: { method: string; url: string }[] = [],
): Transport {
  return (url, req) => {
    seen.push({ method: req.method, url: url.href });
    // Any other name (www., staging., a link to another site) answers 404 with a short page.
    if (url.hostname !== new URL(SITE).hostname)
      return Promise.resolve({
        status: 404,
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from("<!doctype html><title>Not found</title>")]),
      });
    const hit = pages[url.pathname];
    const status = hit?.status ?? (hit ? 200 : 404);
    const body =
      req.method === "HEAD" ? "" : (hit?.body ?? "<!doctype html><title>Not found</title>");
    return Promise.resolve({
      status,
      headers: { "content-type": hit?.type ?? "text/html; charset=utf-8" },
      body: Readable.from([Buffer.from(body)]),
    });
  };
}

/** A transport for a site that does not answer at all. */
export const downSite: Transport = () =>
  Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
