import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Larkspur Yoga Studio's invented Directus: a small studio whose site a freelancer built with a Next.js front end
 * on a Directus backend, with classes, notices, teachers and a private appointments collection. Nothing here
 * was recorded from a real site; the answers are in the shape of Directus's REST API as the build knew it (the
 * platform's own pages could not be reached, see docs/integrations/directus.md). Every address is on a reserved
 * `.example` domain.
 */
export const DIRECTUS_SITE = "https://larkspur-yoga.example";
export const SITE_HOST = "larkspur-yoga.example";
export const CMS_URL = "https://cms.larkspur-yoga.example";
export const CMS_HOST = "cms.larkspur-yoga.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const DIRECTUS_MARKERS = {
  morning: "Morning flow: slow breathing, then one long sun salutation",
  morningSummary: "Forty minutes, no experience needed, mats provided",
  evening: "Evening stretch for people who sit all day",
  retreat: "Autumn retreat, deposit not yet announced",
  ana: "Ana teaches the early classes and runs the retreat",
  ben: "Ben took over the Saturday workshop in October",
  notice: "The studio is closed on the last Friday of November",
  booking: "Mira Okafor, back pain, Thursday 18:30",
} as const;

export interface DirectusFixtureItem {
  id: number | string;
  /** Absent: the collection has no status field (the row carries none). */
  status?: string | null;
  fields: Record<string, unknown>;
  created: string;
  updated: string | null;
}

export interface DirectusFixtureCollection {
  name: string;
  items: DirectusFixtureItem[];
}

const item = (
  id: number | string,
  status: string | null | undefined,
  fields: Record<string, unknown>,
  created: string,
  updated: string | null = null,
): DirectusFixtureItem => ({
  id,
  ...(status !== undefined ? { status } : {}),
  fields,
  created,
  updated,
});

export const LARKSPUR: DirectusFixtureCollection[] = [
  {
    name: "classes",
    items: [
      item(
        1,
        "published",
        {
          name: DIRECTUS_MARKERS.morning,
          slug: "morning-flow",
          summary: DIRECTUS_MARKERS.morningSummary,
        },
        "2026-10-01T09:00:00.000Z",
        "2026-10-20T08:30:00.000Z",
      ),
      // No summary: a field an item lacks is left out of its hashes, never hashed as empty.
      item(
        2,
        "published",
        { name: DIRECTUS_MARKERS.evening, slug: "evening-stretch" },
        "2026-10-05T09:00:00.000Z",
        "2026-11-02T17:00:00.000Z",
      ),
      // A draft: saved and not published.
      item(
        3,
        "draft",
        { name: DIRECTUS_MARKERS.retreat, slug: "autumn-retreat" },
        "2026-11-09T10:00:00.000Z",
      ),
    ],
  },
  {
    name: "notices",
    items: [
      item(
        4,
        "published",
        { name: DIRECTUS_MARKERS.notice, slug: "closed-last-friday" },
        "2026-11-03T12:00:00.000Z",
      ),
    ],
  },
  {
    name: "teachers",
    items: [
      item(
        "t-ana",
        "published",
        { name: "Ana", slug: "ana", bio: DIRECTUS_MARKERS.ana },
        "2026-06-01T09:00:00.000Z",
        "2026-09-01T09:00:00.000Z",
      ),
      item(
        "t-ben",
        "published",
        { name: "Ben", slug: "ben", bio: DIRECTUS_MARKERS.ben },
        "2026-10-10T09:00:00.000Z",
      ),
    ],
  },
  {
    name: "appointments",
    items: [
      item(
        5,
        "published",
        { client: DIRECTUS_MARKERS.booking, slug: "booking-5" },
        "2026-11-04T09:00:00.000Z",
      ),
      item(
        6,
        "published",
        { client: "A second booking", slug: "booking-6" },
        "2026-11-05T09:00:00.000Z",
      ),
    ],
  },
];

/** The same studio with every draft published: nothing is waiting. */
export const LARKSPUR_SETTLED: DirectusFixtureCollection[] = LARKSPUR.map((c) => ({
  ...c,
  items: c.items.map((i) => (i.status === "draft" ? { ...i, status: "published" } : i)),
}));

/** Where each collection's pages live, as gaugeline.adapters.json says (notices have none of their own). */
export const LARKSPUR_URLS = { classes: "/classes/{slug}", teachers: "/teachers/{slug}" } as const;

export const PAGES_HEALTHY: Readonly<Record<string, number>> = {
  "/classes/morning-flow": 200,
  "/classes/evening-stretch": 200,
  "/teachers/ana": 200,
  "/teachers/ben": 200,
};

/** Drift: the evening stretch is published in Directus and the front end has no page for it. */
export const PAGES_DRIFT: Readonly<Record<string, number>> = {
  ...PAGES_HEALTHY,
  "/classes/evening-stretch": 404,
};

export interface DirectusFixtureOptions {
  /** The token the site accepts: a different one is 401. */
  token?: string;
  /** Collections the token may not read: 403 on them only. */
  denied?: readonly string[];
  /** Collections the Public role may read with no token. Default: none (403). */
  publicRead?: readonly string[];
  /** The most items one answer holds, whatever `limit` asks (QUERY_LIMIT_MAX). Default: 100. */
  maxLimit?: number;
  /** Leave `meta.filter_count` out of every answer. */
  noMeta?: boolean;
  /** Refuse (400) a `fields` list that names a field no item has. Default: ignore it. */
  strictFields?: boolean;
  /** Collections that have no `status` field: a filter on it is 400, and an item carries none. */
  noStatus?: readonly string[];
  /** The pages the front end itself serves, by path. A path not here is 404. */
  pages?: Readonly<Record<string, number>>;
  /** Called with every request, to count them or look at their addresses and headers. */
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
    body: Readable.from([Buffer.from("<!doctype html><title>Larkspur</title><p>ok</p>")]),
  });

const failure = (status: number, code: string, message: string) =>
  json(status, { errors: [{ message, extensions: { code } }] });

/** The one filter the adapter sends: items whose status is not "published" (a null status is not published). */
const NOT_PUBLISHED = '{"_or":[{"status":{"_neq":"published"}},{"status":{"_null":true}}]}';

/**
 * Directus's REST API over the invented studio, and the front end's own pages. `GET /items/{collection}` answers
 * `{ data: [...], meta: { filter_count } }` (`meta=filter_count` asks for the count after the filter), with
 * `limit`, `offset`, `sort` and a comma-separated `fields`. Only the filter the adapter sends is understood; any
 * other filter is 400. A static token goes in an `Authorization: Bearer` header; another token is 401, a
 * collection the role may not read (or that does not exist) is 403.
 */
export function directusTransport(
  content: readonly DirectusFixtureCollection[] = LARKSPUR,
  options: DirectusFixtureOptions = {},
): Transport {
  return async (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host === SITE_HOST) return html((options.pages ?? PAGES_HEALTHY)[url.pathname] ?? 404);
    if (url.host !== CMS_HOST) return failure(404, "ROUTE_NOT_FOUND", "not here");
    if (req.method !== "GET") return failure(405, "METHOD_NOT_ALLOWED", "method not allowed");
    const route = /^\/items\/([^/]+)$/.exec(url.pathname);
    if (!route) return failure(404, "ROUTE_NOT_FOUND", "Route not found.");
    const name = decodeURIComponent(route[1] ?? "");
    const collection = content.find((c) => c.name === name);
    const q = url.searchParams;

    const auth = req.headers.authorization;
    if (auth !== undefined) {
      if (options.token !== undefined && auth !== `Bearer ${options.token}`)
        return failure(401, "INVALID_CREDENTIALS", "Invalid user credentials.");
      if (options.denied?.includes(name))
        return failure(403, "FORBIDDEN", "You don't have permission to access this.");
    } else if (!(options.publicRead ?? []).includes(name))
      return failure(403, "FORBIDDEN", "You don't have permission to access this.");
    if (!collection) return failure(403, "FORBIDDEN", "You don't have permission to access this.");

    const noStatus = options.noStatus?.includes(name) === true;
    const filter = q.get("filter");
    if (filter !== null && filter !== NOT_PUBLISHED)
      return failure(400, "INVALID_QUERY", "Invalid query.");
    const selected = q.get("fields")?.split(",") ?? [];
    if (noStatus && filter !== null) return failure(400, "INVALID_QUERY", "Invalid query.");
    const limit = Number(q.get("limit") ?? "100");
    const offset = Number(q.get("offset") ?? "0");
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0)
      return failure(400, "INVALID_QUERY", "Invalid query.");
    const size = Math.min(limit, options.maxLimit ?? 100);
    if (options.strictFields) {
      const known = new Set([
        "id",
        "status",
        "date_created",
        "date_updated",
        ...collection.items.flatMap((i) => Object.keys(i.fields)),
      ]);
      if (selected.some((f) => !known.has(f)))
        return failure(400, "INVALID_QUERY", "Invalid query.");
    }

    const all = collection.items
      .filter((i) => filter === null || i.status !== "published")
      .sort((a, b) => String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
    const row = (i: DirectusFixtureItem): Record<string, unknown> => {
      const full: Record<string, unknown> = {
        id: i.id,
        ...(i.status !== undefined && !noStatus ? { status: i.status } : {}),
        ...i.fields,
        date_created: i.created,
        date_updated: i.updated,
      };
      return selected.length === 0
        ? full
        : Object.fromEntries(Object.entries(full).filter(([k]) => selected.includes(k)));
    };
    return json(200, {
      data: all.slice(offset, offset + size).map(row),
      ...(q.get("meta") === "filter_count" && !options.noMeta
        ? { meta: { filter_count: all.length } }
        : {}),
    });
  };
}
