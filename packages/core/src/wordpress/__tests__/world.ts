import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * The invented world the WordPress check tests run in. Nothing touches a network. The answers of
 * api.wordpress.org are written by hand in the shape its endpoints are known to use, because the API was not
 * reachable from the build session to record real ones; the sites are invented clients of an invented
 * freelancer: a bar, a clinic and a bakery.
 */
export const RECORDED_WPORG = {
  core: {
    offers: [{ response: "upgrade", version: "6.8.3", current: "6.8.3", php_version: "7.2.24" }],
  },
  plugins: {
    "easy-booking": { name: "Easy Booking", slug: "easy-booking", version: "2.4.0" },
    "gallery-lite": { name: "Gallery Lite", slug: "gallery-lite", version: "1.3.0" },
    elementor: { name: "Elementor", slug: "elementor", version: "3.25.4" },
    "table-chairs": { name: "Table Chairs", slug: "table-chairs", version: "5.10" },
  } as Record<string, unknown>,
  themes: {
    "twenty-twenty-four": {
      name: "Twenty Twenty-Four",
      slug: "twenty-twenty-four",
      version: "1.3",
    },
  } as Record<string, unknown>,
};

const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(body)]),
  });

export interface Seen {
  method: string;
  url: string;
}

export interface WpOrgOptions {
  /** api.wordpress.org is unreachable. */
  down?: boolean;
  /** The core answer, replacing the recorded one. */
  core?: unknown;
}

/** api.wordpress.org: the core version check, and the plugin and theme information routes. */
function wpOrg(url: URL, opts: WpOrgOptions) {
  if (opts.down)
    return Promise.reject(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
  if (url.pathname === "/core/version-check/1.7/")
    return respond(200, JSON.stringify(opts.core ?? RECORDED_WPORG.core));
  const m = /^\/(plugins|themes)\/info\/1\.2\/$/.exec(url.pathname);
  if (m) {
    const slug = url.searchParams.get("request[slug]") ?? "";
    const known = (m[1] === "plugins" ? RECORDED_WPORG.plugins : RECORDED_WPORG.themes)[slug];
    if (known !== undefined) return respond(200, JSON.stringify(known));
    // Plugins answer an unknown slug with 404 and an error object, themes with 200 and one.
    return m[1] === "plugins"
      ? respond(404, JSON.stringify({ error: "Plugin not found." }))
      : respond(200, JSON.stringify({ error: "Theme not found." }));
  }
  return respond(404, "{}");
}

export interface Route {
  status?: number;
  type?: string;
  body: string;
}

export interface SiteDef {
  headers?: Record<string, string>;
  routes: Record<string, Route | string>;
}

/** Sites by host, and api.wordpress.org. Every request is recorded. */
export function wpWorld(
  sites: Record<string, SiteDef>,
  wporg: WpOrgOptions = {},
): { transport: Transport; seen: Seen[] } {
  const seen: Seen[] = [];
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    if (url.hostname === "api.wordpress.org") return wpOrg(url, wporg);
    const site = sites[url.hostname];
    if (!site)
      return Promise.reject(
        Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
      );
    const key = `${url.pathname}${url.search}`;
    const route = site.routes[key] ?? site.routes[url.pathname];
    if (route === undefined)
      return respond(404, "<!doctype html><title>Not found</title>", {
        ...site.headers,
        "content-type": "text/html",
      });
    const r: Route = typeof route === "string" ? { body: route } : route;
    const isJson = r.type === undefined && r.body.startsWith("[") ? true : false;
    return respond(r.status ?? 200, r.body, {
      ...site.headers,
      "content-type": r.type ?? (isJson ? "application/json" : "text/html; charset=utf-8"),
    });
  };
  return { transport, seen };
}

/** Enough invented words for the page check not to call the page empty. */
const BODY = `<p>${"A small harbour bar with a short menu of cocktails, local beer and plates to share. We open at four on weekdays and at noon at the weekend, and the back room can be hired for birthdays and small parties of up to forty guests. Tables for two to eight can be booked on this site. ".repeat(2)}</p>`;

/** A page of HTML for an invented WordPress site: its head markup and the files it loads. */
export function wpPage(opts: {
  title?: string;
  generator?: string | null;
  /** Plugin files, as [slug, ver] with ver null for no query. */
  plugins?: [string, string | null][];
  themes?: [string, string | null][];
  coreVer?: string | null;
  restLink?: string;
}): string {
  const asset = (kind: string, [slug, ver]: [string, string | null], file: string) =>
    `<link rel="stylesheet" href="/wp-content/${kind}/${slug}/${file}${ver === null ? "" : `?ver=${ver}`}">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="/"><meta property="og:image" content="/og.png"><title>${opts.title ?? "Harbour Bar"}</title>${
    opts.generator === null
      ? ""
      : `<meta name="generator" content="${opts.generator ?? "WordPress 6.2.1"}">`
  }<link rel="https://api.w.org/" href="${opts.restLink ?? "/wp-json/"}">${
    opts.coreVer === undefined
      ? ""
      : `<link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css${opts.coreVer === null ? "" : `?ver=${opts.coreVer}`}">`
  }${(opts.plugins ?? []).map((p) => asset("plugins", p, "css/style.css")).join("")}${(
    opts.themes ?? []
  )
    .map((t) => asset("themes", t, "style.css"))
    .join("")}</head><body><h1>${opts.title ?? "Harbour Bar"}</h1>${BODY}</body></html>`;
}

const usersJson = (n: number): string =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i + 1 })));

export const ROUTES = {
  usersOpen: { "/wp-json/wp/v2/users": { body: usersJson(2), type: "application/json" } },
  usersClosed: {
    "/wp-json/wp/v2/users": {
      status: 401,
      type: "application/json",
      body: JSON.stringify({
        code: "rest_cannot_list_users",
        message: "Sorry, you are not allowed to list users.",
      }),
    },
  },
};

export { usersJson };
