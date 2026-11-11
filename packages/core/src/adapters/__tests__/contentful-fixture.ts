import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Ash & Ember Taproom's invented Contentful space: a neighbourhood bar whose Next.js site a freelancer
 * built on Contentful, with tap-list beers, events and testimonials. Nothing here was recorded from a
 * real space; the answers are in the shape of the Content Delivery API as the build knew it from the
 * contentful.js package's type definitions (the platform's own pages could not be reached, see
 * docs/integrations/contentful.md). Every address is on a reserved `.example` domain.
 */
export const ASH_SITE = "https://ash-and-ember.example";
export const ASH_HOST = "ash-and-ember.example";
export const SPACE_ID = "9fk2w1x7q3ab";

/** Text that is in the client's content and must never reach a report, a log or a hash input. */
export const CONTENTFUL_MARKERS = {
  trivia: "Quiz night with the brewery's head brewer",
  triviaSummary: "Six rounds, a cheese board for the winning table",
  dinner: "Brewers' dinner: five courses, five pours",
  amber: "Ember Amber, copper and toasted malt",
  stout: "Oat Stout, roasted oats and dark chocolate",
  stoutNotes: "Pours a little warm on purpose",
  hazy: "Ash Hazy IPA, citrus and a soft finish",
  quote: "The one pub I send out-of-town friends to",
  quote2: "Staff remember your order",
} as const;

export interface FixtureEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  fields: Record<string, unknown>;
}

export interface FixtureType {
  id: string;
  name: string;
  fields: string[];
  entries: FixtureEntry[];
  /** Entries saved in Contentful and not published: the Preview API serves them, the Delivery API never does. */
  drafts?: FixtureEntry[];
}

const entry = (
  id: string,
  createdAt: string,
  updatedAt: string,
  fields: Record<string, unknown>,
): FixtureEntry => ({ id, createdAt, updatedAt, fields });

export const ASH: FixtureType[] = [
  {
    id: "beer",
    name: "Beer",
    fields: ["title", "slug", "notes", "abv"],
    entries: [
      entry("beer-amber", "2026-03-01T10:00:00.000Z", "2026-10-01T09:00:00.000Z", {
        title: CONTENTFUL_MARKERS.amber,
        slug: "ember-amber",
        notes: "Copper pour",
        abv: 5.1,
      }),
      entry("beer-stout", "2026-03-02T10:00:00.000Z", "2026-10-02T09:00:00.000Z", {
        title: CONTENTFUL_MARKERS.stout,
        slug: "oat-stout",
        notes: CONTENTFUL_MARKERS.stoutNotes,
        abv: 4.8,
      }),
      // No notes field at all, as Contentful omits a field with no value.
      entry("beer-hazy", "2026-03-03T10:00:00.000Z", "2026-10-03T09:00:00.000Z", {
        title: CONTENTFUL_MARKERS.hazy,
        slug: "ash-hazy",
        abv: 6.2,
      }),
    ],
  },
  {
    id: "event",
    name: "Event",
    fields: ["title", "slug", "summary"],
    entries: [
      entry("ev-trivia", "2026-04-01T10:00:00.000Z", "2026-10-20T09:00:00.000Z", {
        title: CONTENTFUL_MARKERS.trivia,
        slug: "quiz-night",
        summary: CONTENTFUL_MARKERS.triviaSummary,
      }),
      entry("ev-dinner", "2026-04-02T10:00:00.000Z", "2026-11-02T09:00:00.000Z", {
        title: CONTENTFUL_MARKERS.dinner,
        slug: "brewers-dinner",
      }),
    ],
    drafts: [
      entry("ev-nye", "2026-11-05T10:00:00.000Z", "2026-11-09T10:00:00.000Z", {
        title: "New Year's Eve, details to come",
        slug: "new-years-eve",
      }),
    ],
  },
  {
    id: "testimonial",
    name: "Testimonial",
    fields: ["quote", "author"],
    entries: [
      entry("t-1", "2026-05-01T10:00:00.000Z", "2026-05-01T10:00:00.000Z", {
        quote: CONTENTFUL_MARKERS.quote,
        author: "A regular",
      }),
      entry("t-2", "2026-05-02T10:00:00.000Z", "2026-05-02T10:00:00.000Z", {
        quote: CONTENTFUL_MARKERS.quote2,
      }),
    ],
  },
];

/** Where each content type's pages live, as gaugeline.adapters.json says (testimonials have no pages of their own). */
export const ASH_URLS = { beer: "/beers/{slug}", event: "/events/{slug}" } as const;

/** A healthy site: every published entry has its page. */
export const PAGES_HEALTHY: Readonly<Record<string, number>> = {
  "/beers/ember-amber": 200,
  "/beers/oat-stout": 200,
  "/beers/ash-hazy": 200,
  "/events/quiz-night": 200,
  "/events/brewers-dinner": 200,
};

/** Drift: the brewers' dinner is published in Contentful and its page is gone (the site was not rebuilt). */
export const PAGES_DRIFT: Readonly<Record<string, number>> = {
  ...PAGES_HEALTHY,
  "/events/brewers-dinner": 404,
};

export interface ContentfulFixtureOptions {
  /** The delivery token the space accepts: anything else is 401. */
  token?: string;
  /** The preview token the space accepts on preview.contentful.com: anything else is 401. */
  previewToken?: string;
  /** The only environment the tokens are enabled for. Another is 404. Default: master. */
  environment?: string;
  /** The pages the site itself serves, by path. A path not here is 404. */
  pages?: Readonly<Record<string, number>>;
  /** Called with every request, to count them or look at their addresses. */
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
    body: Readable.from([Buffer.from("<!doctype html><title>Ash and Ember</title><p>ok</p>")]),
  });

const sysOf = (e: FixtureEntry, typeId: string) => ({
  type: "Entry",
  id: e.id,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
  revision: 3,
  space: { sys: { type: "Link", linkType: "Space", id: SPACE_ID } },
  environment: { sys: { type: "Link", linkType: "Environment", id: "master" } },
  contentType: { sys: { type: "Link", linkType: "ContentType", id: typeId } },
  locale: "en-US",
});

/**
 * The Content Delivery API (cdn.contentful.com) and the Content Preview API (preview.contentful.com)
 * over the invented space, and the site's own pages. A list answers `{ sys, total, skip, limit, items }`
 * with at most 1000 items a page (a larger `limit` is 400); `select` limits what an entry carries and
 * `select=fields.*` without a `content_type` is 400, as Contentful does. Only GET is answered.
 */
export function contentfulTransport(
  content: readonly FixtureType[] = ASH,
  options: ContentfulFixtureOptions = {},
): Transport {
  const environment = options.environment ?? "master";
  return async (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host === ASH_HOST) return html((options.pages ?? PAGES_HEALTHY)[url.pathname] ?? 404);
    const preview = url.host === "preview.contentful.com";
    if (!preview && url.host !== "cdn.contentful.com") return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { sys: { id: "MethodNotAllowed" } });
    const token = preview ? options.previewToken : options.token;
    if (token !== undefined && req.headers.authorization !== `Bearer ${token}`)
      return json(401, { sys: { type: "Error", id: "AccessTokenInvalid" }, message: "no" });

    const m = /^\/spaces\/([^/]+)\/environments\/([^/]+)\/(content_types|entries)$/.exec(
      url.pathname,
    );
    if (!m || m[1] !== SPACE_ID || m[2] !== environment)
      return json(404, { sys: { type: "Error", id: "NotFound" }, message: "not found" });

    const limit = Number(url.searchParams.get("limit") ?? "100");
    const skip = Number(url.searchParams.get("skip") ?? "0");
    if (
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > 1000 ||
      !Number.isInteger(skip) ||
      skip < 0
    )
      return json(400, { sys: { type: "Error", id: "BadRequest" } });

    if (m[3] === "content_types") {
      const items = content.slice(skip, skip + limit).map((t) => ({
        sys: { type: "ContentType", id: t.id },
        name: t.name,
        fields: t.fields.map((id) => ({ id, name: id, type: "Symbol" })),
      }));
      return json(200, { sys: { type: "Array" }, total: content.length, skip, limit, items });
    }

    const typeId = url.searchParams.get("content_type");
    const select = (url.searchParams.get("select") ?? "").split(",").filter(Boolean);
    if (select.some((s) => s.startsWith("fields.")) && typeId === null)
      return json(400, {
        sys: { type: "Error", id: "BadRequest" },
        message: "select requires content_type",
      });
    const type = content.find((t) => t.id === typeId);
    if (typeId !== null && !type)
      return json(400, { sys: { type: "Error", id: "UnknownContentType" } });
    // A field the content type does not have in `select` is a 400 too, so the adapter must not ask for one.
    for (const s of select)
      if (s.startsWith("fields.") && !type?.fields.includes(s.slice("fields.".length)))
        return json(400, { sys: { type: "Error", id: "InvalidSelect" } });
    const all = (type ? [type] : content).flatMap((t) =>
      [...t.entries, ...(preview ? (t.drafts ?? []) : [])].map((e) => ({ t, e })),
    );
    // `sys.updatedAt[gte]=<ISO time>`: only entries updated at or after it, as Contentful's search does.
    const since = url.searchParams.get("sys.updatedAt[gte]");
    if (since !== null) {
      const at = Date.parse(since);
      if (Number.isNaN(at)) return json(400, { sys: { type: "Error", id: "InvalidQuery" } });
      for (let i = all.length - 1; i >= 0; i--)
        if (Date.parse(all[i]?.e.updatedAt ?? "") < at) all.splice(i, 1);
    }
    all.sort((a, b) =>
      a.e.createdAt < b.e.createdAt ? -1 : a.e.createdAt > b.e.createdAt ? 1 : 0,
    );
    const items = all.slice(skip, skip + limit).map(({ t, e }) => {
      const wanted = select.filter((s) => s.startsWith("fields.")).map((s) => s.slice(7));
      const fields = select.length === 0 ? e.fields : {};
      const picked: Record<string, unknown> = { ...fields };
      for (const f of wanted) if (f in e.fields) picked[f] = e.fields[f];
      return { sys: sysOf(e, t.id), fields: picked };
    });
    return json(200, { sys: { type: "Array" }, total: all.length, skip, limit, items });
  };
}
