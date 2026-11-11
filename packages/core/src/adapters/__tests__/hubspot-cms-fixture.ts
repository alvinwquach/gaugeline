import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Brass Whisk Bakehouse's invented HubSpot CMS site: a pop-up bakery whose site a freelancer built on HubSpot
 * CMS, with site pages, landing pages, blog posts and a HubDB table of loaves that a dynamic page shows.
 * Nothing here was recorded from a real portal: the shapes follow HubSpot's CMS API as the docs page describes
 * them (some of them uncited, see docs/integrations/hubspot-cms.md), every value is invented, and every
 * address is on a reserved `.example` domain.
 */
export const HUBSPOT_CMS_SITE = "https://brass-whisk.example";
/** A second domain the same portal serves (the wholesale shop): its pages are not this site's. */
export const HUBSPOT_CMS_OTHER_SITE = "https://brass-whisk-wholesale.example";
export const HUBSPOT_CMS_HOST = "api.hubapi.com";
export const HUBSPOT_CMS_PORTAL = 5550101;

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const HUBSPOT_CMS_MARKERS = {
  menu: "Weekend menu: country sourdough, rye, and cardamom buns while they last",
  menuMeta: "Order by Thursday noon for Saturday pickup at the market stall",
  about: "Two bakers, one oven, and a Saturday market stall since spring",
  bread: "Our loaves, baked in the morning and gone by noon",
  breadMeta: "Seasonal loaves from the Brass Whisk oven",
  tasting: "Private tasting night, guest list not yet announced",
  preorder: "Holiday pre-order: cinnamon wreath bread, pay at pickup",
  wholesale: "Wholesale price list for cafes, minimum twelve loaves",
  postOven: "We finally replaced the old oven and the crust shows it",
  postHours: "Summer hours: market stall on Saturdays only until September",
  sourdough: "Country sourdough",
  rye: "Dark rye with caraway",
  seeded: "Seeded spelt loaf",
} as const;

export interface HsPage {
  id: string;
  slug: string;
  state: "PUBLISHED" | "DRAFT" | "SCHEDULED";
  url?: string;
  publishDate?: string;
  updated: string;
  archived?: boolean;
  dynamicPageHubDbTableId?: string;
  /** Top-level fields of the page object: name, htmlTitle, metaDescription. */
  fields: Record<string, unknown>;
}

export interface HsRow {
  id: string;
  path: string;
  values: Record<string, unknown>;
  publishedAt: string;
  updatedAt: string;
}

export interface HsTable {
  id: string;
  name: string;
  published: boolean;
  rows: HsRow[];
}

export interface HubspotFixtureData {
  pages: { "site-pages": HsPage[]; "landing-pages": HsPage[]; "blog-posts": HsPage[] };
  tables: HsTable[];
  /** The ids of the forms that exist in the portal. */
  forms: string[];
  portalId: number;
}

export const FORM_LIVE = "5c1d2e3f-0000-4000-8000-00000000a001";
export const FORM_DELETED = "5c1d2e3f-0000-4000-8000-00000000d00d";

/** A fresh copy each call: a test that changes it changes nothing another test sees. */
export function hubspotData(): HubspotFixtureData {
  return {
    pages: {
      "site-pages": [
        {
          id: "101",
          slug: "menu",
          state: "PUBLISHED",
          url: `${HUBSPOT_CMS_SITE}/menu`,
          publishDate: "2026-09-01T09:00:00.000Z",
          updated: "2026-10-20T08:30:00.000Z",
          fields: { name: HUBSPOT_CMS_MARKERS.menu, metaDescription: HUBSPOT_CMS_MARKERS.menuMeta },
        },
        // No metaDescription: a field an item lacks is left out of its hashes, never hashed as empty.
        {
          id: "102",
          slug: "about",
          state: "PUBLISHED",
          url: `${HUBSPOT_CMS_SITE}/about`,
          publishDate: "2026-09-02T09:00:00.000Z",
          updated: "2026-11-02T17:00:00.000Z",
          fields: { name: HUBSPOT_CMS_MARKERS.about },
        },
        // A dynamic page: one page, one address for each row of the HubDB table 9001.
        {
          id: "103",
          slug: "bread",
          state: "PUBLISHED",
          url: `${HUBSPOT_CMS_SITE}/bread`,
          publishDate: "2026-09-03T09:00:00.000Z",
          updated: "2026-11-05T10:00:00.000Z",
          dynamicPageHubDbTableId: "9001",
          fields: {
            name: HUBSPOT_CMS_MARKERS.bread,
            metaDescription: HUBSPOT_CMS_MARKERS.breadMeta,
          },
        },
        // A draft: saved and not published. The published list never holds it.
        {
          id: "104",
          slug: "private-tasting",
          state: "DRAFT",
          url: `${HUBSPOT_CMS_SITE}/private-tasting`,
          updated: "2026-11-09T10:00:00.000Z",
          fields: { name: HUBSPOT_CMS_MARKERS.tasting },
        },
      ],
      "landing-pages": [
        {
          id: "201",
          slug: "holiday-preorder",
          state: "PUBLISHED",
          url: `${HUBSPOT_CMS_SITE}/holiday-preorder`,
          publishDate: "2026-11-01T09:00:00.000Z",
          updated: "2026-11-01T09:00:00.000Z",
          fields: { name: HUBSPOT_CMS_MARKERS.preorder },
        },
        // The same portal serves a second domain: this page is that site's, not the bakery's.
        {
          id: "202",
          slug: "wholesale",
          state: "PUBLISHED",
          url: `${HUBSPOT_CMS_OTHER_SITE}/wholesale`,
          publishDate: "2026-10-01T09:00:00.000Z",
          updated: "2026-10-01T09:00:00.000Z",
          fields: { name: HUBSPOT_CMS_MARKERS.wholesale },
        },
      ],
      "blog-posts": [
        {
          id: "301",
          slug: "blog/new-oven",
          state: "PUBLISHED",
          url: `${HUBSPOT_CMS_SITE}/blog/new-oven`,
          publishDate: "2026-10-12T09:00:00.000Z",
          updated: "2026-10-12T09:00:00.000Z",
          fields: { name: HUBSPOT_CMS_MARKERS.postOven },
        },
        {
          id: "302",
          slug: "blog/summer-hours",
          state: "PUBLISHED",
          url: `${HUBSPOT_CMS_SITE}/blog/summer-hours`,
          publishDate: "2026-06-12T09:00:00.000Z",
          updated: "2026-06-12T09:00:00.000Z",
          fields: { name: HUBSPOT_CMS_MARKERS.postHours },
        },
      ],
    },
    tables: [
      {
        id: "9001",
        name: "loaves",
        published: true,
        rows: [
          {
            id: "7001",
            path: "sourdough",
            values: { name: HUBSPOT_CMS_MARKERS.sourdough, price: 8.5 },
            publishedAt: "2026-10-01T09:00:00.000Z",
            updatedAt: "2026-10-01T09:00:00.000Z",
          },
          {
            id: "7002",
            path: "rye",
            values: { name: HUBSPOT_CMS_MARKERS.rye, price: 9.25 },
            publishedAt: "2026-10-01T09:00:00.000Z",
            updatedAt: "2026-10-30T09:00:00.000Z",
          },
          {
            id: "7003",
            path: "seeded",
            values: { name: HUBSPOT_CMS_MARKERS.seeded },
            publishedAt: "2026-10-02T09:00:00.000Z",
            updatedAt: "2026-10-02T09:00:00.000Z",
          },
        ],
      },
    ],
    forms: [FORM_LIVE],
    portalId: HUBSPOT_CMS_PORTAL,
  };
}

export interface HubspotCmsFixtureOptions {
  /** When set, a request without `Authorization: Bearer <token>` is answered 401. */
  token?: string;
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
  /** Path prefixes answered 403: the token may not read them. */
  denied?: readonly string[];
  /** Most items a list answers at once, whatever `limit` was asked (a server that clamps). */
  clamp?: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** The cursor for the page starting at `offset`. Plain characters only, as HubSpot's are. */
const cursorAt = (offset: number): string => `c${offset}x`;
const offsetOf = (after: string | null): number | undefined => {
  if (after === null) return 0;
  const m = /^c(\d+)x$/.exec(after);
  return m ? Number(m[1]) : undefined;
};

/**
 * HubSpot's CMS API over the invented portal, on api.hubapi.com: lists answer `{ total, results, paging }`,
 * at most 100 a page (a larger `limit` is 400), with the cursor in `paging.next.after`. Nothing but a GET is
 * answered.
 */
export function hubspotCmsTransport(
  data: HubspotFixtureData = hubspotData(),
  options: HubspotCmsFixtureOptions = {},
): Transport {
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== HUBSPOT_CMS_HOST) return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { status: "error", message: "Authentication credentials not found" });
    if (options.denied?.some((p) => url.pathname.startsWith(p)))
      return json(403, { status: "error", category: "MISSING_SCOPES" });

    /** A list: the items from the cursor, at most the page size, with the next cursor when there are more. */
    const list = (all: unknown[]) => {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const from = offsetOf(url.searchParams.get("after"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || from === undefined)
        return json(400, { message: "limit must be 1 to 100" });
      const size = Math.min(limit, options.clamp ?? 100);
      const results = all.slice(from, from + size);
      const more = from + size < all.length;
      return json(200, {
        total: all.length,
        results,
        ...(more ? { paging: { next: { after: cursorAt(from + size) } } } : {}),
      });
    };

    const pagePath: Record<string, keyof HubspotFixtureData["pages"]> = {
      "/cms/v3/pages/site-pages": "site-pages",
      "/cms/v3/pages/landing-pages": "landing-pages",
      "/cms/v3/blogs/posts": "blog-posts",
    };
    const kind = pagePath[url.pathname];
    if (kind !== undefined)
      return list(
        data.pages[kind].map((p) => ({
          id: p.id,
          slug: p.slug,
          state: p.state,
          ...(p.url !== undefined ? { url: p.url } : {}),
          ...(p.publishDate !== undefined ? { publishDate: p.publishDate } : {}),
          updated: p.updated,
          archived: p.archived ?? false,
          ...(p.dynamicPageHubDbTableId !== undefined
            ? { dynamicPageHubDbTableId: p.dynamicPageHubDbTableId }
            : {}),
          ...p.fields,
        })),
      );
    if (url.pathname === "/cms/v3/hubdb/tables")
      return list(
        data.tables.map((t) => ({
          id: t.id,
          name: t.name,
          published: t.published,
          rowCount: t.rows.length,
        })),
      );
    const rows = /^\/cms\/v3\/hubdb\/tables\/([^/]+)\/rows$/.exec(url.pathname);
    if (rows) {
      const key = decodeURIComponent(rows[1] ?? "");
      const table = data.tables.find((t) => t.name === key || t.id === key);
      if (!table) return json(404, { message: "no such table" });
      return list(table.rows);
    }
    if (url.pathname === "/account-info/v3/details") return json(200, { portalId: data.portalId });
    const form = /^\/marketing\/v3\/forms\/([^/]+)$/.exec(url.pathname);
    if (form) {
      const id = decodeURIComponent(form[1] ?? "");
      return data.forms.includes(id)
        ? json(200, { id, archived: false })
        : json(404, { message: "form not found" });
    }
    return json(404, { message: "no such route" });
  };
}

export interface LivePage {
  status: number;
  html?: string;
}

/** A live page's HTML: some text, optionally a HubSpot form embed and a price line. */
export function livePage(
  body: string,
  embed?: { portalId: number | string; formId: string },
): string {
  const form =
    embed === undefined
      ? ""
      : `<script src="https://js.hsforms.net/forms/embed/v2.js"></script>
<script>hbspt.forms.create({ portalId: "${embed.portalId}", formId: "${embed.formId}" });</script>`;
  return `<!doctype html><html><head><title>Brass Whisk</title><style>.x{color:red}</style></head><body><main>${body}</main>${form}</body></html>`;
}

/** What the bakery's live site serves when nothing is wrong. */
export function healthySite(): Record<string, LivePage> {
  return {
    "/menu": { status: 200, html: livePage("<h1>Weekend menu</h1>") },
    "/about": { status: 200, html: livePage("<h1>About us</h1>") },
    "/bread": { status: 200, html: livePage("<h1>Our loaves</h1>") },
    "/bread/sourdough": {
      status: 200,
      html: livePage(`<h1>${HUBSPOT_CMS_MARKERS.sourdough}</h1><p class="price">$8.50</p>`, {
        portalId: HUBSPOT_CMS_PORTAL,
        formId: FORM_LIVE,
      }),
    },
    "/bread/rye": {
      status: 200,
      html: livePage(`<h1>${HUBSPOT_CMS_MARKERS.rye}</h1><p class="price">$9.25</p>`),
    },
    "/bread/seeded": {
      status: 200,
      html: livePage(`<h1>${HUBSPOT_CMS_MARKERS.seeded}</h1>`),
    },
    "/holiday-preorder": {
      status: 200,
      html: livePage("<h1>Holiday pre-order</h1>", {
        portalId: HUBSPOT_CMS_PORTAL,
        formId: FORM_LIVE,
      }),
    },
    "/blog/new-oven": { status: 200, html: livePage("<h1>New oven</h1>") },
    "/blog/summer-hours": { status: 200, html: livePage("<h1>Summer hours</h1>") },
  };
}

/** The live domain: a page answers what the map says, and any other path is a 404. */
export function siteTransport(
  pages: Record<string, LivePage> = healthySite(),
  options: { onRequest?: (method: string, url: URL, headers: Record<string, string>) => void } = {},
): Transport {
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    const hit = pages[url.pathname];
    if (!hit) return json(404, { message: "not found" });
    return Promise.resolve({
      status: hit.status,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Readable.from([Buffer.from(hit.html ?? "")]),
    });
  };
}

/** Both worlds in one transport: HubSpot's API on its host, the bakery's pages on theirs, a 404 elsewhere. */
export function hubspotWorld(
  data: HubspotFixtureData = hubspotData(),
  site: Record<string, LivePage> = healthySite(),
  options: HubspotCmsFixtureOptions & {
    onSiteRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
  } = {},
): Transport {
  const api = hubspotCmsTransport(data, options);
  const live = siteTransport(site, {
    ...(options.onSiteRequest ? { onRequest: options.onSiteRequest } : {}),
  });
  return (url, req) => {
    if (url.host === HUBSPOT_CMS_HOST) return api(url, req);
    if (url.origin === HUBSPOT_CMS_SITE) return live(url, req);
    return json(404, { message: "not here" });
  };
}
