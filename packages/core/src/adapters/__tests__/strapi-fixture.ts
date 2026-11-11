import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Brass Anchor Taproom's invented Strapi: a neighbourhood bar whose site a freelancer built with a
 * Next.js front end on a Strapi backend, with a CMS of events, menu items and reviews. Nothing here
 * was recorded from a real site; the answers are in the shape of Strapi's REST API as the build knew
 * it (the platform's pages could not be reached, see docs/integrations/strapi.md). Every address is
 * on a reserved `.example` domain.
 */
export const BRASS_SITE = "https://brass-anchor.example";
export const BRASS_HOST = "brass-anchor.example";
export const CMS_URL = "https://cms.brass-anchor.example";
export const CMS_HOST = "cms.brass-anchor.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const STRAPI_MARKERS = {
  quiz: "Tuesday pub quiz with a sausage roll round",
  quizBlurb: "Teams of six, a pint for the winners",
  harvest: "Harvest beer night, four casks on the bar",
  newYear: "New Year's Eve lock-in, tickets not announced",
  stout: "Anchor Stout, cask conditioned",
  stoutPrice: "Anchor Stout 4.80 a pint",
  pie: "Steak and ale pie with mash",
  review: "The best snug in the whole town",
} as const;

export interface StrapiFixtureEntry {
  id: number;
  documentId: string;
  fields: Record<string, unknown>;
  /** When the published version went out. Null: the entry was never published (a draft only). */
  publishedAt: string | null;
  updatedAt: string;
}

export interface StrapiFixtureCollection {
  /** The collection's API ID (its plural name), which is the type name everywhere else. */
  name: string;
  entries: StrapiFixtureEntry[];
}

function entry(
  id: number,
  documentId: string,
  fields: Record<string, unknown>,
  publishedAt: string | null,
  updatedAt: string,
): StrapiFixtureEntry {
  return { id, documentId, fields, publishedAt, updatedAt };
}

export const BRASS: StrapiFixtureCollection[] = [
  {
    name: "events",
    entries: [
      entry(
        1,
        "evt-harvest",
        {
          title: STRAPI_MARKERS.harvest,
          slug: "harvest-beer-night",
          blurb: STRAPI_MARKERS.quizBlurb,
        },
        "2026-10-20T09:00:00.000Z",
        "2026-10-20T09:00:00.000Z",
      ),
      entry(
        2,
        "evt-quiz",
        { title: STRAPI_MARKERS.quiz, slug: "pub-quiz" },
        "2026-11-01T09:00:00.000Z",
        "2026-11-01T09:00:00.000Z",
      ),
      // Never published: a draft only.
      entry(
        3,
        "evt-new-year",
        { title: STRAPI_MARKERS.newYear, slug: "new-year-lock-in" },
        null,
        "2026-11-09T18:00:00.000Z",
      ),
    ],
  },
  {
    name: "menu-items",
    entries: [
      entry(
        4,
        "mnu-stout",
        { name: STRAPI_MARKERS.stout, slug: "anchor-stout", price: STRAPI_MARKERS.stoutPrice },
        "2026-09-01T09:00:00.000Z",
        "2026-09-01T09:00:00.000Z",
      ),
      entry(
        5,
        "mnu-pie",
        { name: STRAPI_MARKERS.pie, slug: "steak-and-ale-pie" },
        "2026-09-02T09:00:00.000Z",
        "2026-09-02T09:00:00.000Z",
      ),
    ],
  },
  {
    name: "reviews",
    entries: [
      entry(
        6,
        "rev-snug",
        { author: "A regular", slug: "a-regular", quote: STRAPI_MARKERS.review },
        "2026-08-01T09:00:00.000Z",
        "2026-08-01T09:00:00.000Z",
      ),
      entry(
        7,
        "rev-first",
        { author: "A first-timer", slug: "a-first-timer" },
        "2026-08-02T09:00:00.000Z",
        "2026-08-02T09:00:00.000Z",
      ),
    ],
  },
];

/** The same site with every draft published: nothing is waiting. */
export const BRASS_SETTLED: StrapiFixtureCollection[] = BRASS.map((c) => ({
  ...c,
  entries: c.entries.map((e) =>
    e.publishedAt === null ? { ...e, publishedAt: "2026-11-10T09:00:00.000Z" } : e,
  ),
}));

/** Where each collection's pages live, as gaugeline.adapters.json says (reviews have no pages of their own). */
export const BRASS_URLS = { events: "/events/{slug}", "menu-items": "/menu/{slug}" } as const;

/** A healthy site: every published entry has its page. */
export const PAGES_HEALTHY: Readonly<Record<string, number>> = {
  "/events/harvest-beer-night": 200,
  "/events/pub-quiz": 200,
  "/menu/anchor-stout": 200,
  "/menu/steak-and-ale-pie": 200,
};

/** Drift: the pub quiz is published in Strapi and the front end has no page for it. */
export const PAGES_DRIFT: Readonly<Record<string, number>> = {
  ...PAGES_HEALTHY,
  "/events/pub-quiz": 404,
};

export interface StrapiFixtureOptions {
  /** The token the site accepts: a different one is 401. */
  token?: string;
  /** Collections the token may not read: 403 on them only (its permissions do not include find). */
  denied?: readonly string[];
  /** Collections whose published entries the Public role may list, with no token. Default: none. */
  publicPublished?: readonly string[];
  /** Collections whose drafts the Public role may list, with no token (the leak). Default: none. */
  publicDrafts?: readonly string[];
  /** 5 (default): flat rows, `status=draft`. 4: rows wrapped in `attributes`, `publicationState=preview`. */
  version?: 4 | 5;
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
    body: Readable.from([Buffer.from("<!doctype html><title>Brass Anchor</title><p>ok</p>")]),
  });

const forbidden = () =>
  json(403, { data: null, error: { status: 403, name: "ForbiddenError", message: "Forbidden" } });

/**
 * Strapi's REST API over the invented bar, and the front end's own pages. A list answers
 * `{ data, meta: { pagination: { page, pageSize, pageCount, total } } }` with at most 100 rows a page
 * (a larger pageSize is 400, as Strapi does); the default list holds what is published, the draft
 * list (`status=draft`, or `publicationState=preview` on Strapi 4) every entry. The spelling the
 * installed version does not know is 400. With `fields[0]=updatedAt` a row has its ids and that time only.
 */
export function strapiTransport(
  content: readonly StrapiFixtureCollection[] = BRASS,
  options: StrapiFixtureOptions = {},
): Transport {
  const version = options.version ?? 5;
  return async (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host === BRASS_HOST) return html((options.pages ?? PAGES_HEALTHY)[url.pathname] ?? 404);
    if (url.host !== CMS_HOST) return json(404, { error: { status: 404 } });
    if (req.method !== "GET") return json(405, { error: { status: 405 } });
    const route = /^\/api\/([^/]+)$/.exec(url.pathname);
    if (!route) return json(404, { data: null, error: { status: 404, name: "NotFoundError" } });
    const name = decodeURIComponent(route[1] ?? "");
    const collection = content.find((c) => c.name === name);
    const q = url.searchParams;
    const wantsDrafts = q.get("status") === "draft" || q.get("publicationState") === "preview";

    const auth = req.headers.authorization;
    if (auth !== undefined) {
      if (options.token !== undefined && auth !== `Bearer ${options.token}`)
        return json(401, { data: null, error: { status: 401, name: "UnauthorizedError" } });
      if (options.denied?.includes(name)) return forbidden();
    } else {
      if (!(options.publicPublished ?? []).includes(name)) return forbidden();
      if (wantsDrafts && !(options.publicDrafts ?? []).includes(name)) return forbidden();
    }
    if (!collection)
      return json(404, { data: null, error: { status: 404, name: "NotFoundError" } });

    // A parameter the version does not know is refused, as Strapi 5 does.
    if (q.has("status") && version === 4) return json(400, { error: { status: 400 } });
    if (q.has("publicationState") && version === 5) return json(400, { error: { status: 400 } });

    const page = Number(q.get("pagination[page]") ?? "1");
    const size = Number(q.get("pagination[pageSize]") ?? "25");
    if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(page) || page < 1)
      return json(400, { error: { status: 400, name: "ValidationError" } });
    const all = collection.entries
      .filter((e) => wantsDrafts || e.publishedAt !== null)
      .sort((a, b) => a.id - b.id);
    const slice = all.slice((page - 1) * size, page * size);
    const small = q.get("fields[0]") === "updatedAt";
    const row = (e: StrapiFixtureEntry): Record<string, unknown> => {
      // The draft list of Strapi 5 shows the draft version of every entry: no published time.
      const publishedAt = version === 5 && wantsDrafts ? null : e.publishedAt;
      const body = small
        ? { updatedAt: e.updatedAt }
        : {
            ...e.fields,
            createdAt: "2026-05-01T10:00:00.000Z",
            updatedAt: e.updatedAt,
            publishedAt,
          };
      return version === 5
        ? { id: e.id, documentId: e.documentId, ...body }
        : { id: e.id, attributes: body };
    };
    return json(200, {
      data: slice.map(row),
      meta: {
        pagination: {
          page,
          pageSize: size,
          pageCount: Math.max(1, Math.ceil(all.length / size)),
          total: all.length,
        },
      },
    });
  };
}
