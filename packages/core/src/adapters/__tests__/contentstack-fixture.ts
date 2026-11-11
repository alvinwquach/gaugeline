import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Larkspur Yoga Studio's invented Contentstack site: a small studio whose site a freelancer built on Contentstack, with
 * classes, teachers and notices. Nothing here was recorded from a real site, and every address is on a
 * reserved `.example` domain.
 *
 * TODO(new:adapter) the answers are in the shape the scaffold's adapter expects, not the platform's.
 * Change them to the shape of the platform's documented responses (copy the shape from its reference page,
 * not a real answer: invent every value) and keep these four things true, because the contract suite
 * relies on them: a draft in the first type, an item that lacks a field the others have, at least two types
 * with two published items each, and a text in every item that is the client's words (the markers).
 */
export const CONTENTSTACK_SITE = "https://larkspur-yoga.example";
export const CONTENTSTACK_HOST = "api.contentstack.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const CONTENTSTACK_MARKERS = {
  morning: "Morning flow: slow breathing, then one long sun salutation",
  morningSummary: "Forty minutes, no experience needed, mats provided",
  evening: "Evening stretch for people who sit all day",
  retreat: "Autumn retreat, deposit not yet announced",
  ana: "Ana teaches the early classes and runs the retreat",
  ben: "Ben took over the Saturday workshop in October",
  notice: "The studio is closed on the last Friday of November",
} as const;

export interface FixtureItem {
  id: string;
  slug: string;
  status: "published" | "draft";
  updatedAt: string;
  publishedAt?: string;
  fields: Record<string, unknown>;
}

export interface FixtureType {
  slug: string;
  items: FixtureItem[];
}

export const CONTENTSTACK_CONTENT: FixtureType[] = [
  {
    slug: "classes",
    items: [
      {
        id: "c-morning",
        slug: "morning-flow",
        status: "published",
        publishedAt: "2026-10-01T09:00:00.000Z",
        updatedAt: "2026-10-20T08:30:00.000Z",
        fields: {
          name: CONTENTSTACK_MARKERS.morning,
          summary: CONTENTSTACK_MARKERS.morningSummary,
          seats: 14,
        },
      },
      // No summary: a field an item lacks is left out of its hashes, never hashed as empty.
      {
        id: "c-evening",
        slug: "evening-stretch",
        status: "published",
        publishedAt: "2026-10-05T09:00:00.000Z",
        updatedAt: "2026-11-02T17:00:00.000Z",
        fields: { name: CONTENTSTACK_MARKERS.evening, seats: 20 },
      },
      // A draft: saved and not published. The published list never holds it.
      {
        id: "c-retreat",
        slug: "autumn-retreat",
        status: "draft",
        updatedAt: "2026-11-09T10:00:00.000Z",
        fields: { name: CONTENTSTACK_MARKERS.retreat },
      },
    ],
  },
  {
    slug: "notices",
    items: [
      {
        id: "n-closed",
        slug: "closed-last-friday",
        status: "published",
        publishedAt: "2026-11-03T12:00:00.000Z",
        updatedAt: "2026-11-03T12:00:00.000Z",
        fields: { name: CONTENTSTACK_MARKERS.notice },
      },
    ],
  },
  {
    slug: "teachers",
    items: [
      {
        id: "t-ana",
        slug: "ana",
        status: "published",
        publishedAt: "2026-06-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
        fields: { name: "Ana", bio: CONTENTSTACK_MARKERS.ana },
      },
      {
        id: "t-ben",
        slug: "ben",
        status: "published",
        publishedAt: "2026-10-10T09:00:00.000Z",
        updatedAt: "2026-10-10T09:00:00.000Z",
        fields: { name: "Ben", bio: CONTENTSTACK_MARKERS.ben },
      },
    ],
  },
];

export interface ContentstackFixtureOptions {
  /** When set, a request without `Authorization: Bearer <token>` is answered 401. */
  token?: string;
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/**
 * Contentstack's API over the invented site. Every list answers at most 100 items a page (a larger `limit` is 400)
 * with the total, and nothing but a GET is answered. TODO(new:adapter) match the platform's paths and shapes.
 */
export function contentstackTransport(
  content: readonly FixtureType[] = CONTENTSTACK_CONTENT,
  options: ContentstackFixtureOptions = {},
): Transport {
  return (url, req) => {
    options.onRequest?.(req.method, url);
    if (url.host !== CONTENTSTACK_HOST) return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { message: "Request not authorized" });

    /** The items a list holds: with a key, "all" includes drafts; without one, only what is published. */
    const listed = (slug: string, status: string | null) => {
      const type = content.find((t) => t.slug === slug);
      if (!type) return undefined;
      return status === "all" ? type.items : type.items.filter((i) => i.status === "published");
    };

    if (url.pathname === "/v1/types")
      return json(200, { types: content.map((t) => ({ slug: t.slug })) });
    const items = /^\/v1\/types\/([^/]+)\/items$/.exec(url.pathname);
    if (items) {
      const all = listed(decodeURIComponent(items[1] ?? ""), url.searchParams.get("status"));
      if (!all) return json(404, { message: "no such type" });
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return json(400, { message: "limit must be 1 to 100" });
      return json(200, { items: all.slice(offset, offset + limit), total: all.length });
    }
    return json(404, { message: "no such route" });
  };
}
