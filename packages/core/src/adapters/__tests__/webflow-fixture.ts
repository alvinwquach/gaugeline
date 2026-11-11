import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Saltmarsh Supper Club's invented Webflow site: a pop-up dinner club whose site a freelancer built
 * on Webflow, with a CMS of events, menu items and testimonials. Nothing here was recorded from a real
 * site; the answers are in the shape of Webflow's Data API v2 as the build knew it (the platform's
 * pages could not be reached, see docs/integrations/webflow.md). Every address is on a reserved
 * `.example` domain.
 */
export const SALTMARSH_SITE = "https://saltmarsh-supper.example";
export const SALTMARSH_HOST = "saltmarsh-supper.example";
export const SITE_ID = "6561a0c2e5b3d7a9c8e4b001";

export const COLLECTION_IDS = {
  events: "6561a0c2e5b3d7a9c8e4c001",
  menu: "6561a0c2e5b3d7a9c8e4c002",
  testimonials: "6561a0c2e5b3d7a9c8e4c003",
} as const;

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const WEBFLOW_MARKERS = {
  harvest: "Harvest table: twelve seats on one long bench",
  harvestSummary: "Long table, five courses, cider from the next village",
  oyster: "Oyster night at the old boathouse",
  winter: "Winter warmer: braised shin and hot chocolate",
  newYear: "New Year's feast, menu still secret",
  summer: "Summer supper on the quay",
  trout: "Smoked trout, pickled beetroot",
  troutNewPrice: "Smoked trout now 17 per plate",
  leek: "Burnt leek, whipped goat's curd",
  quote: "Best table I have sat at all year",
} as const;

export interface FixtureItem {
  id: string;
  isDraft: boolean;
  isArchived: boolean;
  lastPublished: string | null;
  lastUpdated: string;
  createdOn: string;
  fieldData: Record<string, unknown>;
}

export interface FixtureCollection {
  id: string;
  displayName: string;
  singularName: string;
  slug: string;
  items: FixtureItem[];
}

function item(
  id: string,
  fieldData: Record<string, unknown>,
  state: {
    isDraft?: boolean;
    isArchived?: boolean;
    lastPublished?: string | null;
    lastUpdated: string;
  },
): FixtureItem {
  return {
    id,
    isDraft: state.isDraft ?? false,
    isArchived: state.isArchived ?? false,
    lastPublished: state.lastPublished === undefined ? null : state.lastPublished,
    lastUpdated: state.lastUpdated,
    createdOn: "2026-05-01T10:00:00.000Z",
    fieldData,
  };
}

export const SALTMARSH: FixtureCollection[] = [
  {
    id: COLLECTION_IDS.testimonials,
    displayName: "Testimonials",
    singularName: "Testimonial",
    slug: "testimonials",
    items: [
      item(
        "t-1",
        { name: "A regular", slug: "a-regular", quote: WEBFLOW_MARKERS.quote },
        { lastPublished: "2026-07-01T09:00:00.000Z", lastUpdated: "2026-07-01T08:59:00.000Z" },
      ),
      item(
        "t-2",
        { name: "A first-timer", slug: "a-first-timer" },
        { lastPublished: "2026-07-02T09:00:00.000Z", lastUpdated: "2026-07-02T08:59:00.000Z" },
      ),
    ],
  },
  {
    id: COLLECTION_IDS.events,
    displayName: "Events",
    singularName: "Event",
    slug: "events",
    items: [
      item(
        "e-harvest",
        {
          name: WEBFLOW_MARKERS.harvest,
          slug: "harvest-table",
          summary: WEBFLOW_MARKERS.harvestSummary,
          seats: 12,
        },
        { lastPublished: "2026-10-28T09:00:00.000Z", lastUpdated: "2026-10-28T08:55:00.000Z" },
      ),
      item(
        "e-oyster",
        { name: WEBFLOW_MARKERS.oyster, slug: "oyster-night", seats: 20 },
        { lastPublished: "2026-11-02T09:00:00.000Z", lastUpdated: "2026-11-02T08:50:00.000Z" },
      ),
      // Saved as ready (not a draft) and never published: it is staged, and the live site does not have it.
      item(
        "e-winter",
        { name: WEBFLOW_MARKERS.winter, slug: "winter-warmer", seats: 16 },
        { lastPublished: null, lastUpdated: "2026-11-08T17:00:00.000Z" },
      ),
      // A draft: deliberately not published, so it is never a finding.
      item(
        "e-new-year",
        { name: WEBFLOW_MARKERS.newYear, slug: "new-year-feast" },
        { isDraft: true, lastPublished: null, lastUpdated: "2026-11-09T10:00:00.000Z" },
      ),
      // Archived: taken down on purpose, never a finding.
      item(
        "e-summer",
        { name: WEBFLOW_MARKERS.summer, slug: "summer-supper" },
        {
          isArchived: true,
          lastPublished: "2026-06-01T09:00:00.000Z",
          lastUpdated: "2026-08-30T09:00:00.000Z",
        },
      ),
    ],
  },
  {
    id: COLLECTION_IDS.menu,
    displayName: "Menu items",
    singularName: "Menu item",
    slug: "menu-items",
    items: [
      // Live, with a later edit that has been saved and not published: the changes are staged.
      item(
        "m-trout",
        { name: WEBFLOW_MARKERS.trout, slug: "smoked-trout", price: WEBFLOW_MARKERS.troutNewPrice },
        { lastPublished: "2026-10-20T10:00:00.000Z", lastUpdated: "2026-11-09T12:00:00.000Z" },
      ),
      item(
        "m-leek",
        { name: WEBFLOW_MARKERS.leek, slug: "burnt-leek" },
        { lastPublished: "2026-10-20T10:00:00.000Z", lastUpdated: "2026-10-20T09:30:00.000Z" },
      ),
    ],
  },
];

/** The same site with nothing waiting: the staged event is published and the menu edit is out. A draft and an archived item remain. */
export const SALTMARSH_SETTLED: FixtureCollection[] = SALTMARSH.map((c) => ({
  ...c,
  items: c.items.map((i) => {
    if (i.id === "e-winter") return { ...i, lastPublished: "2026-11-09T09:00:00.000Z" };
    if (i.id === "m-trout") return { ...i, lastPublished: "2026-11-09T12:30:00.000Z" };
    return i;
  }),
}));

/** Where each collection's pages live, as gaugeline.adapters.json says (testimonials has no pages of its own). */
export const SALTMARSH_URLS = { events: "/events/{slug}", "menu-items": "/menu/{slug}" } as const;

/** A healthy site: every published item has its page. */
export const PAGES_HEALTHY: Readonly<Record<string, number>> = {
  "/events/harvest-table": 200,
  "/events/oyster-night": 200,
  "/events/winter-warmer": 200,
  "/menu/smoked-trout": 200,
  "/menu/burnt-leek": 200,
};

/** Drift: the oyster night is published in the CMS and its page is gone. */
export const PAGES_DRIFT: Readonly<Record<string, number>> = {
  ...PAGES_HEALTHY,
  "/events/oyster-night": 404,
};

export interface WebflowFixtureOptions {
  /** The token the site accepts: anything else is 401. */
  token?: string;
  /** The scopes the token has. A route that needs another is 403 (`missing_scopes`). Default: both. */
  scopes?: readonly ("sites:read" | "cms:read")[];
  /** Collections the token may not read: 403 on them only. */
  denied?: readonly string[];
  /** The pages the site itself serves, by path. A path not here is 404. */
  pages?: Readonly<Record<string, number>>;
  /** Called with every request, to count them or look at their addresses. */
  onRequest?: (method: string, url: URL) => void;
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
    body: Readable.from([Buffer.from("<!doctype html><title>Saltmarsh</title><p>ok</p>")]),
  });

const isLive = (i: FixtureItem): boolean => !i.isDraft && !i.isArchived && i.lastPublished !== null;

/**
 * Webflow's Data API v2 over the invented site, and the site's own pages. The list endpoints answer
 * `{ items, pagination: { limit, offset, total } }` with at most 100 items a page (a larger `limit`
 * is 400, as Webflow does), the staged list holds every item and the live list only what is
 * published and not archived.
 */
export function webflowTransport(
  content: readonly FixtureCollection[] = SALTMARSH,
  options: WebflowFixtureOptions = {},
): Transport {
  const scopes = options.scopes ?? ["sites:read", "cms:read"];
  return async (url, req) => {
    options.onRequest?.(req.method, url);
    if (url.host === SALTMARSH_HOST) {
      const status = (options.pages ?? PAGES_HEALTHY)[url.pathname] ?? 404;
      return html(status);
    }
    if (url.host !== "api.webflow.com") return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { code: "invalid_auth", message: "Request not authorized" });
    const need = (scope: "sites:read" | "cms:read") =>
      scopes.includes(scope)
        ? undefined
        : json(403, { code: "missing_scopes", message: `Missing required scope ${scope}` });

    const path = url.pathname;
    if (path === "/v2/sites") {
      return (
        need("sites:read") ??
        json(200, {
          sites: [
            {
              id: SITE_ID,
              displayName: "Saltmarsh Supper Club",
              shortName: "saltmarsh-supper",
              customDomains: [{ id: "d1", url: SALTMARSH_HOST }],
            },
          ],
        })
      );
    }
    const collections = /^\/v2\/sites\/([^/]+)\/collections$/.exec(path);
    if (collections) {
      const denied = need("cms:read");
      if (denied) return denied;
      if (collections[1] !== SITE_ID) return json(404, { code: "not_found", message: "no site" });
      return json(200, {
        collections: content.map((c) => ({
          id: c.id,
          displayName: c.displayName,
          singularName: c.singularName,
          slug: c.slug,
          createdOn: "2026-05-01T10:00:00.000Z",
          lastUpdated: "2026-11-01T10:00:00.000Z",
        })),
      });
    }
    const items = /^\/v2\/collections\/([^/]+)\/items(\/live)?$/.exec(path);
    if (items) {
      const denied = need("cms:read");
      if (denied) return denied;
      const collection = content.find((c) => c.id === items[1]);
      if (!collection) return json(404, { code: "not_found", message: "no collection" });
      if (options.denied?.includes(collection.id))
        return json(403, { code: "forbidden", message: "This token cannot read this collection" });
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return json(400, { code: "validation_error", message: "limit must be 1 to 100" });
      const all = items[2] ? collection.items.filter(isLive) : collection.items;
      return json(200, {
        items: all.slice(offset, offset + limit),
        pagination: { limit, offset, total: all.length },
      });
    }
    return json(404, { code: "not_found", message: "no such route" });
  };
}
