import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import { parseGraphql, type GqlSelection } from "../../query/graphql-parse.js";

/**
 * Pennywhistle Bakehouse's invented Hygraph project: a pop-up bakery whose site a freelancer built on Hygraph,
 * with pages and events. Nothing here was recorded from a real project, and every address is on a reserved
 * `.example` domain. The answers have the shape of a GraphQL answer (`data`, or `errors`) from the Content API;
 * the system fields (`id`, `updatedAt`, `publishedAt`) and the `stage` argument are as the adapter asks for them
 * (the shape follows the schema in Hygraph's own examples repository, hygraph/hygraph-examples).
 *
 * Four things are true on purpose, because the contract suite relies on them: a page that is not published (it
 * exists in the DRAFT stage only), an entry that lacks a field the others have, two models with two published
 * entries each, and a text in every entry that is the client's words (the markers).
 */
export const HYGRAPH_HOST = "api-eu-central-1.hygraph.com";
export const HYGRAPH_PROJECT = "cm1pennywhistle0000bake01";
export const HYGRAPH_PATH = `/v2/${HYGRAPH_PROJECT}/master`;
export const HYGRAPH_URL = `https://${HYGRAPH_HOST}${HYGRAPH_PATH}`;
/** The invented live site the project's pages are on. */
export const HYGRAPH_SITE = "https://pennywhistle-bakehouse.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const HYGRAPH_MARKERS = {
  home: "Sourdough baked at five, gone by noon",
  homeSummary: "A pop-up bakehouse on Mill Lane, open Thursday to Sunday",
  menu: "Cardamom buns, rye loaves and one cheese scone",
  supper: "Winter supper club, six courses, tickets not yet announced",
  market: "Saturday market stall, a table by the fountain",
  popup: "Pop-up at the Harbour Hall, one weekend only",
} as const;

export interface FixtureEntry {
  id: string;
  slug: string;
  /** Not published: the entry exists in the DRAFT stage only. Only a request with `stage: DRAFT` sees it. */
  published: boolean;
  updatedAt: string;
  publishedAt?: string;
  fields: Record<string, unknown>;
}

export interface FixtureModel {
  /** The content type as Gaugeline names it (the key in `collections`). */
  type: string;
  /** The model's plural API ID, the Query field, such as pages. */
  collection: string;
  entries: FixtureEntry[];
}

export const HYGRAPH_CONTENT: FixtureModel[] = [
  {
    type: "pages",
    collection: "pages",
    entries: [
      {
        id: "cm1page000000000home001",
        slug: "home",
        published: true,
        publishedAt: "2026-10-01T09:00:00.000Z",
        updatedAt: "2026-10-20T08:30:00.000Z",
        fields: {
          title: HYGRAPH_MARKERS.home,
          summary: HYGRAPH_MARKERS.homeSummary,
          seo: { title: "Pennywhistle Bakehouse" },
        },
      },
      // No summary: a field an entry lacks is left out of its hashes, never hashed as empty.
      {
        id: "cm1page000000000menu002",
        slug: "menu",
        published: true,
        publishedAt: "2026-10-05T09:00:00.000Z",
        updatedAt: "2026-11-02T17:00:00.000Z",
        fields: { title: HYGRAPH_MARKERS.menu },
      },
      // Not published: saved and never published. A request for the PUBLISHED stage never gets it.
      {
        id: "cm1page000000000supp003",
        slug: "winter-supper-club",
        published: false,
        updatedAt: "2026-11-09T10:00:00.000Z",
        fields: { title: HYGRAPH_MARKERS.supper },
      },
    ],
  },
  {
    type: "events",
    collection: "events",
    entries: [
      {
        id: "cm1event00000000mrkt001",
        slug: "saturday-market",
        published: true,
        publishedAt: "2026-09-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
        fields: { title: HYGRAPH_MARKERS.market },
      },
      {
        id: "cm1event00000000popu002",
        slug: "harbour-popup",
        published: true,
        publishedAt: "2026-10-10T09:00:00.000Z",
        updatedAt: "2026-10-10T09:00:00.000Z",
        fields: { title: HYGRAPH_MARKERS.popup },
      },
    ],
  },
];

/** The settings `collections` entry that matches this fixture. */
export const HYGRAPH_COLLECTIONS = {
  pages: { collection: "pages", slug: "slug" },
  events: { collection: "events", slug: "slug" },
} as const;

export interface HygraphFixtureOptions {
  /** When set, a request without `Authorization: Bearer <token>` is answered 401. */
  token?: string;
  /**
   * What a request for `stage: DRAFT` is answered with. "readable" (default): the DRAFT stage, like a token with
   * read permission on it. "refused-errors": a GraphQL error and no data, like a token limited to PUBLISHED.
   * "refused-http": HTTP 403. "refused-after-first-page": the first page is answered and every later page is an
   * error.
   */
  draftStage?: "readable" | "refused-errors" | "refused-http" | "refused-after-first-page";
  /** Called with every request, to see what was asked. */
  onRequest?: (request: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    body: string;
  }) => void;
  /** The `count` a collection's connection gives, instead of the true one (for the count tests). */
  countOverride?: (collection: string, stage: string) => number | undefined;
  /** Answers one collection's page with this value instead (for the odd-answer tests). */
  override?: (collection: string, skip: number, stage: string) => unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** The entry a selection asks for: only the names it lists, nested where the selection nests. */
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
 * Hygraph's Content API over the invented project: one POST endpoint, `/v2/<project>/master`. A model answers
 * at most 1000 entries a page, only a query is answered, and the `stage` argument picks PUBLISHED (the default)
 * or DRAFT. `<models>Connection { aggregate { count } }` gives the count.
 */
export function hygraphTransport(
  content: readonly FixtureModel[] = HYGRAPH_CONTENT,
  options: HygraphFixtureOptions = {},
): Transport {
  return (url, req) => {
    const body = req.body ?? "";
    options.onRequest?.({ method: req.method, url, headers: req.headers, body });
    if (url.host !== HYGRAPH_HOST) return json(404, { message: "not here" });
    if (req.method !== "POST") return json(405, { message: "method not allowed" });
    if (url.pathname !== HYGRAPH_PATH) return json(404, { message: "no such route" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { errors: [{ message: "Unauthorized" }] });

    const asked = JSON.parse(body) as { query?: string };
    const text = asked.query ?? "";
    const document = parseGraphql(text);
    const operation = document[0];
    if (operation?.kind !== "operation" || operation.operation !== "query")
      return json(200, { errors: [{ message: "only queries are answered here" }] });

    const data: Record<string, unknown> = {};
    for (const field of operation.selections) {
      if (field.kind !== "field") continue;
      const connection = /^([A-Za-z]+)Connection$/.exec(field.name);
      const name = connection?.[1] ?? field.name;
      const model = content.find((c) => c.collection === name);
      if (model === undefined)
        return json(200, {
          errors: [{ message: `Cannot query field "${field.name}" on type "Query".` }],
        });
      const args = new RegExp(`${field.name}\\(([^)]*)\\)`).exec(text)?.[1] ?? "";
      const stage = /stage: (PUBLISHED|DRAFT)/.exec(args)?.[1] ?? "PUBLISHED";
      const mode = options.draftStage ?? "readable";
      if (stage === "DRAFT" && mode === "refused-http")
        return json(403, { errors: [{ message: "Forbidden" }] });
      const skip = Number(/skip: (\d+)/.exec(args)?.[1] ?? "0");
      if (
        stage === "DRAFT" &&
        (mode === "refused-errors" || (mode === "refused-after-first-page" && skip !== 0))
      )
        return json(200, {
          errors: [{ message: "Your token does not have permission to read this stage." }],
          data: null,
        });
      const visible = model.entries
        .filter((r) => stage === "DRAFT" || r.published)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (connection !== null) {
        data[field.name] = {
          aggregate: {
            count: options.countOverride?.(model.collection, stage) ?? visible.length,
          },
        };
        continue;
      }
      if (!/orderBy: id_ASC/.test(args))
        return json(200, { errors: [{ message: "an explicit orderBy is required here" }] });
      const first = Number(/first: (\d+)/.exec(args)?.[1] ?? "100");
      if (first < 1 || first > 1000)
        return json(200, { errors: [{ message: "first must be 1 to 1000" }] });
      const odd = options.override?.(model.collection, skip, stage);
      if (odd !== undefined) {
        data[field.name] = odd;
        continue;
      }
      data[field.name] = visible.slice(skip, skip + first).map((r) =>
        project(
          {
            id: r.id,
            stage,
            updatedAt: r.updatedAt,
            publishedAt: r.publishedAt ?? null,
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

/**
 * The live site, for the check that asks whether an unpublished entry has a page: a path answers 200 when it is in
 * `live`, 404 otherwise, 500 when it is in `broken`. Any other host is not here.
 */
export function siteTransport(
  live: readonly string[],
  broken: readonly string[] = [],
  onRequest?: (path: string, method: string) => void,
  /** A path that answers 301 to another path on the same site (the other path is answered as any path is). */
  redirects: Readonly<Record<string, string>> = {},
): Transport {
  return (url, req) => {
    onRequest?.(url.pathname, req.method);
    if (url.host !== new URL(HYGRAPH_SITE).host) return json(404, { message: "not here" });
    const to = redirects[url.pathname];
    if (to !== undefined) return json(301, { message: "moved" }, { location: to });
    if (broken.includes(url.pathname)) return json(500, { message: "broken" });
    return live.includes(url.pathname)
      ? Promise.resolve({
          status: 200,
          headers: { "content-type": "text/html" },
          body: Readable.from([Buffer.from("<html></html>")]),
        })
      : json(404, { message: "no page" });
  };
}

/** One transport for the CMS and the live site, as a run has one fetcher for both. */
export function bothTransport(cms: Transport, site: Transport): Transport {
  return (url, req) => (url.host === HYGRAPH_HOST ? cms(url, req) : site(url, req));
}
