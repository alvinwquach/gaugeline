import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Larkspur Yoga Studio's invented Sitecore XM Cloud site: a small studio whose site a freelancer built on XM Cloud,
 * with a Sitecore site named `larkspur` in two languages (en and fr-CA). Nothing here was recorded from a real
 * site: the answers are in the shape of the Experience Edge Delivery API (a POST to /api/graphql/v1 with the token
 * in the sc_apikey header; `site { siteInfo(site) { routes(language, first, after) { total pageInfo { endCursor
 * hasNext } results { routePath } } } }`), with invented values on reserved `.example` domains. The Delivery API
 * only answers for content published to Edge, so a draft is not in the answer at all.
 */
export const LARKSPUR_SITE = "https://larkspur-yoga.example";
export const EDGE_HOST = "edge.sitecorecloud.io";
export const EDGE_URL = `https://${EDGE_HOST}/api/graphql/v1`;
export const SITE_NAME = "larkspur";

/** Text that is in the client's content and must never reach a report, a log or a hash input. */
export const SITECORE_MARKERS = {
  morning: "Morning flow: slow breathing, then one long sun salutation",
  evening: "Evening stretch for people who sit all day",
  retreat: "Autumn retreat, deposit not yet announced",
  ana: "Ana teaches the early classes and runs the retreat",
  notice: "The studio is closed on the last Friday of November",
} as const;

/** The routes Experience Edge says are published for each language. Paths are the same in every language. */
export interface FixtureRoute {
  routePath: string;
  /** Text of the page. The route query never asks for it, so a healthy answer never carries it. */
  displayName: string;
}

export const SITECORE_CONTENT: Readonly<Record<string, readonly FixtureRoute[]>> = {
  en: [
    { routePath: "/", displayName: "Larkspur Yoga Studio" },
    { routePath: "/classes", displayName: "Classes" },
    { routePath: "/classes/morning-flow", displayName: SITECORE_MARKERS.morning },
    { routePath: "/classes/evening-stretch", displayName: SITECORE_MARKERS.evening },
    { routePath: "/teachers/ana", displayName: SITECORE_MARKERS.ana },
    { routePath: "/notices/closed-last-friday", displayName: SITECORE_MARKERS.notice },
  ],
  // The retreat page exists in the CMS in French only as a draft: Edge does not have it.
  "fr-CA": [
    { routePath: "/", displayName: "Studio de yoga Larkspur" },
    { routePath: "/classes", displayName: "Cours" },
    { routePath: "/classes/morning-flow", displayName: "Flux du matin" },
  ],
};

/** What the live site answers, by address: 200 for a page that is there. Anything not listed is 404. */
export const PAGES_HEALTHY: Readonly<Record<string, number>> = {
  [`${LARKSPUR_SITE}/`]: 200,
  [`${LARKSPUR_SITE}/classes`]: 200,
  [`${LARKSPUR_SITE}/classes/morning-flow`]: 200,
  [`${LARKSPUR_SITE}/classes/evening-stretch`]: 200,
  [`${LARKSPUR_SITE}/teachers/ana`]: 200,
  [`${LARKSPUR_SITE}/notices/closed-last-friday`]: 200,
  [`${LARKSPUR_SITE}/fr-ca/`]: 200,
  [`${LARKSPUR_SITE}/fr-ca/classes`]: 200,
  [`${LARKSPUR_SITE}/fr-ca/classes/morning-flow`]: 200,
};

/** The same site after the front end lost two pages: published to Edge, not on the live site. */
export const PAGES_DRIFT: Readonly<Record<string, number>> = {
  ...PAGES_HEALTHY,
  [`${LARKSPUR_SITE}/classes/evening-stretch`]: 404,
  [`${LARKSPUR_SITE}/fr-ca/classes/morning-flow`]: 410,
};

/** What the preview path answers on the live site's own host. */
export type PreviewState =
  "absent" | "protected" | "graphql" | "graphql-bad-request" | "soft-200" | "error";

/** One request to the Delivery API, as the fixture parsed it. */
export interface EdgeCall {
  site: string;
  language: string;
  first: number;
  after: string;
  /** The key as sent in the sc_apikey header, or undefined. */
  key: string | undefined;
}

export interface SitecoreFixtureOptions {
  /** When set, a request without this `sc_apikey` is answered 401. */
  token?: string;
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>, body?: string) => void;
  /** Largest page the fixture gives, whatever `first` says. Default 1000, the platform's own maximum. */
  maxPage?: number;
  /** What the live site's pages answer. Default: nothing is there (404). */
  pages?: Readonly<Record<string, number>>;
  /** What the preview path (/sitecore/api/graph/edge) answers on the live site. Default: absent (404). */
  preview?: PreviewState;
  /** Take over an Edge answer: return a JSON body (status 200), or `{ status, body }`, or undefined for the normal answer. */
  respond?: (call: EdgeCall, n: number) => unknown;
}

const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers,
    body: Readable.from([Buffer.from(body)]),
  });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  reply(status, JSON.stringify(body), { "content-type": "application/json", ...headers });

const cursorOf = (n: number): string => Buffer.from(`offset:${n}`).toString("base64");
const offsetOf = (cursor: string): number => {
  if (cursor === "") return 0;
  const m = /^offset:(\d+)$/.exec(Buffer.from(cursor, "base64").toString("utf8"));
  return m ? Number(m[1]) : -1;
};

/**
 * Experience Edge's Delivery API over the invented site, and the live site's pages. The Delivery API answers a POST
 * and nothing else, needs the sc_apikey header, gives at most `maxPage` routes a page with `total`, `pageInfo` and
 * `results`, and answers 200 with `errors` for a query it rejects (the way a GraphQL server does).
 */
export function sitecoreTransport(
  content: Readonly<Record<string, readonly FixtureRoute[]>> = SITECORE_CONTENT,
  options: SitecoreFixtureOptions = {},
): Transport {
  let calls = 0;
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers, req.body);
    if (url.host === EDGE_HOST) {
      if (url.pathname !== "/api/graphql/v1") return json(404, { message: "no such route" });
      if (req.method !== "POST") return json(405, { message: "method not allowed" });
      const key = req.headers["sc_apikey"];
      if (options.token !== undefined && key !== options.token)
        return json(401, { message: "Unauthorized" });
      let parsed: {
        query?: string;
        variables?: { site?: string; language?: string; pageSize?: number; after?: string };
      };
      try {
        parsed = JSON.parse(req.body ?? "") as typeof parsed;
      } catch {
        return json(400, { errors: [{ message: "bad body" }] });
      }
      const v = parsed.variables ?? {};
      if (!/^query /.test(parsed.query ?? ""))
        return json(200, { errors: [{ message: "not a query" }] });
      const call: EdgeCall = {
        site: String(v.site),
        language: String(v.language),
        first: Number(v.pageSize),
        after: String(v.after ?? ""),
        key,
      };
      const custom = options.respond?.(call, calls++);
      if (custom !== undefined) {
        const c = custom as { status?: number; body?: unknown; headers?: Record<string, string> };
        return typeof c.status === "number"
          ? json(c.status, c.body ?? {}, c.headers ?? {})
          : json(200, custom);
      }
      if (call.site !== SITE_NAME) return json(200, { data: { site: { siteInfo: null } } });
      const routes = content[call.language];
      if (routes === undefined)
        return json(200, {
          data: {
            site: {
              siteInfo: {
                routes: { total: 0, pageInfo: { endCursor: "", hasNext: false }, results: [] },
              },
            },
          },
        });
      const limit = Math.min(call.first, options.maxPage ?? 1000);
      if (!Number.isInteger(call.first) || call.first < 1 || call.first > 1000)
        return json(200, { errors: [{ message: "first must be 1 to 1000" }] });
      const at = offsetOf(call.after);
      if (at < 0) return json(200, { errors: [{ message: "bad cursor" }] });
      const page = routes.slice(at, at + limit);
      const next = at + page.length;
      const hasNext = next < routes.length;
      return json(200, {
        data: {
          site: {
            siteInfo: {
              routes: {
                total: routes.length,
                pageInfo: { endCursor: cursorOf(next), hasNext },
                results: page.map((r) => ({ routePath: r.routePath })),
              },
            },
          },
        },
      });
    }
    if (url.host === new URL(LARKSPUR_SITE).host) {
      if (req.method !== "GET" && req.method !== "HEAD") return json(405, {});
      if (url.pathname === "/sitecore/api/graph/edge") {
        switch (options.preview ?? "absent") {
          case "absent":
            return reply(404, "not found", { "content-type": "text/html" });
          case "protected":
            return json(401, { errors: [{ message: "An API key is required" }] });
          case "graphql":
            return json(200, { data: null, errors: [{ message: "Must provide query string." }] });
          case "graphql-bad-request":
            return json(400, { errors: [{ message: "Must provide query string." }] });
          case "soft-200":
            return reply(200, "<html><body>Welcome</body></html>", { "content-type": "text/html" });
          case "error":
            return reply(503, "unavailable", { "content-type": "text/plain" });
        }
      }
      const status = options.pages?.[url.href] ?? 404;
      return reply(status, status < 300 ? "<html><body>page</body></html>" : "not found", {
        "content-type": "text/html",
      });
    }
    return json(404, { message: "not here" });
  };
}
