import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Marigold Lane Community Theatre's invented Umbraco site: a volunteer-run theatre whose site a freelancer built on
 * Umbraco, with shows, cast members and news. Nothing here was recorded from a real site, and every address is on a
 * reserved `.example` domain. The answers have the shape of the Content Delivery API's list route (a `total` and
 * `items`, each with `id`, `contentType`, `name`, `createDate`, `updateDate`, `route` and `properties`); every
 * value is invented. The API is read from the same origin as the live site, as it is on a site Umbraco serves itself.
 */
export const UMBRACO_SITE = "https://marigold-lane.example";
export const UMBRACO_HOST = "marigold-lane.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const UMBRACO_MARKERS = {
  lantern: "The Lantern Keeper: a ghost story told with paper lanterns",
  lanternBlurb: "Seven nights in the village hall, tickets on the door",
  panto: "Winter panto: Jack and the Biscuit Tin",
  springDraft: "Spring show, cast not yet announced to the company",
  ines: "Ines plays the lantern keeper and chairs the committee",
  tomas: "Tomas runs the box office on Saturdays",
  closed: "The hall is closed for the whole of January",
} as const;

export interface FixtureNode {
  id: string;
  /** false: saved but never published. The public list never holds it; preview does. */
  published: boolean;
  slug: string;
  createDate: string;
  updateDate: string;
  /** Left out of the route when absent (a node with no page of its own). */
  routePath?: string | undefined;
  /** The route's start item path (the root node the path is relative to). Default "home"; null leaves the start item out. */
  startPath?: string | null | undefined;
  properties: Record<string, unknown>;
}

export interface FixtureType {
  alias: string;
  nodes: FixtureNode[];
}

const route = (path: string) => `/${path}/`;

export const UMBRACO_CONTENT: FixtureType[] = [
  {
    alias: "show",
    nodes: [
      {
        id: "3f6c8a10-5b7e-4c21-9d34-a1b2c3d4e5f6",
        published: true,
        slug: "the-lantern-keeper",
        createDate: "2026-09-01T09:00:00.000Z",
        updateDate: "2026-10-20T08:30:00.000Z",
        routePath: route("whats-on/the-lantern-keeper"),
        properties: {
          title: UMBRACO_MARKERS.lantern,
          blurb: UMBRACO_MARKERS.lanternBlurb,
          seats: 90,
        },
      },
      // No blurb: a field a node lacks is left out of its hashes, never hashed as empty.
      {
        id: "7a1e9b52-0c3d-4f68-8e47-b2c3d4e5f6a7",
        published: true,
        slug: "winter-panto",
        createDate: "2026-09-20T09:00:00.000Z",
        updateDate: "2026-11-02T17:00:00.000Z",
        routePath: route("whats-on/winter-panto"),
        properties: { title: UMBRACO_MARKERS.panto, seats: 120 },
      },
      // A draft: saved and not published. The published list never holds it.
      {
        id: "c9d2e4f6-1a3b-4c5d-9e7f-c3d4e5f6a7b8",
        published: false,
        slug: "spring-show",
        createDate: "2026-11-09T10:00:00.000Z",
        updateDate: "2026-11-09T10:00:00.000Z",
        routePath: route("whats-on/spring-show"),
        properties: { title: UMBRACO_MARKERS.springDraft },
      },
    ],
  },
  {
    alias: "notice",
    nodes: [
      {
        id: "d4e5f6a7-2b3c-4d5e-8f60-d4e5f6a7b8c9",
        published: true,
        slug: "closed-in-january",
        createDate: "2026-11-03T12:00:00.000Z",
        updateDate: "2026-11-03T12:00:00.000Z",
        routePath: route("news/closed-in-january"),
        properties: { title: UMBRACO_MARKERS.closed },
      },
    ],
  },
  {
    alias: "castMember",
    nodes: [
      {
        id: "e5f6a7b8-3c4d-4e5f-9061-e5f6a7b8c9d0",
        published: true,
        slug: "ines",
        createDate: "2026-06-01T09:00:00.000Z",
        updateDate: "2026-09-01T09:00:00.000Z",
        routePath: route("company/ines"),
        properties: { title: "Ines", bio: UMBRACO_MARKERS.ines },
      },
      {
        id: "f6a7b8c9-4d5e-4f60-a172-f6a7b8c9d0e1",
        published: true,
        slug: "tomas",
        createDate: "2026-10-10T09:00:00.000Z",
        updateDate: "2026-10-10T09:00:00.000Z",
        routePath: route("company/tomas"),
        properties: { title: "Tomas", bio: UMBRACO_MARKERS.tomas },
      },
    ],
  },
];

export interface UmbracoFixtureOptions {
  /** The Delivery API key. With `protectedApi`, a request without it is answered 401; preview always needs it. */
  apiKey?: string;
  /** The API's PublicAccess is off: every request needs the key. Default: public. */
  protectedApi?: boolean;
  /** The API is not switched on: every route answers 404. */
  off?: boolean;
  /** Every path answers 200 with a web page, as a site with a catch-all route does: the API list is not there. */
  catchAll?: boolean;
  /** Content types the key may not read: their list answers 403. */
  denied?: readonly string[];
  /** The most nodes one answer holds, whatever `take` asks for (the API may clamp). */
  maxTake?: number;
  /** Replace what the list route answers (a hostile or broken server). Called with the parsed query. */
  list?: (q: { filter: string; skip: number; take: number }) => unknown;
  /** Paths on the live site that answer 404 (a page that was never built). */
  missingPages?: readonly string[];
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const html = (status: number) =>
  Promise.resolve({
    status,
    headers: { "content-type": "text/html" },
    body: Readable.from([
      Buffer.from(status === 200 ? "<html><title>Page</title></html>" : "gone"),
    ]),
  });

/** The route's fields: only the properties a `fields=properties[a,b]` parameter names (`properties[]` names none). */
function wanted(fields: string | null, all: Record<string, unknown>): Record<string, unknown> {
  const m = /^properties\[(.*)\]$/.exec(fields ?? "");
  if (!m) return all;
  const names = (m[1] ?? "").split(",").filter((n) => n !== "");
  return Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k)));
}

/**
 * The Content Delivery API over the invented site, and its live pages. The list route answers a `filter` on
 * `contentType:<alias>`, `skip` and `take`, and only the requested properties. With the key and a `Preview: true`
 * header it also lists nodes that are not published; without them, only what is. Nothing but a GET is answered.
 */
export function umbracoTransport(
  content: readonly FixtureType[] = UMBRACO_CONTENT,
  options: UmbracoFixtureOptions = {},
): Transport {
  // The live site answers a page with or without its trailing slash, as an Umbraco site does.
  const bare = (path: string): string => (path.length > 1 ? path.replace(/\/$/, "") : path);
  const pagePaths = new Set(
    content.flatMap((t) => t.nodes.flatMap((n) => (n.routePath ? [bare(n.routePath)] : []))),
  );
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== UMBRACO_HOST) return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    if (url.pathname === "/umbraco/delivery/api/v2/content") {
      if (options.off === true) return html(404);
      if (options.catchAll === true) return html(200);
      const key = req.headers["api-key"];
      const hasKey = options.apiKey !== undefined && key === options.apiKey;
      if (key !== undefined && !hasKey) return json(401, { title: "Unauthorized" });
      const preview = (req.headers.preview ?? "") === "true";
      if (preview && !hasKey) return json(401, { title: "Unauthorized" });
      if (options.protectedApi === true && !hasKey) return json(401, { title: "Unauthorized" });
      const filter = url.searchParams.get("filter") ?? "";
      const skip = Number(url.searchParams.get("skip") ?? "0");
      const take = Number(url.searchParams.get("take") ?? "10");
      if (options.list) return json(200, options.list({ filter, skip, take }));
      const alias = /^contentType:(.+)$/.exec(filter)?.[1];
      if (alias !== undefined && (options.denied ?? []).includes(alias))
        return json(403, { title: "Forbidden" });
      const type = alias === undefined ? undefined : content.find((t) => t.alias === alias);
      const nodes = (
        alias === undefined ? content.flatMap((t) => t.nodes) : (type?.nodes ?? [])
      ).filter((n) => preview || n.published);
      const size = Math.min(take, options.maxTake ?? take);
      const typeOf = (n: FixtureNode) => content.find((t) => t.nodes.includes(n))?.alias ?? "";
      return json(200, {
        total: nodes.length,
        items: nodes.slice(skip, skip + size).map((n) => ({
          id: n.id,
          contentType: typeOf(n),
          name: String(n.properties.title ?? n.slug),
          createDate: n.createDate,
          updateDate: n.updateDate,
          route:
            n.routePath === undefined
              ? null
              : {
                  path: n.routePath,
                  ...(n.startPath === null
                    ? {}
                    : {
                        startItem: {
                          id: "00000000-0000-4000-8000-000000000001",
                          path: n.startPath ?? "home",
                        },
                      }),
                },
          properties: wanted(url.searchParams.get("fields"), n.properties),
          cultures: {},
        })),
      });
    }
    // The live site: a page the content gives an address for answers, unless it is listed as missing.
    const at = bare(url.pathname);
    if ((options.missingPages ?? []).map(bare).includes(at)) return html(404);
    if (pagePaths.has(at) || at === "/") return html(200);
    return html(404);
  };
}
