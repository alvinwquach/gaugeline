import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import { parseGraphql, type GqlSelection } from "../../query/graphql-parse.js";

/**
 * Larkspur Yoga Studio's invented DatoCMS project: a small studio whose site a freelancer built on DatoCMS, with
 * classes, teachers and notices. Nothing here was recorded from a real project, and every address is on a reserved
 * `.example` domain. The answers have the shape of a GraphQL answer (`data`, or `errors`) from the Content
 * Delivery API's one endpoint; the record fields (`_updatedAt`, `_publishedAt`) are as the adapter asks for them.
 *
 * Four things are true on purpose, because the contract suite relies on them: a draft in the first collection, a
 * record that lacks a field the others have, at least two collections with two published records each, and a text
 * in every record that is the client's words (the markers).
 */
export const DATOCMS_HOST = "graphql.datocms.com";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const DATOCMS_MARKERS = {
  morning: "Morning flow: slow breathing, then one long sun salutation",
  morningSummary: "Forty minutes, no experience needed, mats provided",
  evening: "Evening stretch for people who sit all day",
  retreat: "Autumn retreat, deposit not yet announced",
  ana: "Ana teaches the early classes and runs the retreat",
  ben: "Ben took over the Saturday workshop in October",
  notice: "The studio is closed on the last Friday of November",
} as const;

export interface FixtureRecord {
  id: string;
  slug: string;
  /** A draft is a record that was saved and never published, or changed since: only a request that asks for drafts sees it. */
  published: boolean;
  updatedAt: string;
  publishedAt?: string;
  fields: Record<string, unknown>;
}

export interface FixtureCollection {
  /** The content type as Gaugeline names it (the key in `collections`). */
  type: string;
  /** The GraphQL collection field, such as allClasses. */
  collection: string;
  records: FixtureRecord[];
}

export const DATOCMS_CONTENT: FixtureCollection[] = [
  {
    type: "classes",
    collection: "allClasses",
    records: [
      {
        id: "1001",
        slug: "morning-flow",
        published: true,
        publishedAt: "2026-10-01T09:00:00.000Z",
        updatedAt: "2026-10-20T08:30:00.000Z",
        fields: {
          name: DATOCMS_MARKERS.morning,
          summary: DATOCMS_MARKERS.morningSummary,
          seats: 14,
          seo: { title: "Morning flow" },
        },
      },
      // No summary: a field a record lacks is left out of its hashes, never hashed as empty.
      {
        id: "1002",
        slug: "evening-stretch",
        published: true,
        publishedAt: "2026-10-05T09:00:00.000Z",
        updatedAt: "2026-11-02T17:00:00.000Z",
        fields: { name: DATOCMS_MARKERS.evening, seats: 20 },
      },
      // A draft: saved and not published. A request that does not ask for drafts never gets it.
      {
        id: "1003",
        slug: "autumn-retreat",
        published: false,
        updatedAt: "2026-11-09T10:00:00.000Z",
        fields: { name: DATOCMS_MARKERS.retreat },
      },
    ],
  },
  {
    type: "notices",
    collection: "allNotices",
    records: [
      {
        id: "2001",
        slug: "closed-last-friday",
        published: true,
        publishedAt: "2026-11-03T12:00:00.000Z",
        updatedAt: "2026-11-03T12:00:00.000Z",
        fields: { name: DATOCMS_MARKERS.notice },
      },
    ],
  },
  {
    type: "teachers",
    collection: "allTeachers",
    records: [
      {
        id: "3001",
        slug: "ana",
        published: true,
        publishedAt: "2026-06-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
        fields: { name: "Ana", bio: DATOCMS_MARKERS.ana },
      },
      {
        id: "3002",
        slug: "ben",
        published: true,
        publishedAt: "2026-10-10T09:00:00.000Z",
        updatedAt: "2026-10-10T09:00:00.000Z",
        fields: { name: "Ben", bio: DATOCMS_MARKERS.ben },
      },
    ],
  },
];

/** The settings `collections` entry that matches this fixture. */
export const DATOCMS_COLLECTIONS = {
  classes: { collection: "allClasses", slug: "slug" },
  notices: { collection: "allNotices", slug: "slug" },
  teachers: { collection: "allTeachers", slug: "slug" },
} as const;

export interface DatocmsFixtureOptions {
  /** When set, a request without `Authorization: Bearer <token>` is answered 401. */
  token?: string;
  /**
   * What a request that carries `X-Include-Drafts: true` is answered with. "drafts" (default): the drafts are
   * included, like a token that may preview. "refused": 403, like a token that may not. "ignored": the header
   * has no effect and the published list comes back, like a project with no unpublished record.
   * "refused-after-first-page": the first page of a draft list is answered and every later page is 403.
   */
  drafts?: "drafts" | "refused" | "ignored" | "refused-after-first-page";
  /** Called with every request, to see what was asked. */
  onRequest?: (request: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    body: string;
  }) => void;
  /** The `count` the collection's meta field gives, instead of the true one (for the count tests). */
  countOverride?: (collection: string, drafts: boolean) => number | undefined;
  /** Answers the whole of one collection's next request with this body instead (for the odd-answer tests). */
  override?: (collection: string, skip: number) => unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** The record a selection asks for: only the names it lists, nested where the selection nests. */
function project(
  value: Record<string, unknown>,
  selections: readonly GqlSelection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of selections) {
    if (s.kind !== "field") continue;
    const v = value[s.name];
    if (v === undefined) continue;
    out[s.name] =
      s.selections !== undefined && v !== null && typeof v === "object"
        ? project(v as Record<string, unknown>, s.selections)
        : v;
  }
  return out;
}

/**
 * DatoCMS's Content Delivery API over the invented project: one POST endpoint, `https://graphql.datocms.com/`.
 * A collection answers at most 500 records a page (a larger `first` is an error, as the documentation says),
 * only a query is answered, and `X-Include-Drafts: true` adds the drafts when the token may preview.
 */
export function datocmsTransport(
  content: readonly FixtureCollection[] = DATOCMS_CONTENT,
  options: DatocmsFixtureOptions = {},
): Transport {
  return (url, req) => {
    const body = req.body ?? "";
    options.onRequest?.({ method: req.method, url, headers: req.headers, body });
    if (url.host !== DATOCMS_HOST) return json(404, { message: "not here" });
    if (req.method !== "POST") return json(405, { message: "method not allowed" });
    if (url.pathname !== "/") return json(404, { message: "no such route" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { errors: [{ message: "Request not authorized" }] });

    const asked = JSON.parse(body) as { query?: string };
    const document = parseGraphql(asked.query ?? "");
    const operation = document[0];
    if (operation?.kind !== "operation" || operation.operation !== "query")
      return json(200, { errors: [{ message: "only queries are answered here" }] });

    const wantsDrafts = req.headers["x-include-drafts"] === "true";
    const mode = options.drafts ?? "drafts";
    if (wantsDrafts && mode === "refused")
      return json(403, { errors: [{ message: "This token cannot read drafts" }] });
    const withDrafts = wantsDrafts && (mode === "drafts" || mode === "refused-after-first-page");

    const data: Record<string, unknown> = {};
    for (const field of operation.selections) {
      if (field.kind !== "field") continue;
      // A collection's meta field, `_allClassesMeta { count }`.
      const meta = /^_(all[A-Za-z]+)Meta$/.exec(field.name);
      if (meta !== null) {
        const target = content.find((c) => c.collection === meta[1]);
        if (target === undefined)
          return json(200, {
            errors: [{ message: `Cannot query field ${field.name} on type Query` }],
          });
        const shown = target.records.filter((r) => withDrafts || r.published).length;
        data[field.name] = {
          count: options.countOverride?.(target.collection, withDrafts) ?? shown,
        };
        continue;
      }
      const collection = content.find((c) => c.collection === field.name);
      if (collection === undefined)
        return json(200, {
          errors: [{ message: `Cannot query field ${field.name} on type Query` }],
        });
      const text = asked.query ?? "";
      const page = new RegExp(
        `${field.name}\\(first: (\\d+), skip: (\\d+), orderBy: \\[id_ASC\\]\\)`,
      ).exec(text);
      if (page === null)
        return json(200, {
          errors: [{ message: "first, skip and an explicit orderBy are required here" }],
        });
      const first = Number(page[1]);
      const skip = Number(page[2]);
      if (first < 1 || first > 500)
        return json(200, { errors: [{ message: "first must be 1 to 500" }] });
      if (wantsDrafts && mode === "refused-after-first-page" && skip !== 0)
        return json(403, { errors: [{ message: "This token cannot read drafts" }] });
      const odd = options.override?.(field.name, skip);
      if (odd !== undefined) {
        data[field.name] = odd;
        continue;
      }
      const visible = collection.records
        .filter((r) => withDrafts || r.published)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      data[field.name] = visible.slice(skip, skip + first).map((r) =>
        project(
          {
            id: r.id,
            _updatedAt: r.updatedAt,
            _publishedAt: r.publishedAt ?? null,
            slug: r.slug,
            ...r.fields,
          },
          field.selections ?? [],
        ),
      );
    }
    return json(200, { data });
  };
}
