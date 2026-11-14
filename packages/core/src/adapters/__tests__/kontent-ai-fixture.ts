import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Fernhill Cycles' invented Kontent.ai: a bike shop and repair workshop whose site a freelancer built with Next.js on
 * Vercel. Its environment holds journal articles and offers; one article is waiting in review, one was archived, one
 * is scheduled and one is a draft. Nothing here was recorded from a real project: the answers are in the shape the
 * Delivery API's package source describes (see docs/integrations/kontent-ai.md). Every address is on a reserved
 * `.example` domain.
 */
export const KONTENT_SITE = "https://fernhill-cycles.example";
export const ENVIRONMENT_ID = "5f1d2c7e-3b8a-4c1e-9d46-7a2b8e0f1c35";
export const DELIVERY_HOST = "deliver.kontent.ai";
export const PREVIEW_HOST = "preview-deliver.kontent.ai";

/** Text that is in the client's content, unpublished work included, and must never reach a report, a log or a hash input. */
export const KONTENT_MARKERS = {
  service: "Why a spring service saves you money on the hills",
  serviceSummary: "What we check, and what it costs",
  hours: "Winter opening hours at the workshop",
  trial: "Try an e-bike for a week before you buy",
  sale: "Closing down sale on last year's frames, everything half price",
  priceList: "Workshop price list 2025",
  spring: "Spring ride-out, route not announced yet",
  review: "Draft rewrite of the spring service page, not approved",
} as const;

export interface KontentFixtureItem {
  id: string;
  type: string;
  codename: string;
  /** The workflow step of the latest version (what the Preview API shows). */
  step: string | null;
  /** True when a published version exists: the Delivery API lists it. */
  published: boolean;
  modified: string;
  elements: Record<string, unknown>;
}

const el = (value: unknown, type = "text"): { type: string; value: unknown } => ({ type, value });

const item = (
  n: number,
  type: string,
  codename: string,
  step: string | null,
  published: boolean,
  modified: string,
  elements: Record<string, unknown>,
): KontentFixtureItem => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  type,
  codename,
  step,
  published,
  modified,
  elements,
});

export const FERNHILL: KontentFixtureItem[] = [
  // An article with a newer version waiting in review: the Delivery API still lists the published version.
  item(1, "article", "spring_service", "review", true, "2026-11-02T10:00:00.123Z", {
    title: el(KONTENT_MARKERS.service),
    summary: el(KONTENT_MARKERS.serviceSummary),
    url: el("spring-service", "url_slug"),
  }),
  // No summary: a field an item lacks is left out of its hashes, never hashed as empty.
  item(2, "article", "winter_hours", "published", true, "2026-10-02T10:00:00Z", {
    title: el(KONTENT_MARKERS.hours),
    summary: el(""),
    url: el("winter-hours", "url_slug"),
  }),
  item(3, "offer", "ebike_trial", "published", true, "2026-11-05T09:30:00Z", {
    title: el(KONTENT_MARKERS.trial),
    url: el("e-bike-trial", "url_slug"),
  }),
  // Never published.
  item(4, "article", "closing_sale", "draft", false, "2026-11-09T10:00:00Z", {
    title: el(KONTENT_MARKERS.sale),
    url: el("closing-sale", "url_slug"),
  }),
  // Published once and archived since.
  item(5, "article", "old_price_list", "archived", false, "2026-09-01T08:00:00Z", {
    title: el(KONTENT_MARKERS.priceList),
    url: el("price-list-2025", "url_slug"),
  }),
  // Scheduled for later.
  item(6, "offer", "spring_ride_out", "scheduled", false, "2026-11-10T08:00:00Z", {
    title: el(KONTENT_MARKERS.spring),
    url: el("spring-ride-out", "url_slug"),
  }),
];

/** The same shop with nothing waiting: every item is published. */
export const FERNHILL_SETTLED: KontentFixtureItem[] = FERNHILL.map((i) => ({
  ...i,
  step: "published",
  published: true,
}));

/** Where each type's pages live, as gaugeline.adapters.json says. */
export const FERNHILL_URLS = { article: "/journal/{slug}", offer: "/offers/{slug}" } as const;

export interface KontentCall {
  host: string;
  path: string;
  skip: number;
  limit: number;
  authorization: string | undefined;
  /** 0-based number of the request, over every host. */
  n: number;
}

export interface KontentFixtureOptions {
  /** The secure access key the project requires on the Delivery API. Absent: the project is public. */
  secureKey?: string;
  /** The Preview API key the project accepts on the Preview API. */
  previewKey?: string;
  /** The most items the server gives in a page, whatever the request asks for. */
  maxLimit?: number;
  /** Replaces the answer to a call: `{ status, body, headers }`. Return undefined to answer normally. */
  respond?: (
    call: KontentCall,
  ) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;
  /** Rewrites a normal body before it is sent. */
  tamper?: (body: Record<string, unknown>, call: KontentCall) => unknown;
  /** The items each host lists. Default: Delivery lists the published ones, Preview lists all. */
  itemsFor?: (host: string, all: readonly KontentFixtureItem[]) => readonly KontentFixtureItem[];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/**
 * The Delivery and Preview APIs of the invented environment: `GET /<environment id>/items` with limit, skip, order by
 * system.codename, includeTotalCount and an elements projection. A request that is not a GET, or is for another
 * host or environment, is a 404.
 */
export function kontentTransport(
  items: readonly KontentFixtureItem[] = FERNHILL,
  opts: KontentFixtureOptions = {},
): Transport {
  let n = 0;
  return (url, req) => {
    const at = n++;
    if (req.method !== "GET") return json(405, { message: "GET only" }) as ReturnType<Transport>;
    const host = url.host;
    const authorization = req.headers.authorization;
    const skip = Number(url.searchParams.get("skip") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const call: KontentCall = { host, path: url.pathname, skip, limit, authorization, n: at };
    const forced = opts.respond?.(call);
    if (forced)
      return json(forced.status, forced.body ?? {}, forced.headers) as ReturnType<Transport>;
    if (host !== DELIVERY_HOST && host !== PREVIEW_HOST)
      return json(404, {}) as ReturnType<Transport>;
    if (url.pathname !== `/${ENVIRONMENT_ID}/items`) return json(404, {}) as ReturnType<Transport>;
    const needed = host === PREVIEW_HOST ? opts.previewKey : opts.secureKey;
    if (host === PREVIEW_HOST && opts.previewKey === undefined)
      return json(401, { message: "no preview" }) as ReturnType<Transport>;
    if (needed !== undefined && authorization !== `Bearer ${needed}`)
      return json(401, { message: "Invalid bearer token" }) as ReturnType<Transport>;
    const listed = (
      opts.itemsFor
        ? opts.itemsFor(host, items)
        : host === PREVIEW_HOST
          ? items
          : items.filter((i) => i.published)
    )
      .slice()
      .sort((a, b) => (a.codename < b.codename ? -1 : a.codename > b.codename ? 1 : 0));
    const want = url.searchParams.get("elements");
    const keep = want === null ? undefined : new Set(want.split(","));
    const size = Math.min(limit, opts.maxLimit ?? 2000);
    const page = listed.slice(skip, skip + size);
    const total = listed.length;
    const body: Record<string, unknown> = {
      items: page.map((i) => ({
        system: {
          id: i.id,
          name: i.codename.replace(/_/g, " "),
          codename: i.codename,
          type: i.type,
          sitemap_locations: [],
          last_modified: i.modified,
          language: "default",
          collection: "default",
          workflow: "default",
          // The Delivery API's version is the published one.
          workflow_step: host === PREVIEW_HOST ? i.step : "published",
        },
        elements: Object.fromEntries(
          Object.entries(i.elements).filter(([k]) => keep === undefined || keep.has(k)),
        ),
      })),
      modular_content: {},
      pagination: {
        skip,
        limit: size,
        count: page.length,
        ...(url.searchParams.get("includeTotalCount") === "true" ? { total_count: total } : {}),
        next_page: skip + page.length < total ? "https://example.invalid/next" : "",
      },
    };
    return json(200, opts.tamper ? opts.tamper(body, call) : body) as ReturnType<Transport>;
  };
}

/**
 * Fernhill Cycles' live site: a path answers 200 when it is in `live`, 500 when it is in `broken`, and 404 otherwise.
 * `redirects` maps a path to the path it answers 301 to. Any other host is not here.
 */
export function siteTransport(
  live: readonly string[],
  broken: readonly string[] = [],
  onRequest?: (path: string, method: string) => void,
  redirects: Readonly<Record<string, string>> = {},
): Transport {
  return (url, req) => {
    onRequest?.(url.pathname, req.method);
    if (url.host !== new URL(KONTENT_SITE).host) return json(404, {}) as ReturnType<Transport>;
    const to = redirects[url.pathname];
    if (to !== undefined) return json(301, {}, { location: to }) as ReturnType<Transport>;
    if (broken.includes(url.pathname)) return json(500, {}) as ReturnType<Transport>;
    return (
      live.includes(url.pathname)
        ? Promise.resolve({
            status: 200,
            headers: { "content-type": "text/html" },
            body: Readable.from([Buffer.from("<html></html>")]),
          })
        : json(404, {})
    ) as ReturnType<Transport>;
  };
}

/** One transport for Kontent.ai and the live site, as a run has one fetcher for both. */
export function bothTransport(cms: Transport, site: Transport): Transport {
  return (url, req) =>
    url.host === DELIVERY_HOST || url.host === PREVIEW_HOST ? cms(url, req) : site(url, req);
}
