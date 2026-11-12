import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Larkspur Yoga Studio's invented Prismic repository: a small studio whose site a freelancer built with a Next.js
 * front end on Prismic, with classes, notices and teachers, and an autumn release. Nothing here was recorded from a
 * real repository; the answers are in the shape of the Document API as the build knew it (the platform's own pages
 * could not be reached, see docs/integrations/prismic.md). Every address is on a reserved `.example` domain.
 */
export const PRISMIC_SITE = "https://larkspur-yoga.example";
export const SITE_HOST = "larkspur-yoga.example";
export const REPOSITORY = "larkspur-yoga";
export const CACHE_HOST = "larkspur-yoga.cdn.prismic.io";
export const ORIGIN_HOST = "larkspur-yoga.prismic.io";

/** Text that is in the client's content, release included, and must never reach a report, a log or a hash input. */
export const PRISMIC_MARKERS = {
  morning: "Morning flow: slow breathing, then one long sun salutation",
  morningSummary: "Forty minutes, no experience needed, mats provided",
  evening: "Evening stretch for people who sit all day",
  retreat: "Autumn retreat, deposit not yet announced",
  ana: "Ana teaches the early classes and runs the retreat",
  ben: "Ben took over the Saturday workshop in October",
  notice: "The studio is closed on the last Friday of November",
} as const;

/** A rich text field as Prismic answers it: a list of blocks. */
export const rich = (text: string): unknown[] => [{ type: "paragraph", text, spans: [] }];

export interface FixtureDoc {
  id: string;
  uid: string | null;
  type: string;
  lang: string;
  first: string;
  last: string;
  data: Record<string, unknown>;
}

const doc = (
  id: string,
  type: string,
  uid: string | null,
  first: string,
  last: string,
  data: Record<string, unknown>,
  lang = "en-us",
): FixtureDoc => ({ id, uid, type, lang, first, last, data });

/** The live repository: what the master ref shows. */
export const LARKSPUR: FixtureDoc[] = [
  doc(
    "c-morning",
    "classes",
    "morning-flow",
    "2026-10-01T09:00:00.000Z",
    "2026-10-20T08:30:00.000Z",
    {
      name: rich(PRISMIC_MARKERS.morning),
      summary: rich(PRISMIC_MARKERS.morningSummary),
      seats: 14,
    },
  ),
  // The summary is an empty paragraph: Prismic's way of an empty rich text. It does not count as a field.
  doc(
    "c-evening",
    "classes",
    "evening-stretch",
    "2026-10-05T09:00:00.000Z",
    "2026-11-02T17:00:00.000Z",
    {
      name: rich(PRISMIC_MARKERS.evening),
      summary: rich(""),
      seats: 10,
    },
  ),
  doc(
    "n-closed",
    "notices",
    "closed-last-friday",
    "2026-11-03T12:00:00.000Z",
    "2026-11-03T12:00:00.000Z",
    {
      name: rich(PRISMIC_MARKERS.notice),
    },
  ),
  doc("t-ana", "teachers", "ana", "2026-06-01T09:00:00.000Z", "2026-09-01T09:00:00.000Z", {
    name: rich("Ana"),
    bio: rich(PRISMIC_MARKERS.ana),
  }),
  doc("t-ben", "teachers", "ben", "2026-10-10T09:00:00.000Z", "2026-10-10T09:00:00.000Z", {
    name: rich("Ben"),
    bio: rich(PRISMIC_MARKERS.ben),
  }),
];

export const MASTER_REF = "ZmFzdGVy-live";
export const OLD_MASTER_REF = "ZmFzdGVy-old";
export const RELEASE_REF = "ZnJldHJlYXQ~autumn";
export const RELEASE_ID = "rel-autumn";

/**
 * The autumn release: a new class that is not live yet, and an older copy of the evening stretch than the one that
 * went live on 2 November (someone published it after it was added to the release).
 */
export const RELEASE_DOCS: FixtureDoc[] = [
  ...LARKSPUR.map((d) => (d.id === "c-evening" ? { ...d, last: "2026-10-05T09:00:00.000Z" } : d)),
  doc(
    "c-retreat",
    "classes",
    "autumn-retreat",
    "2026-11-09T10:00:00.000Z",
    "2026-11-09T10:00:00.000Z",
    {
      name: rich(PRISMIC_MARKERS.retreat),
    },
  ),
];

/** The same release when nothing in it is behind the live copy. */
export const RELEASE_DOCS_CLEAN: FixtureDoc[] = [
  ...LARKSPUR,
  doc(
    "c-retreat",
    "classes",
    "autumn-retreat",
    "2026-11-09T10:00:00.000Z",
    "2026-11-09T10:00:00.000Z",
    {
      name: rich(PRISMIC_MARKERS.retreat),
    },
  ),
];

/** What the master ref showed before the evening stretch and the notice were published (the cache's old ref). */
export const OLD_MASTER_DOCS: FixtureDoc[] = LARKSPUR.filter((d) => d.id !== "n-closed").map((d) =>
  d.id === "c-evening" ? { ...d, last: "2026-10-05T09:00:00.000Z" } : d,
);

/** Where each type's pages live, as gaugeline.adapters.json says (notices have none of their own). */
export const LARKSPUR_URLS = { classes: "/classes/{slug}", teachers: "/teachers/{slug}" } as const;

export const PAGES_HEALTHY: Readonly<Record<string, number>> = {
  "/classes/morning-flow": 200,
  "/classes/evening-stretch": 200,
  "/teachers/ana": 200,
  "/teachers/ben": 200,
};

/** Drift: the evening stretch is published in Prismic and the front end has no page for it. */
export const PAGES_DRIFT: Readonly<Record<string, number>> = {
  ...PAGES_HEALTHY,
  "/classes/evening-stretch": 404,
};

export interface PrismicFixtureOptions {
  /**
   * The access token. When set the repository is private: every request needs `Authorization: Token <token>`, a
   * different one is 401, and the root lists the release only to a request that carries it.
   */
  token?: string;
  /**
   * The token that makes the root list releases while the repository is public (a public repository shows
   * published content to anyone and releases to a token).
   */
  releaseToken?: string;
  /** The content of each ref the repository knows. Default: the master, the old master and the autumn release. */
  snapshots?: Readonly<Record<string, readonly FixtureDoc[]>>;
  /** The master ref each host names, by how many times that host's root has been read (0-based). */
  masterRef?: (host: "cache" | "origin", read: number) => string;
  /** The releases the root lists (those the caller may see). Default: the autumn release. */
  releases?: readonly { id: string; label: string; ref: string; scheduledAt?: string }[];
  /** The main language the root names. Default: en-us. `none`: the root names none. */
  masterLang?: string | "none";
  /** Documents per page at most, whatever `pageSize` says (the real maximum is 100). */
  maxPageSize?: number;
  /** Answer `results_per_page` with this instead of the page size asked for. */
  perPage?: number;
  /** Refs that have expired: a query with one answers 410. */
  expired?: readonly string[];
  /** Change the answer of a documents query before it is sent (to model a server that misbehaves). */
  mangle?: (
    body: Record<string, unknown>,
    query: URLSearchParams,
    call: number,
  ) => Record<string, unknown>;
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

const failure = (status: number, type: string, message: string) => json(status, { type, message });

const ORDERINGS = /^\[document\.(first|last)_publication_date( desc)?\]$/;
const TYPE_FILTER = /^\[\[at\(document\.type, "([A-Za-z0-9_-]+)"\)\]\]$/;

/**
 * Prismic's Document API over the invented studio, and the front end's own pages. `GET /api/v2` answers the refs,
 * the document types and the languages; `GET /api/v2/documents/search` answers `{ page, results_per_page,
 * results_size, total_results_size, total_pages, next_page, prev_page, results }` for a `ref`, with `page`,
 * `pageSize`, `orderings`, one `q` filter on the type, `lang` and `fetch`. Only the orderings and the filter the
 * adapter sends are understood; any other is 400. A ref the repository does not know is 404 and an expired one 410.
 */
export function prismicTransport(
  content: readonly FixtureDoc[] = LARKSPUR,
  options: PrismicFixtureOptions = {},
): Transport {
  const snapshots: Record<string, readonly FixtureDoc[]> = options.snapshots ?? {
    [MASTER_REF]: content,
    [OLD_MASTER_REF]: OLD_MASTER_DOCS,
    [RELEASE_REF]: RELEASE_DOCS,
  };
  const reads = { cache: 0, origin: 0 };
  let searches = 0;
  return async (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host === SITE_HOST) return html((options.pages ?? PAGES_HEALTHY)[url.pathname] ?? 404);
    const host =
      url.host === CACHE_HOST ? "cache" : url.host === ORIGIN_HOST ? "origin" : undefined;
    if (host === undefined) return failure(404, "api_notfound_error", "not here");
    if (req.method !== "GET") return failure(405, "api_error", "method not allowed");
    const auth = req.headers.authorization;
    const withToken = (t: string | undefined): boolean => t !== undefined && auth === `Token ${t}`;
    if (options.token !== undefined && !withToken(options.token))
      return failure(401, "api_security_error", "This repository requires an access token.");
    const seesReleases = withToken(options.token) || withToken(options.releaseToken);

    if (url.pathname === "/api/v2") {
      const n = reads[host]++;
      const master = options.masterRef?.(host, n) ?? MASTER_REF;
      const releases = seesReleases
        ? (options.releases ?? [{ id: RELEASE_ID, label: "Autumn retreat", ref: RELEASE_REF }])
        : [];
      return json(200, {
        refs: [
          { id: "master", ref: master, label: "Master", isMasterRef: true },
          ...releases.map((r) => ({ ...r, isMasterRef: false })),
        ],
        types: { classes: "Class", notices: "Notice", teachers: "Teacher" },
        languages:
          options.masterLang === "none"
            ? []
            : [
                { id: options.masterLang ?? "en-us", name: "English", is_master: true },
                { id: "fr-fr", name: "French", is_master: false },
              ],
        forms: {},
        version: "fixture",
      });
    }
    if (url.pathname !== "/api/v2/documents/search")
      return failure(404, "api_notfound_error", "Route not found.");

    const q = url.searchParams;
    const ref = q.get("ref") ?? "";
    if (options.expired?.includes(ref)) return failure(410, "api_expired_error", "Ref expired.");
    const snapshot = snapshots[ref];
    if (snapshot === undefined) return failure(404, "api_notfound_error", "Ref not found.");
    const isRelease = ref === RELEASE_REF;
    if (isRelease && !seesReleases)
      return failure(401, "api_security_error", "A token is needed for this ref.");

    const order = ORDERINGS.exec(q.get("orderings") ?? "");
    if (order === null) return failure(400, "api_parsing_error", "Bad orderings.");
    const filter = q.get("q");
    const typeMatch = filter === null ? null : TYPE_FILTER.exec(filter);
    if (filter !== null && typeMatch === null) return failure(400, "api_parsing_error", "Bad q.");
    const lang = q.get("lang");
    const page = Number(q.get("page") ?? "1");
    const asked = Number(q.get("pageSize") ?? "20");
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(asked) || asked < 1)
      return failure(400, "api_parsing_error", "Bad page.");
    const size = Math.min(asked, options.maxPageSize ?? 100, 100);
    const field = order[1] === "first" ? "first" : "last";
    const sign = order[2] === " desc" ? -1 : 1;
    const all = snapshot
      .filter((d) => (typeMatch === null ? true : d.type === typeMatch[1]))
      .filter((d) => lang === "*" || d.lang === (options.masterLang ?? "en-us"))
      .slice()
      .sort(
        (a, b) =>
          sign * (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) || (a.id < b.id ? -1 : 1),
      );
    const fetchList = q.get("fetch")?.split(",") ?? [];
    const shape = (d: FixtureDoc): Record<string, unknown> => ({
      id: d.id,
      uid: d.uid,
      url: null,
      type: d.type,
      href: `https://${url.host}/api/v2/documents/search?ref=${ref}&q=%5B%5Bat(document.id%2C%22${d.id}%22)%5D%5D`,
      tags: [],
      first_publication_date: d.first,
      last_publication_date: d.last,
      slugs: [],
      linked_documents: [],
      lang: d.lang,
      alternate_languages: [],
      data:
        fetchList.length === 0
          ? d.data
          : Object.fromEntries(
              Object.entries(d.data).filter(([k]) => fetchList.includes(`${d.type}.${k}`)),
            ),
    });
    const body: Record<string, unknown> = {
      page,
      results_per_page: options.perPage ?? size,
      results_size: all.slice((page - 1) * size, page * size).length,
      total_results_size: all.length,
      total_pages: Math.ceil(all.length / size),
      next_page: null,
      prev_page: null,
      results: all.slice((page - 1) * size, page * size).map(shape),
    };
    return json(200, options.mangle ? options.mangle(body, q, searches++) : body);
  };
}
