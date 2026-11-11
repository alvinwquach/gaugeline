import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import type { GenericApiMapping } from "../generic-api-config.js";

/**
 * Heron Yoga Studio: an invented studio whose freelancer wired three sources into one site, so the
 * generic adapter's three paging styles and its GraphQL path each have a recorded world to read.
 * Nothing here was recorded from a real service: the answers are written by hand in the shape the
 * mapping describes.
 *
 * - posts: a Payload-style REST list, paged by number (`page`, `limit`), with `hasNextPage` and `totalDocs`.
 * - classes: a Directus-style REST list, paged by offset, with `meta.filter_count`, a field list
 *   (`fields=`), one class never edited (`date_updated` is null) and one draft.
 * - workshops: a GraphQL connection read with GET, paged by cursor.
 */
export const HERON = "https://cms.heron-yoga.example";

export const HERON_MARKERS = {
  postOne: "Beginner flow starts in January",
  postTwo: "Why we closed on the solstice",
  postThree: "Studio hours over the holidays",
  postFour: "Meet the Thursday teacher",
  postFive: "Mat care in winter",
  summaryOne: "Six weeks, no experience needed",
  summaryTwo: "A short note on the closure",
  summaryThree: "Open the usual hours except the 25th",
  summaryFour: "Fern teaches the evening class",
  classOne: "Sunrise vinyasa",
  classTwo: "Restorative evening",
  classThree: "Lunchtime stretch",
  classDraft: "Winter retreat, not announced",
  workshopOne: "Inversions for beginners",
  workshopTwo: "Breathwork afternoon",
  workshopThree: "Partner yoga night",
} as const;

export interface HeronPost {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  seo?: { title: string };
  updatedAt: string;
  createdAt: string;
}

export const HERON_POSTS: HeronPost[] = [
  {
    id: "p-1",
    slug: "beginner-flow",
    title: HERON_MARKERS.postOne,
    summary: HERON_MARKERS.summaryOne,
    seo: { title: "Beginner flow" },
    updatedAt: "2026-11-04T09:00:00.000Z",
    createdAt: "2026-10-01T08:00:00.000Z",
  },
  {
    id: "p-2",
    slug: "solstice-closure",
    title: HERON_MARKERS.postTwo,
    summary: HERON_MARKERS.summaryTwo,
    updatedAt: "2026-11-02T12:30:00.000Z",
    createdAt: "2026-10-05T08:00:00.000Z",
  },
  {
    id: "p-3",
    slug: "holiday-hours",
    title: HERON_MARKERS.postThree,
    summary: HERON_MARKERS.summaryThree,
    seo: { title: "Holiday hours" },
    updatedAt: "2026-10-28T16:00:00.000Z",
    createdAt: "2026-10-10T08:00:00.000Z",
  },
  {
    id: "p-4",
    slug: "thursday-teacher",
    title: HERON_MARKERS.postFour,
    summary: HERON_MARKERS.summaryFour,
    updatedAt: "2026-10-20T10:15:00.000Z",
    createdAt: "2026-10-12T08:00:00.000Z",
  },
  {
    id: "p-5",
    slug: "mat-care",
    title: HERON_MARKERS.postFive,
    updatedAt: "2026-09-30T07:45:00.000Z",
    createdAt: "2026-09-15T08:00:00.000Z",
  },
];

interface HeronClass {
  id: string;
  status: "published" | "draft";
  slug: string;
  name: string;
  date_created: string;
  date_updated: string | null;
}

const CLASSES: HeronClass[] = [
  {
    id: "c-1",
    status: "published",
    slug: "sunrise-vinyasa",
    name: HERON_MARKERS.classOne,
    date_created: "2026-08-01T06:00:00Z",
    date_updated: "2026-10-30T18:00:00Z",
  },
  {
    id: "c-2",
    status: "published",
    slug: "restorative-evening",
    name: HERON_MARKERS.classTwo,
    date_created: "2026-08-02T06:00:00Z",
    date_updated: null,
  },
  {
    id: "c-3",
    status: "published",
    slug: "lunchtime-stretch",
    name: HERON_MARKERS.classThree,
    date_created: "2026-09-02T06:00:00Z",
    date_updated: "2026-11-01T11:00:00Z",
  },
  {
    id: "c-4",
    status: "draft",
    slug: "winter-retreat",
    name: HERON_MARKERS.classDraft,
    date_created: "2026-11-05T06:00:00Z",
    date_updated: null,
  },
];

interface HeronWorkshop {
  id: string;
  slug: string;
  title: string;
  level?: string;
  updatedAt: string;
}

const WORKSHOPS: HeronWorkshop[] = [
  {
    id: "w-1",
    slug: "inversions",
    title: HERON_MARKERS.workshopOne,
    level: "beginner",
    updatedAt: "2026-10-15T10:00:00Z",
  },
  {
    id: "w-2",
    slug: "breathwork",
    title: HERON_MARKERS.workshopTwo,
    level: "all",
    updatedAt: "2026-10-22T10:00:00Z",
  },
  {
    id: "w-3",
    slug: "partner-night",
    title: HERON_MARKERS.workshopThree,
    updatedAt: "2026-11-03T10:00:00Z",
  },
];

/** The mapping the contract entry and the tests read the studio with. */
export const HERON_API: GenericApiMapping = {
  endpoint: HERON,
  auth: { header: "Authorization", env: "GAUGELINE_API_HERON_TOKEN", prefix: "Bearer " },
  collections: {
    post: {
      path: "/api/posts",
      query: { depth: "0" },
      items: "/docs",
      total: "/totalDocs",
      pagination: {
        style: "page",
        page: "page",
        size: "limit",
        pageSize: 2,
        more: "/hasNextPage",
      },
      fields: {
        id: "/id",
        slug: "/slug",
        updatedAt: "/updatedAt",
        publishedAt: "/createdAt",
      },
    },
    class: {
      path: "/items/classes",
      query: { meta: "filter_count", sort: "id", "filter[status][_eq]": "published" },
      items: "/data",
      total: "/meta/filter_count",
      pagination: { style: "offset", limit: "limit", offset: "offset", pageSize: 2 },
      select: {
        param: "fields",
        always: ["id", "slug", "date_updated", "date_created"],
      },
      fields: {
        id: "/id",
        slug: "/slug",
        updatedAt: ["/date_updated", "/date_created"],
        publishedAt: "/date_created",
      },
    },
    workshop: {
      graphql:
        "query Workshops($first: Int!, $after: String) { workshopsConnection(first: $first, after: $after, orderBy: id_ASC, stage: PUBLISHED) { edges { node { id slug updatedAt __FIELDS__ } } pageInfo { endCursor hasNextPage } } }",
      items: "/data/workshopsConnection/edges",
      fieldRoot: "/node",
      pagination: {
        style: "cursor",
        cursor: "after",
        size: "first",
        pageSize: 2,
        next: "/data/workshopsConnection/pageInfo/endCursor",
        more: "/data/workshopsConnection/pageInfo/hasNextPage",
      },
      fields: { id: "/node/id", slug: "/node/slug", updatedAt: "/node/updatedAt" },
    },
  },
  drafts: { collection: "class", query: { "filter[status][_eq]": "draft" } },
};

export const HERON_URLS = {
  post: "/blog/{slug}",
  class: "/classes/{slug}",
  workshop: "/workshops/{slug}",
} as const;

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

export interface HeronOptions {
  /** The key the platform wants. When set, a request without it in `header` is a 401. */
  key?: string;
  /** The header the key must be in (lower case). Default `authorization`. */
  header?: string;
  /** What comes before the key in that header. Default `Bearer `. */
  prefix?: string;
  /** The GraphQL endpoint answers only POST: a GET is a 405. */
  graphqlPostOnly?: boolean;
  /** The GraphQL endpoint answers every query with an error. */
  graphqlErrors?: boolean;
  /** Ignore the paging parameters: always answer the first page. */
  ignorePaging?: boolean;
  /** Where the post list is in the answer (a wrong mapping asks for `/docs`). Default `docs`. */
  postsAt?: string;
  /** Every class carries this many extra copies, to make a collection long. */
  repeat?: number;
}

/** The studio's three sources. Only GET is answered; anything else is a 405. */
export function heronTransport(options: HeronOptions = {}): Transport {
  const header = options.header ?? "authorization";
  const expected =
    options.key === undefined ? undefined : `${options.prefix ?? "Bearer "}${options.key}`;
  return async (url, req) => {
    if (req.method !== "GET") return respond(405, { error: "method not allowed" });
    if (url.origin !== HERON) return respond(404, { error: "wrong host" });
    if (expected !== undefined && req.headers[header] !== expected)
      return respond(401, { errors: [{ message: "You are not allowed to do that." }] });
    const q = url.searchParams;

    if (url.pathname === "/api/posts") {
      const limit = Number(q.get("limit") ?? "10");
      const page = options.ignorePaging ? 1 : Number(q.get("page") ?? "1");
      const rows = HERON_POSTS.slice((page - 1) * limit, page * limit);
      const totalPages = Math.ceil(HERON_POSTS.length / limit);
      return respond(200, {
        [options.postsAt ?? "docs"]: rows,
        totalDocs: HERON_POSTS.length,
        limit,
        page,
        totalPages,
        hasNextPage: page < totalPages,
      });
    }

    if (url.pathname === "/items/classes") {
      const wanted = q.get("filter[status][_eq]") ?? "published";
      let all = CLASSES.filter((c) => c.status === wanted);
      if (options.repeat !== undefined)
        all = Array.from({ length: options.repeat }, (_, n) =>
          all.map((c) => ({ ...c, id: `${c.id}-${n}` })),
        ).flat();
      const limit = Number(q.get("limit") ?? "100");
      const offset = options.ignorePaging ? 0 : Number(q.get("offset") ?? "0");
      const fields = (q.get("fields") ?? "").split(",").filter(Boolean);
      const data = all.slice(offset, offset + limit).map((c) => {
        const row = c as unknown as Record<string, unknown>;
        return fields.length === 0
          ? row
          : Object.fromEntries(fields.filter((f) => f in row).map((f) => [f, row[f]]));
      });
      return respond(200, { data, meta: { filter_count: all.length, total_count: all.length } });
    }

    if (url.pathname === "/") {
      if (options.graphqlPostOnly) return respond(405, { error: "POST only" });
      const query = q.get("query") ?? "";
      if (options.graphqlErrors)
        return respond(200, { errors: [{ message: `Cannot query ${HERON_MARKERS.workshopOne}` }] });
      if (!/^\s*query\b/.test(query)) return respond(400, { error: "not a query" });
      const vars = JSON.parse(q.get("variables") ?? "{}") as { first?: number; after?: string };
      const first = vars.first ?? 100;
      const start =
        vars.after === undefined ? 0 : WORKSHOPS.findIndex((w) => `cur-${w.id}` === vars.after) + 1;
      const rows = WORKSHOPS.slice(start, start + first);
      const last = rows.at(-1);
      return respond(200, {
        data: {
          workshopsConnection: {
            edges: rows.map((w) => ({ cursor: `cur-${w.id}`, node: w })),
            pageInfo: {
              endCursor: last ? `cur-${last.id}` : null,
              hasNextPage: start + first < WORKSHOPS.length,
            },
          },
        },
      });
    }

    return respond(404, { error: "not found" });
  };
}
