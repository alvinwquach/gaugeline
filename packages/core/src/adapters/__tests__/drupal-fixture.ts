import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Fernlea Family Clinic's invented Drupal 10: a small clinic whose site a freelancer built on Drupal, with news
 * articles and pages (some saved and never published). Nothing here was recorded from a real site; the answers
 * are in the shape of Drupal core's JSON:API module as its source describes it (see docs/integrations/drupal.md).
 * Every address is on a reserved `.example` domain.
 */
export const DRUPAL_SITE = "https://fernlea-clinic.example";
export const SITE_HOST = "fernlea-clinic.example";

/** Text that is in the clinic's content, drafts included, and must never reach a report, a log or a hash input. */
export const DRUPAL_MARKERS = {
  flu: "Flu jab clinic: Tuesday evenings, no appointment needed",
  fluSubtitle: "Free for everyone over sixty-five",
  hours: "Opening hours over the winter holidays",
  staff: "Dr Okoro is leaving the practice in January",
  prices: "Private appointment price list for next year",
  about: "A family practice in the middle of the village",
  closure: "The surgery will close for two days in March",
} as const;

export interface DrupalFixtureNode {
  /** The JSON:API id: a UUID. */
  id: string;
  nid: number;
  bundle: "article" | "page";
  status: boolean | string | null | undefined;
  title: string;
  /** `null`: the node has no alias (Drupal sends `path.alias: null`). */
  alias: string | null | number;
  created: string | null;
  changed: string | null;
  extra?: Record<string, unknown>;
  /** The JSON:API `type`, when it is not the bundle's own (to test a server that mixes types). */
  typeOverride?: string;
}

const uuid = (n: number): string => `5f1c0a10-0000-4000-8000-${String(n).padStart(12, "0")}`;

const node = (
  n: number,
  bundle: "article" | "page",
  status: DrupalFixtureNode["status"],
  title: string,
  alias: DrupalFixtureNode["alias"],
  created: string,
  changed: string,
  extra?: Record<string, unknown>,
): DrupalFixtureNode => ({
  id: uuid(n),
  nid: n,
  bundle,
  status,
  title,
  alias,
  created,
  changed,
  ...(extra ? { extra } : {}),
});

export const FERNLEA: DrupalFixtureNode[] = [
  node(
    1,
    "article",
    true,
    DRUPAL_MARKERS.flu,
    "/news/flu-jab-clinic",
    "2026-10-20T10:00:00+00:00",
    "2026-11-02T10:00:00+00:00",
    { field_subtitle: DRUPAL_MARKERS.fluSubtitle },
  ),
  // No alias and no subtitle: a field an item lacks is left out of its hashes, never hashed as empty.
  node(
    2,
    "article",
    true,
    DRUPAL_MARKERS.hours,
    null,
    "2026-09-01T10:00:00+00:00",
    "2026-10-01T10:00:00+00:00",
  ),
  // Saved and never published: the node a visitor must not reach at /node/3.
  node(
    3,
    "article",
    false,
    DRUPAL_MARKERS.staff,
    "/news/staff-changes",
    "2026-11-05T10:00:00+00:00",
    "2026-11-05T10:00:00+00:00",
  ),
  node(
    4,
    "article",
    false,
    DRUPAL_MARKERS.prices,
    null,
    "2026-11-06T10:00:00+00:00",
    "2026-11-06T10:00:00+00:00",
  ),
  node(
    5,
    "page",
    true,
    DRUPAL_MARKERS.about,
    "/about",
    "2026-01-10T10:00:00+00:00",
    "2026-09-10T10:00:00+00:00",
  ),
  node(
    6,
    "page",
    false,
    DRUPAL_MARKERS.closure,
    null,
    "2026-11-08T10:00:00+00:00",
    "2026-11-08T10:00:00+00:00",
  ),
];

/** A larger site: `count` published articles, so a list has several pages. */
export function manyArticles(count: number, start = 100): DrupalFixtureNode[] {
  return Array.from({ length: count }, (_x, i) =>
    node(
      start + i,
      "article",
      true,
      `Notice number ${start + i}`,
      `/news/notice-${start + i}`,
      "2026-10-01T10:00:00+00:00",
      "2026-10-02T10:00:00+00:00",
    ),
  );
}

/** How the site answers a visitor's GET of /node/{nid}. */
export interface DrupalFixturePage {
  status: number;
  /** Drupal sent its own answer (the `X-Generator` header). Default: true. */
  drupal?: boolean;
  /** The Location of a redirect. */
  location?: string;
}

/** An unpublished node is a 403 "Access denied" from Drupal itself; a published node is a page. */
export const PAGES_CLOSED: Readonly<Record<number, DrupalFixturePage>> = {
  1: { status: 200 },
  2: { status: 200 },
  3: { status: 403 },
  4: { status: 403 },
  5: { status: 200 },
  6: { status: 403 },
};

/** Drift: the staff-changes article is unpublished in Drupal and its node page answers 200. */
export const PAGES_LEAK: Readonly<Record<number, DrupalFixturePage>> = {
  ...PAGES_CLOSED,
  3: { status: 200 },
};

export type DrupalCredential =
  { kind: "bearer"; token: string } | { kind: "basic"; user: string; password: string };

export interface DrupalFixtureOptions {
  /** The credential the site accepts. A request with another Authorization header is 401. */
  credential?: DrupalCredential;
  /** The credential's role may read unpublished content. Default: true. When false it sees only what a visitor sees. */
  seesUnpublished?: boolean;
  /** Visitors may read published content. Default: true. When false an anonymous read is 403. */
  anonymousRead?: boolean;
  /** The most resources one answer holds, whatever `page[limit]` asks (Drupal's own maximum is 50). Default: 50. */
  maxLimit?: number;
  /** Add `meta.count` (what jsonapi_extras adds). Default: no, as in Drupal core. */
  count?: boolean | "wrong" | "moving";
  /** Where the `next` link points: another host. */
  nextHost?: string;
  /** Where the `next` link points: another path. */
  nextPath?: string;
  /** The `next` link carries this offset instead of the right one. */
  nextOffset?: number;
  /** The `next` link is present on every page, last one included. */
  nextAlways?: boolean;
  /** Drop this many resources from every page after the offset maths (access-filtered resources). */
  omitPerPage?: number;
  /** Refuse (400) a sparse fieldset. */
  refuseFields?: boolean;
  /** The answers for /node/{nid}, by nid. A nid not here is 404 from Drupal. */
  pages?: Readonly<Record<number, DrupalFixturePage>>;
  /** The title a node page shows is never needed; this is the body of a node page when it answers 200. */
  pageBody?: string;
  /** Called with every request, before it is answered, to count them, look at them, or change the content. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>, n: number) => void;
}

const respond = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): ReturnType<Transport> =>
  Promise.resolve({
    status,
    headers,
    body: Readable.from([Buffer.from(body)]),
  }) as ReturnType<Transport>;

const api = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  respond(status, JSON.stringify(body), { "content-type": "application/vnd.api+json", ...headers });

const failure = (status: number, title: string) =>
  api(status, { errors: [{ title, status: String(status) }] });

const expectedHeader = (c: DrupalCredential | undefined): string | undefined =>
  c === undefined
    ? undefined
    : c.kind === "bearer"
      ? `Bearer ${c.token}`
      : `Basic ${Buffer.from(`${c.user}:${c.password}`).toString("base64")}`;

/**
 * Drupal core's JSON:API over the invented clinic, and the node pages. `GET /jsonapi/node/{bundle}` answers
 * `{ data: [...], links: { next } }` with `filter[status]`, `sort=id` (the UUID), `page[limit]` and
 * `page[offset]` and a sparse fieldset `fields[node--bundle]`; there is no total unless `count` is set. A
 * resource that the visitor may not see is left out, and unpublished nodes are listed only for a credential
 * whose role may see them. `GET /jsonapi/node/{bundle}/{id}` is one resource. `GET /node/{nid}` is the node's page.
 */
export function drupalTransport(
  nodes: readonly DrupalFixtureNode[] | (() => readonly DrupalFixtureNode[]) = FERNLEA,
  options: DrupalFixtureOptions = {},
): Transport {
  let requests = 0;
  const content = (): readonly DrupalFixtureNode[] =>
    typeof nodes === "function" ? nodes() : nodes;
  const want = expectedHeader(options.credential);
  return async (url, req) => {
    const n = requests++;
    options.onRequest?.(req.method, url, req.headers, n);
    if (url.host !== SITE_HOST) return failure(404, "Not found");
    if (req.method !== "GET") return failure(405, "Method not allowed");

    const nodePage = /^\/node\/(\d+)$/.exec(url.pathname);
    if (nodePage) {
      const page = (options.pages ?? PAGES_CLOSED)[Number(nodePage[1])];
      const drupalHeaders: Record<string, string> =
        page?.drupal === false ? {} : { "x-generator": "Drupal 10 (https://www.drupal.org)" };
      if (!page)
        return respond(404, "<html><title>Page not found</title></html>", {
          "content-type": "text/html",
          ...drupalHeaders,
        });
      if (page.location !== undefined)
        return respond(page.status, "", { location: page.location, ...drupalHeaders });
      return respond(
        page.status,
        page.status === 200
          ? (options.pageBody ?? "<!doctype html><title>Clinic</title><p>a page</p>")
          : "<!doctype html><title>Access denied</title>",
        { "content-type": "text/html", ...drupalHeaders },
      );
    }

    const one = /^\/jsonapi\/node\/([a-z_]+)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    const list = /^\/jsonapi\/node\/([a-z_]+)$/.exec(url.pathname);
    const route = one ?? list;
    if (!route) return failure(404, "Not found");

    const auth = req.headers.authorization;
    const authed = auth !== undefined && want !== undefined && auth === want;
    if (auth !== undefined && !authed) return failure(401, "Unauthorized");
    if (!authed && options.anonymousRead === false) return failure(403, "Forbidden");
    const sees = authed && options.seesUnpublished !== false;
    const bundle = route[1] ?? "";
    const type = `node--${bundle}`;
    const mine = content().filter((x) => x.bundle === bundle);
    if (bundle !== "article" && bundle !== "page") return failure(404, "Not found");
    const q = url.searchParams;
    const selected = q.get(`fields[${type}]`)?.split(",");
    if (selected !== undefined && options.refuseFields === true) return failure(400, "Bad request");

    const resource = (x: DrupalFixtureNode): Record<string, unknown> => {
      const type2 = x.typeOverride ?? type;
      const all: Record<string, unknown> = {
        drupal_internal__nid: x.nid,
        ...(x.status === undefined ? {} : { status: x.status }),
        title: x.title,
        created: x.created,
        changed: x.changed,
        path: { alias: x.alias, pid: x.alias ? x.nid : null, langcode: "en" },
        ...(x.extra ?? {}),
      };
      const attributes =
        selected === undefined
          ? all
          : Object.fromEntries(Object.entries(all).filter(([k]) => selected.includes(k)));
      return {
        type: type2,
        id: x.id,
        links: { self: { href: `${DRUPAL_SITE}${url.pathname}/${x.id}` } },
        attributes,
      };
    };

    if (one) {
      if (!authed) return failure(403, "Forbidden");
      const found = mine.find((x) => x.id === route[2]);
      return found ? api(200, { data: resource(found) }) : failure(404, "Not found");
    }

    const filter = q.get("filter[status]");
    const limit = Number(q.get("page[limit]") ?? "50");
    const offset = Number(q.get("page[offset]") ?? "0");
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0)
      return failure(400, "Bad request");
    const size = Math.min(limit, options.maxLimit ?? 50);
    const visible = mine
      .filter((x) => (x.status === true ? true : sees))
      .filter((x) => filter === null || (filter === "1" ? x.status === true : x.status !== true))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Drupal asks for one more than the page to know whether there is a next page, and offsets by the size it was asked.
    const slice = visible.slice(offset, offset + size);
    const hasNext = options.nextAlways === true || visible.length > offset + size;
    const rows = options.omitPerPage ? slice.slice(options.omitPerPage) : slice;

    const next = new URL(url.href);
    next.searchParams.set("page[offset]", String(options.nextOffset ?? offset + size));
    next.searchParams.set("page[limit]", String(size));
    if (options.nextHost !== undefined) next.host = options.nextHost;
    if (options.nextPath !== undefined) next.pathname = options.nextPath;
    const total =
      options.count === "wrong"
        ? visible.length + 1
        : options.count === "moving"
          ? visible.length + n
          : visible.length;
    return api(200, {
      jsonapi: { version: "1.0" },
      data: rows.map(resource),
      ...(options.count ? { meta: { count: total } } : {}),
      links: {
        self: { href: url.href },
        ...(hasNext ? { next: { href: next.href } } : {}),
      },
    });
  };
}
