import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Quillon Coffee Roasters' invented Payload: a small roastery whose site a freelancer built with Next.js, with
 * Payload in the same app. It holds blog posts (drafts enabled), events (no drafts), and a private collection of
 * wholesale orders. Nothing here was recorded from a real site: the answers are in the shape of Payload's REST API
 * as its documentation and its package source describe it (see docs/integrations/payload.md). Every address is on a
 * reserved `.example` domain.
 */
export const PAYLOAD_SITE = "https://quillon-coffee.example";
export const API_URL = "https://studio.quillon-coffee.example/api";
export const API_HOST = "studio.quillon-coffee.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const PAYLOAD_MARKERS = {
  harvest: "Harvest blend: washed Ethiopian, tastes of stone fruit and tea",
  harvestSummary: "A seasonal filter roast, back until the end of December",
  decaf: "Why our decaf is water-processed and where it comes from",
  secret: "Winter cupping notes, not announced yet",
  tasting: "Saturday tasting at the roastery, ten places",
  fair: "Stall at the Sunday makers fair, by the canal",
  order: "Tidewater Cafe, forty bags, invoice on delivery",
} as const;

export interface PayloadFixtureDoc {
  id: number | string;
  /** Absent: the collection has no drafts (the document carries no `_status`). */
  status?: string | null;
  fields: Record<string, unknown>;
  created: string | null;
  updated: string | null;
}

export interface PayloadFixtureCollection {
  slug: string;
  docs: PayloadFixtureDoc[];
}

const doc = (
  id: number | string,
  status: string | null | undefined,
  fields: Record<string, unknown>,
  created: string | null,
  updated: string | null = created,
): PayloadFixtureDoc => ({
  id,
  ...(status !== undefined ? { status } : {}),
  fields,
  created,
  updated,
});

export const QUILLON: PayloadFixtureCollection[] = [
  {
    slug: "posts",
    docs: [
      doc(
        "6650a1c0",
        "published",
        {
          title: PAYLOAD_MARKERS.harvest,
          slug: "harvest-blend",
          summary: PAYLOAD_MARKERS.harvestSummary,
        },
        "2026-10-01T09:00:00.000Z",
        "2026-10-20T08:30:00.000Z",
      ),
      // No summary: a field a document lacks is left out of its hashes, never hashed as empty.
      doc(
        "6650a1c1",
        "published",
        { title: PAYLOAD_MARKERS.decaf, slug: "our-decaf" },
        "2026-10-05T09:00:00.000Z",
        "2026-11-02T17:00:00.000Z",
      ),
      // A draft: saved and not published.
      doc(
        "6650a1c2",
        "draft",
        { title: PAYLOAD_MARKERS.secret, slug: "winter-cupping" },
        "2026-11-09T10:00:00.000Z",
      ),
    ],
  },
  {
    slug: "events",
    docs: [
      doc(
        1,
        undefined,
        { title: PAYLOAD_MARKERS.tasting, slug: "saturday-tasting" },
        "2026-11-03T12:00:00.000Z",
      ),
      doc(
        2,
        undefined,
        { title: PAYLOAD_MARKERS.fair, slug: "makers-fair" },
        "2026-11-04T12:00:00.000Z",
        "2026-11-06T12:00:00.000Z",
      ),
    ],
  },
  {
    slug: "wholesale-orders",
    docs: [
      doc(
        "ord-1",
        "published",
        { customer: PAYLOAD_MARKERS.order, slug: "order-1" },
        "2026-11-04T09:00:00.000Z",
      ),
      doc(
        "ord-2",
        "published",
        { customer: "A second order", slug: "order-2" },
        "2026-11-05T09:00:00.000Z",
      ),
    ],
  },
];

/** The same roastery with every draft published: nothing is waiting. */
export const QUILLON_SETTLED: PayloadFixtureCollection[] = QUILLON.map((c) => ({
  ...c,
  docs: c.docs.map((d) => (d.status === "draft" ? { ...d, status: "published" } : d)),
}));

/** Where each collection's pages live, as gaugeline.adapters.json says (events have a page each, orders none). */
export const QUILLON_URLS = { posts: "/journal/{slug}", events: "/events/{slug}" } as const;

export interface PayloadFixtureOptions {
  /** The key the site accepts. Any other key is no user at all, so it reads as a visitor does (Payload answers 403, not 401). */
  key?: string;
  /** The auth collection's slug in the header. Default: users. */
  authCollection?: string;
  /** Collections the key's user may not read: 403 on them only. */
  denied?: readonly string[];
  /** Collections a visitor with no key may read. Default: none (403). */
  publicRead?: readonly string[];
  /** The most documents one answer holds, whatever `limit` asks. Default: no cap. */
  maxLimit?: number;
  /** Refuse (400) a `select` that names a field no document has. Default: ignore it. */
  strictSelect?: boolean;
  /** Called with every request, to count them or look at their addresses and headers. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** Payload's own message for a refusal (its English text), in the body's `errors` list. */
export const FORBIDDEN_MESSAGE = "You are not allowed to perform this action.";
export const forbidden = () => json(403, { errors: [{ message: FORBIDDEN_MESSAGE }] });

/**
 * Payload's REST API over the invented roastery. `GET /api/{slug}` answers `{ docs, totalDocs, limit, totalPages,
 * page, pagingCounter, hasPrevPage, hasNextPage, prevPage, nextPage }` with `limit`, `page`, `sort`, `depth` and
 * `select[field]=true`. Only the one `where` the adapter sends is understood
 * (`where[_status][equals]=draft`, 400 for a collection with no drafts); any other is 400. An API key goes in an
 * `Authorization: <auth collection> API-Key <key>` header; another key is no user, so it is a visitor's answer.
 * A collection that does not exist is 404 before access is looked at; a collection the user may not read is 403.
 */
export function payloadTransport(
  content: readonly PayloadFixtureCollection[] = QUILLON,
  options: PayloadFixtureOptions = {},
): Transport {
  const authSlug = options.authCollection ?? "users";
  return async (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== API_HOST) return json(404, { errors: [{ message: "not here" }] });
    if (req.method !== "GET") return json(405, { errors: [{ message: "method not allowed" }] });
    const route = /^\/api\/([^/]+)$/.exec(url.pathname);
    if (!route) return json(404, { errors: [{ message: "Route not found." }] });
    const slug = decodeURIComponent(route[1] ?? "");
    const collection = content.find((c) => c.slug === slug);
    // Payload looks the collection up before it looks at access.
    if (!collection)
      return json(404, { errors: [{ message: `Collection with the slug ${slug} was not found` }] });
    const q = url.searchParams;

    const auth = req.headers.authorization;
    const isUser =
      auth !== undefined &&
      (options.key === undefined || auth === `${authSlug} API-Key ${options.key}`);
    if (isUser) {
      if (options.denied?.includes(slug)) return forbidden();
    } else if (!(options.publicRead ?? []).includes(slug)) return forbidden();

    const hasStatus = collection.docs.some((d) => d.status !== undefined);
    const where = [...q.keys()].filter((k) => k.startsWith("where"));
    const wantsDrafts = where.length === 1 && where[0] === "where[_status][equals]";
    if (where.length > 0 && (!wantsDrafts || q.get("where[_status][equals]") !== "draft"))
      return json(400, { errors: [{ message: "Invalid where query." }] });
    if (wantsDrafts && !hasStatus)
      return json(400, { errors: [{ message: "The following path cannot be queried: _status." }] });
    const sort = q.get("sort");
    if (sort !== null && sort !== "id")
      return json(400, { errors: [{ message: "Invalid sort." }] });
    const limit = Number(q.get("limit") ?? "10");
    const page = Number(q.get("page") ?? "1");
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(page) || page < 1)
      return json(400, { errors: [{ message: "Invalid pagination." }] });
    const size = Math.min(limit, options.maxLimit ?? Number.POSITIVE_INFINITY);
    const selected = [...q.keys()]
      .map((k) => /^select\[([^\]]+)\]$/.exec(k)?.[1])
      .filter((k): k is string => k !== undefined);
    if (options.strictSelect) {
      const known = new Set([
        "id",
        "_status",
        "createdAt",
        "updatedAt",
        ...collection.docs.flatMap((d) => Object.keys(d.fields)),
      ]);
      if (selected.some((f) => !known.has(f)))
        return json(400, { errors: [{ message: "Invalid select." }] });
    }

    const all = collection.docs
      .filter((d) => !wantsDrafts || d.status === "draft")
      .sort((a, b) => String(a.id).localeCompare(String(b.id), "en", { numeric: true }));
    const row = (d: PayloadFixtureDoc): Record<string, unknown> => {
      const full: Record<string, unknown> = {
        id: d.id,
        ...(d.status !== undefined ? { _status: d.status } : {}),
        ...d.fields,
        ...(d.created !== null ? { createdAt: d.created } : {}),
        ...(d.updated !== null ? { updatedAt: d.updated } : {}),
      };
      // Payload's own rule: `id` always comes back; the other fields only when selected.
      return selected.length === 0
        ? full
        : Object.fromEntries(
            Object.entries(full).filter(([k]) => k === "id" || selected.includes(k)),
          );
    };
    const start = (page - 1) * size;
    const docs = all.slice(start, start + size).map(row);
    const totalPages = Math.max(1, Math.ceil(all.length / limit));
    return json(200, {
      docs,
      totalDocs: all.length,
      limit,
      totalPages,
      page,
      pagingCounter: start + 1,
      hasPrevPage: page > 1,
      hasNextPage: start + size < all.length,
      prevPage: page > 1 ? page - 1 : null,
      nextPage: start + size < all.length ? page + 1 : null,
    });
  };
}
