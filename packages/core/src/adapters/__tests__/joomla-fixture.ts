import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Larkspur Yoga Studio's invented Joomla site: a small studio whose site a freelancer built on Joomla 5, with its
 * classes, a teacher page and notices kept as articles. Nothing here was recorded from a real site, and every
 * address is on a reserved `.example` domain. The shapes are the Web Services API's (JSON:API: `data` with `id`
 * and `attributes`, `meta` with `total-pages`), read from Joomla's own source (see docs/integrations/joomla.md).
 */
export const JOOMLA_SITE = "https://larkspur-yoga.example";
export const JOOMLA_HOST = "larkspur-yoga.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const JOOMLA_MARKERS = {
  morning: "Morning flow: slow breathing, then one long sun salutation",
  morningDesc: "Forty minutes, no experience needed, mats provided",
  evening: "Evening stretch for people who sit all day",
  retreat: "Autumn retreat, deposit not yet announced",
  members: "Members' timetable with the door code on it",
  notice: "The studio is closed on the last Friday of November",
  openDay: "Spring open day, details still to come",
  oldTimetable: "Summer timetable, now finished",
  french: "Cours du matin pour les debutants",
} as const;

/** The time the fixture's scheduled and expired articles are judged by. */
export const JOOMLA_NOW = Date.parse("2026-11-11T12:00:00.000Z");

export interface FixtureArticle {
  id: number;
  alias: string;
  title: string;
  /** Joomla's state: 1 published, 0 unpublished, 2 archived, -2 trashed. */
  state: number;
  /** The view level: 1 is Public, 2 Registered. */
  access?: number;
  language?: string;
  metadesc?: string;
  /** Joomla's database time format, UTC. */
  publish_up?: string | null;
  publish_down?: string | null;
  modified: string;
  /** What the list sends as the article's text (the intro and the rest). */
  text?: string;
}

export const JOOMLA_ARTICLES: FixtureArticle[] = [
  {
    id: 1,
    alias: "morning-flow",
    title: JOOMLA_MARKERS.morning,
    state: 1,
    metadesc: JOOMLA_MARKERS.morningDesc,
    publish_up: "2026-10-01 09:00:00",
    modified: "2026-10-20 08:30:00",
    text: JOOMLA_MARKERS.morning,
  },
  // No description: a field an article lacks is left out of its hashes, never hashed as empty.
  {
    id: 2,
    alias: "evening-stretch",
    title: JOOMLA_MARKERS.evening,
    state: 1,
    metadesc: "",
    publish_up: "2026-10-05 09:00:00",
    modified: "2026-11-02 17:00:00",
  },
  // A draft: saved and not published. The Published list never holds it, the default list does.
  {
    id: 3,
    alias: "autumn-retreat",
    title: JOOMLA_MARKERS.retreat,
    state: 0,
    publish_up: null,
    modified: "2026-11-09 10:00:00",
  },
  {
    id: 4,
    alias: "closed-last-friday",
    title: JOOMLA_MARKERS.notice,
    state: 1,
    metadesc: "A notice about the last Friday of November",
    publish_up: "2026-11-03 12:00:00",
    modified: "2026-11-03 12:00:00",
  },
  // Published for Registered users only: a visitor is sent to sign in.
  {
    id: 5,
    alias: "members-timetable",
    title: JOOMLA_MARKERS.members,
    state: 1,
    access: 2,
    publish_up: "2026-09-01 09:00:00",
    modified: "2026-09-01 09:00:00",
  },
  // Published, but its start time has not come.
  {
    id: 6,
    alias: "spring-open-day",
    title: JOOMLA_MARKERS.openDay,
    state: 1,
    publish_up: "2027-03-01 09:00:00",
    modified: "2026-11-10 09:00:00",
  },
  // Published, but its finish time has passed.
  {
    id: 7,
    alias: "summer-timetable",
    title: JOOMLA_MARKERS.oldTimetable,
    state: 1,
    publish_up: "2026-06-01 09:00:00",
    publish_down: "2026-09-01 09:00:00",
    modified: "2026-06-01 09:00:00",
  },
  // Published in French only: its address carries a language prefix.
  {
    id: 8,
    alias: "cours-du-matin",
    title: JOOMLA_MARKERS.french,
    state: 1,
    language: "fr-FR",
    publish_up: "2026-10-12 09:00:00",
    modified: "2026-10-12 09:00:00",
  },
];

export interface JoomlaFixtureOptions {
  /** The API token. A request without it in `X-Joomla-Token` is answered 401 when `protectedApi` is on (the default). */
  token?: string;
  /** The article list route is not public (Joomla's default): a request with no token is answered 401. Default: true. */
  protectedApi?: boolean;
  /** The Web Services plugins are off: every API route answers 404. */
  off?: boolean;
  /** Every path answers 200 with a web page, as a site with a catch-all route does: the API list is not there. */
  catchAll?: boolean;
  /** The token's user is not in a group that may sign in to the API: the list answers 403. */
  denied?: boolean;
  /** The most articles one answer holds, whatever `page[limit]` asks for. */
  maxLimit?: number;
  /** Replace what the list route answers (a hostile or broken server). Called with the parsed query. */
  list?: (q: { state: string | null; offset: number; limit: number }) => unknown;
  /** Paths on the live site that answer 404 (a page that was never built). */
  missingPages?: readonly string[];
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/vnd.api+json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const html = (status: number) =>
  Promise.resolve({
    status,
    headers: { "content-type": "text/html" },
    body: Readable.from([
      Buffer.from(status === 200 ? "<html><title>Page</title></html>" : "gone"),
    ]),
  });

const resource = (a: FixtureArticle) => ({
  type: "articles",
  id: String(a.id),
  attributes: {
    id: a.id,
    typeAlias: "com_content.article",
    title: a.title,
    alias: a.alias,
    text: a.text ?? "",
    language: a.language ?? "*",
    state: a.state,
    access: a.access ?? 1,
    featured: 0,
    metadesc: a.metadesc ?? "",
    metakey: "",
    publish_up: a.publish_up ?? null,
    publish_down: a.publish_down ?? null,
    created: "2026-01-01 09:00:00",
    modified: a.modified,
    hits: 0,
    version: 1,
  },
  relationships: { category: { data: { type: "categories", id: "2" } } },
});

/**
 * The Web Services API over the invented site, and its live pages. The list route answers `filter[state]`,
 * `list[ordering]`, `page[limit]` and `page[offset]`, with `meta.total-pages` (the number of pages, not of
 * articles) and nothing else about the total. Without `filter[state]` it lists published and unpublished articles,
 * as Joomla does, and moves a window past the end to the last page, as Joomla does. It answers 406 to an Accept header that is not the JSON:API type. Nothing but a GET is answered.
 */
export function joomlaTransport(
  content: readonly FixtureArticle[] = JOOMLA_ARTICLES,
  options: JoomlaFixtureOptions = {},
): Transport {
  const pagePaths = new Set(content.filter((a) => a.state === 1).map((a) => `/studio/${a.alias}`));
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== JOOMLA_HOST) return json(404, { errors: [{ title: "not here" }] });
    if (req.method !== "GET") return json(405, { errors: [{ title: "method not allowed" }] });
    if (url.pathname === "/api/index.php/v1/content/articles") {
      if (options.off === true) return html(404);
      if (options.catchAll === true) return html(200);
      const token = req.headers["x-joomla-token"];
      const hasToken = options.token !== undefined && token === options.token;
      if (!(req.headers.accept ?? "").includes("application/vnd.api+json"))
        return json(406, { errors: [{ title: "Could not match accept header" }] });
      if ((options.protectedApi ?? true) && !hasToken)
        return json(401, { errors: [{ code: 401, title: "Forbidden" }] });
      if (hasToken && options.denied === true)
        return json(403, { errors: [{ code: 403, title: "Forbidden" }] });
      const state = url.searchParams.get("filter[state]");
      const offset = Number(url.searchParams.get("page[offset]") ?? "0");
      const asked = Number(url.searchParams.get("page[limit]") ?? "20");
      if (options.list) return json(200, options.list({ state, offset, limit: asked }));
      const limit = Math.min(asked, options.maxLimit ?? asked);
      const listed = content
        .filter((a) =>
          state === null ? a.state === 0 || a.state === 1 : a.state === Number(state),
        )
        .sort((a, b) => a.id - b.id);
      if (offset > listed.length) return json(404, { errors: [{ title: "Resource not found" }] });
      // Joomla moves a window that starts past the last full page to the last page's own start (ListModel::getStart).
      const start =
        offset > 0 && offset > listed.length - limit
          ? Math.max(0, (Math.ceil(listed.length / limit) - 1) * limit)
          : offset;
      return json(200, {
        links: { self: url.href },
        data: listed.slice(start, start + limit).map(resource),
        meta: { "total-pages": Math.ceil(listed.length / limit) },
      });
    }
    // The live site: a page the content gives an address for answers, unless it is listed as missing.
    if ((options.missingPages ?? []).includes(url.pathname)) return html(404);
    if (pagePaths.has(url.pathname) || url.pathname === "/") return html(200);
    return html(404);
  };
}
