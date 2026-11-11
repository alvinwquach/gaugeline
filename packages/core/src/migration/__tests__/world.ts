import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * The invented world the migration tests and docs run in, answered from recorded responses (nothing
 * touches a network). Wren Bakehouse, an invented bakery in Leith, is moving from WordPress (the live
 * site, wrenbakehouse.example) to a Next.js and Sanity build on a preview address. The old site's REST
 * API lists twelve published items: four pages and eight posts. The new site, on 11 Nov 2026:
 *  - leaves out /wholesale/ and /2026/04/christmas-orders/ (404);
 *  - changes the title of /2026/08/new-rye-loaf/;
 *  - sends /2026/06/cardamom-buns/ through two redirects;
 *  - points the canonical of /2026/03/flour-supplier/ at the blog index;
 *  - drops the FAQPage structured data of /2026/05/wedding-cakes/;
 *  - answers the rest in one hop or none, with the title, canonical and structured data kept.
 */
export const OLD_ORIGIN = "https://wrenbakehouse.example";
export const NEW_ORIGIN = "https://preview.wrenbakehouse.example";

export interface Item {
  /** The old address's path, as WordPress writes it. */
  path: string;
  kind: "post" | "page";
  /** The title as the WordPress API returns it (title.rendered), entities and all. */
  rendered: string;
  /** The old page's <title>. */
  oldTitle: string;
  oldTypes: string[];
  /** How the new site answers this path. */
  now:
    | { status: 404 }
    | {
        /** Each redirect in turn, then the page. */
        via: string[];
        title: string;
        h1?: string;
        /** The canonical as a path; absent: none. */
        canonical?: string;
        types: string[];
      };
}

const SITE = "Wren Bakehouse";

const kept = (path: string, over: Partial<Extract<Item["now"], { via: string[] }>> = {}) => ({
  via: [] as string[],
  title: "",
  canonical: path,
  types: [] as string[],
  ...over,
});

/** The twelve items, in the order the API returns them: pages, then posts. */
export const ITEMS: readonly Item[] = [
  {
    path: "/",
    kind: "page",
    rendered: "Home",
    oldTitle: SITE,
    oldTypes: ["WebSite", "WebPage"],
    now: kept("/", { title: `${SITE} | Sourdough and rye in Leith`, types: ["Bakery"] }),
  },
  {
    path: "/about/",
    kind: "page",
    rendered: "About us",
    oldTitle: `About us - ${SITE}`,
    oldTypes: ["WebPage"],
    now: kept("/about", { via: ["/about"], title: `About us | ${SITE}` }),
  },
  {
    path: "/opening-hours/",
    kind: "page",
    rendered: "Opening hours",
    oldTitle: `Opening hours - ${SITE}`,
    oldTypes: ["WebPage"],
    now: kept("/opening-hours/", { title: `Opening hours | ${SITE}` }),
  },
  {
    path: "/wholesale/",
    kind: "page",
    rendered: "Wholesale orders",
    oldTitle: `Wholesale orders - ${SITE}`,
    oldTypes: ["WebPage"],
    now: { status: 404 },
  },
  {
    path: "/2026/09/sourdough-saturdays/",
    kind: "post",
    rendered: "Sourdough Saturdays",
    oldTitle: `Sourdough Saturdays - ${SITE}`,
    oldTypes: ["Article"],
    now: kept("/blog/sourdough-saturdays", {
      via: ["/blog/sourdough-saturdays"],
      title: `Sourdough Saturdays | ${SITE}`,
      types: ["Article"],
    }),
  },
  {
    path: "/2026/08/new-rye-loaf/",
    kind: "post",
    rendered: "The new rye loaf",
    oldTitle: `The new rye loaf - ${SITE}`,
    oldTypes: ["Article"],
    now: kept("/blog/new-rye-loaf", {
      via: ["/blog/new-rye-loaf"],
      title: `Our rye, reworked | ${SITE}`,
      types: ["Article"],
    }),
  },
  {
    path: "/2026/07/market-stall-summer/",
    kind: "post",
    rendered: "Cardamom buns &amp; summer hours at the market stall",
    oldTitle: `Cardamom buns & summer hours at the market stall - ${SITE}`,
    oldTypes: ["Article"],
    now: kept("/blog/market-stall-summer", {
      via: ["/blog/market-stall-summer"],
      title: `Cardamom buns & summer hours at the market stall | ${SITE}`,
      types: ["Article"],
    }),
  },
  {
    path: "/2026/06/cardamom-buns/",
    kind: "post",
    rendered: "Cardamom buns",
    oldTitle: `Cardamom buns - ${SITE}`,
    oldTypes: ["Article"],
    now: kept("/blog/cardamom-buns", {
      via: ["/cardamom-buns", "/blog/cardamom-buns"],
      title: `Cardamom buns | ${SITE}`,
      types: ["Article"],
    }),
  },
  {
    path: "/2026/05/wedding-cakes/",
    kind: "post",
    rendered: "Wedding cakes",
    oldTitle: `Wedding cakes - ${SITE}`,
    oldTypes: ["Article", "FAQPage"],
    now: kept("/blog/wedding-cakes", {
      via: ["/blog/wedding-cakes"],
      title: `Wedding cakes | ${SITE}`,
      types: ["Article"],
    }),
  },
  {
    path: "/2026/04/christmas-orders/",
    kind: "post",
    rendered: "Christmas orders are open",
    oldTitle: `Christmas orders are open - ${SITE}`,
    oldTypes: ["Article"],
    now: { status: 404 },
  },
  {
    path: "/2026/03/flour-supplier/",
    kind: "post",
    rendered: "Our flour supplier",
    oldTitle: `Our flour supplier - ${SITE}`,
    oldTypes: ["Article"],
    now: kept("/blog/flour-supplier", {
      via: ["/blog/flour-supplier"],
      title: `Our flour supplier | ${SITE}`,
      canonical: "/blog",
      types: ["Article"],
    }),
  },
  {
    path: "/2026/02/sourdough-starter-tips/",
    kind: "post",
    rendered: "Sourdough starter tips",
    oldTitle: `Sourdough starter tips - ${SITE}`,
    oldTypes: ["Article"],
    now: kept("/blog/sourdough-starter-tips", {
      via: ["/blog/sourdough-starter-tips"],
      title: `Sourdough starter tips | ${SITE}`,
      types: ["Article"],
    }),
  },
];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A page the way the old WordPress theme or the new build writes it. */
export function pageHtml(opts: {
  title: string;
  h1?: string;
  canonical?: string;
  types: readonly string[];
}): string {
  const ld = opts.types.map(
    (t) =>
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"${t}"}</script>`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>${
    opts.canonical === undefined ? "" : `<link rel="canonical" href="${opts.canonical}">`
  }${ld.join("")}</head><body><h1>${esc(opts.h1 ?? opts.title.split(" | ")[0]?.split(" - ")[0] ?? opts.title)}</h1><p>Wren Bakehouse, Leith.</p></body></html>`;
}

/** The WordPress REST API's answer for one kind, with the fields Gaugeline asks for. */
export function wpBody(kind: "post" | "page", items: readonly Item[] = ITEMS): string {
  return JSON.stringify(
    items
      .filter((i) => i.kind === kind)
      .map((i) => ({
        link: `${OLD_ORIGIN}${i.path}`,
        type: kind,
        status: "publish",
        title: { rendered: i.rendered },
      })),
  );
}

export interface Recorded {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface Seen {
  method: string;
  url: string;
}

export interface World {
  transport: Transport;
  seen: Seen[];
}

/**
 * The old site, the new site and nothing else. `routes` adds or replaces an answer by
 * "https://host/path"; `items` changes what the new site and the old pages say; `wordpress: false`
 * makes the old site a site with no REST API (a 404 at /wp-json).
 */
export function world(
  over: {
    items?: readonly Item[];
    routes?: Record<string, Recorded>;
    wordpress?: boolean;
    /** Answer the old site's pages with this status instead (a site that is already switched off). */
    oldPages?: number;
  } = {},
): World {
  const items = over.items ?? ITEMS;
  const routes: Record<string, Recorded> = {};
  const html = { "content-type": "text/html; charset=utf-8" };
  if (over.wordpress !== false) {
    for (const kind of ["post", "page"] as const)
      routes[`${OLD_ORIGIN}/wp-json/wp/v2/${kind}s`] = {
        status: 200,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-wp-total": String(items.filter((i) => i.kind === kind).length),
          "x-wp-totalpages": "1",
        },
        body: wpBody(kind, items),
      };
  }
  for (const i of items) {
    routes[`${OLD_ORIGIN}${i.path}`] = {
      status: over.oldPages ?? 200,
      headers: html,
      body: pageHtml({ title: i.oldTitle, canonical: `${OLD_ORIGIN}${i.path}`, types: i.oldTypes }),
    };
    if ("status" in i.now) continue;
    const hops = [i.path, ...i.now.via];
    hops.forEach((from, n) => {
      const to = hops[n + 1];
      routes[`${NEW_ORIGIN}${from}`] =
        to === undefined
          ? {
              status: 200,
              headers: html,
              body: pageHtml({
                title: (i.now as { title: string }).title,
                ...((i.now as { canonical?: string }).canonical === undefined
                  ? {}
                  : { canonical: `${OLD_ORIGIN}${(i.now as { canonical: string }).canonical}` }),
                types: (i.now as { types: string[] }).types,
              }),
            }
          : { status: 301, headers: { location: to } };
    });
  }
  Object.assign(routes, over.routes);
  const seen: Seen[] = [];
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    const hit = routes[url.href] ?? routes[url.href.replace(/\?.*$/, "")];
    return Promise.resolve({
      status: hit?.status ?? 404,
      headers: { "content-type": "text/plain", ...hit?.headers },
      body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from(hit?.body ?? "not found")]),
    });
  };
  return { transport, seen };
}

/** The same twelve items with every problem fixed: the new site as it should be. */
export const FIXED: readonly Item[] = ITEMS.map((i): Item => {
  const now = i.now;
  const fix = (path: string, title: string): Item["now"] => ({
    via: [`/blog${path.replace(/^\/\d{4}\/\d{2}/, "").replace(/\/$/, "")}`],
    title,
    types: i.oldTypes.filter((t) => t !== "WebSite" && t !== "WebPage"),
    canonical: `/blog${path.replace(/^\/\d{4}\/\d{2}/, "").replace(/\/$/, "")}`,
  });
  if ("status" in now)
    return {
      ...i,
      now:
        i.kind === "page"
          ? { via: [], title: i.oldTitle, canonical: i.path, types: [] }
          : fix(i.path, i.oldTitle),
    };
  if (i.path === "/2026/08/new-rye-loaf/") return { ...i, now: { ...now, title: i.oldTitle } };
  if (i.path === "/2026/06/cardamom-buns/")
    return { ...i, now: { ...now, via: [now.via[1] ?? ""] } };
  if (i.path === "/2026/05/wedding-cakes/") return { ...i, now: { ...now, types: i.oldTypes } };
  if (i.path === "/2026/03/flour-supplier/")
    return { ...i, now: { ...now, canonical: now.via[0] ?? "" } };
  return i;
});
