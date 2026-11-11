import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Harbour Lantern Inn's invented Contentstack stack: a boutique hotel whose site an agency built on Contentstack,
 * with rooms, offers and team members. Nothing here was recorded from a real stack, and every address is on a
 * reserved `.example` domain. The shapes follow the Content Delivery API's documented answers (docs page:
 * "A note on sources"); every value is invented.
 */
export const CONTENTSTACK_SITE = "https://harbour-lantern.example";
export const CONTENTSTACK_HOST = "cdn.contentstack.io";
export const CONTENTSTACK_ENV = "production";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const CONTENTSTACK_MARKERS = {
  harbour: "Harbour View Suite: breakfast on the terrace and a view of the quay",
  harbourSummary: "Sleeps two, late checkout on request, no pets",
  garden: "Garden Room for a quiet night under the lemon tree",
  winter: "Winter stay: three nights for the price of two",
  unannounced: "Spring package, price not yet announced",
  ines: "Ines runs the front desk and the breakfast room",
  tomas: "Tomas looks after the garden and the boats",
} as const;

export interface FixtureEntry {
  uid: string;
  /** False: saved or unpublished in this environment. The Content Delivery API never serves it. */
  published: boolean;
  createdAt: string;
  updatedAt: string;
  fields: Record<string, unknown>;
}

export interface FixtureType {
  uid: string;
  /** The uids of the content type's fields (its schema). */
  schema: string[];
  entries: FixtureEntry[];
}

export const CONTENTSTACK_CONTENT: FixtureType[] = [
  {
    uid: "offers",
    schema: ["title", "url", "summary"],
    entries: [
      {
        uid: "blt0a1b2c3d4e5f0301",
        published: true,
        createdAt: "2026-11-03T12:00:00.000Z",
        updatedAt: "2026-11-03T12:00:00.000Z",
        fields: { title: CONTENTSTACK_MARKERS.winter, url: "/offers/winter-stay" },
      },
    ],
  },
  {
    uid: "rooms",
    schema: ["title", "url", "summary", "seats"],
    entries: [
      {
        uid: "blt0a1b2c3d4e5f0101",
        published: true,
        createdAt: "2026-10-01T09:00:00.000Z",
        updatedAt: "2026-10-20T08:30:00.000Z",
        fields: {
          title: CONTENTSTACK_MARKERS.harbour,
          url: "/rooms/harbour-view",
          summary: CONTENTSTACK_MARKERS.harbourSummary,
          seats: 2,
        },
      },
      // No summary: a field an entry lacks is left out of its hashes, never hashed as empty.
      {
        uid: "blt0a1b2c3d4e5f0102",
        published: true,
        createdAt: "2026-10-05T09:00:00.000Z",
        updatedAt: "2026-11-02T17:00:00.000Z",
        fields: { title: CONTENTSTACK_MARKERS.garden, url: "/rooms/garden", seats: 3 },
      },
      // Not published to this environment: the delivery API never serves it.
      {
        uid: "blt0a1b2c3d4e5f0103",
        published: false,
        createdAt: "2026-11-09T10:00:00.000Z",
        updatedAt: "2026-11-09T10:00:00.000Z",
        fields: { title: CONTENTSTACK_MARKERS.unannounced, url: "/rooms/spring-package" },
      },
    ],
  },
  {
    // No URL field: these entries have no page of their own.
    uid: "team",
    schema: ["title", "bio"],
    entries: [
      {
        uid: "blt0a1b2c3d4e5f0201",
        published: true,
        createdAt: "2026-06-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
        fields: { title: "Ines", bio: CONTENTSTACK_MARKERS.ines },
      },
      {
        uid: "blt0a1b2c3d4e5f0202",
        published: true,
        createdAt: "2026-10-10T09:00:00.000Z",
        updatedAt: "2026-10-10T09:00:00.000Z",
        fields: { title: "Tomas", bio: CONTENTSTACK_MARKERS.tomas },
      },
    ],
  },
];

export interface ContentstackFixtureOptions {
  /** When set, a request without `access_token: <token>` is answered 401. */
  token?: string;
  /** When set, a request without `api_key: <apiKey>` is answered 401. */
  apiKey?: string;
  /** The environment the token is for. Any other `environment` is answered 422. Default: production. */
  environment?: string;
  /** Content types the token may not read: their entries answer 403. */
  restricted?: readonly string[];
  /** The most entries (or content types) a page holds, whatever `limit` asks for: a server that clamps the page. */
  pageMax?: number;
  /** The host answered. Default: cdn.contentstack.io. */
  host?: string;
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/**
 * Contentstack's Content Delivery API over the invented stack. Every list answers at most 100 items a page
 * (and at most `pageMax`), with `count` when `include_count=true`; only the fields named by `only[BASE][]`
 * come back (the system fields uid, created_at and updated_at always do); and nothing but a GET is answered.
 */
export function contentstackTransport(
  content: readonly FixtureType[] = CONTENTSTACK_CONTENT,
  options: ContentstackFixtureOptions = {},
): Transport {
  const host = options.host ?? CONTENTSTACK_HOST;
  const environment = options.environment ?? CONTENTSTACK_ENV;
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== host) return json(404, { error_message: "not here" });
    if (req.method !== "GET") return json(405, { error_message: "method not allowed" });
    if (options.token !== undefined && req.headers.access_token !== options.token)
      return json(401, { error_message: "Access token is invalid", error_code: 105 });
    if (options.apiKey !== undefined && req.headers.api_key !== options.apiKey)
      return json(401, { error_message: "API key is invalid", error_code: 104 });

    const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), options.pageMax ?? 100);
    const skip = Number(url.searchParams.get("skip") ?? "0");
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(skip) || skip < 0)
      return json(422, { error_message: "bad paging" });
    const count = url.searchParams.get("include_count") === "true";

    if (url.pathname === "/v3/content_types") {
      const page = content.slice(skip, skip + limit);
      return json(200, {
        content_types: page.map((t) => ({
          uid: t.uid,
          title: `Type ${t.uid}`,
          schema: t.schema.map((uid) => ({ uid, data_type: "text" })),
        })),
        ...(count ? { count: content.length } : {}),
      });
    }
    const m = /^\/v3\/content_types\/([^/]+)\/entries$/.exec(url.pathname);
    if (m) {
      const type = content.find((t) => t.uid === decodeURIComponent(m[1] ?? ""));
      if (!type) return json(422, { error_message: "Content type was not found", error_code: 118 });
      if (url.searchParams.get("environment") !== environment)
        return json(422, { error_message: "Environment was not found", error_code: 141 });
      if (options.restricted?.includes(type.uid))
        return json(403, { error_message: "Forbidden", error_code: 109 });
      const live = type.entries.filter((e) => e.published);
      const only = new Set(url.searchParams.getAll("only[BASE][]"));
      const entries = live.slice(skip, skip + limit).map((e) => ({
        uid: e.uid,
        locale: "en-us",
        created_at: e.createdAt,
        updated_at: e.updatedAt,
        ...Object.fromEntries(Object.entries(e.fields).filter(([k]) => only.has(k))),
      }));
      return json(200, { entries, ...(count ? { count: live.length } : {}) });
    }
    return json(404, { error_message: "no such route" });
  };
}
