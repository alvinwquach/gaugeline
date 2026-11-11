import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Fernlight Architects' invented Craft CMS install: a small architecture studio whose site a freelancer built on
 * Craft, with two sites on one install: `studio` (English, fernlight-studio.example) and `atelier` (French,
 * fernlight-atelier.example). Nothing here was recorded from a real site: the answers are in the shape of Craft's
 * documented GraphQL API (entries, entryCount, EntryInterface fields, `<entryTypeHandle>_Entry` fragments), with
 * invented values on reserved `.example` domains.
 */
export const STUDIO_SITE = "https://fernlight-studio.example";
export const ATELIER_SITE = "https://fernlight-atelier.example";
export const CRAFT_ENDPOINT = "https://cms.fernlight.example/api";
export const CRAFT_HOST = "cms.fernlight.example";

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const CRAFT_MARKERS = {
  library: "Harbour Library: a reading room that follows the tide line",
  librarySummary: "Timber frame, reclaimed brick, a long north-facing window",
  bibliotheque: "Bibliotheque du port: une salle de lecture au fil de la maree",
  baths: "Tidal Baths: a swimming hall cut into the sea wall",
  mill: "Mill conversion, client not yet announced",
  visit: "Site visit notes from the first cold morning on the quay",
  shortlist: "Award shortlist: we cannot say which one yet",
  ana: "Ana leads the library project and the autumn open day",
  ben: "Ben joined in October and draws all the stair details",
} as const;

export interface FixtureEntry {
  /** The element id, shared by every site the entry exists in. */
  id: string;
  section: string;
  siteHandle: "studio" | "atelier";
  /** The GraphQL type of the entry: `<entryTypeHandle>_Entry`. */
  typeName: string;
  slug: string;
  /** Craft's uri, with no leading slash; null for an entry with no page. */
  uri: string | null;
  /** The status Craft gives the entry on this site. Only "live" is published. */
  status: "live" | "pending" | "expired" | "disabled";
  dateUpdated: string;
  postDate: string | null;
  fields: Record<string, unknown>;
}

const entry = (e: FixtureEntry): FixtureEntry => e;

export const CRAFT_CONTENT: FixtureEntry[] = [
  entry({
    id: "101",
    section: "projects",
    siteHandle: "studio",
    typeName: "project_Entry",
    slug: "harbour-library",
    uri: "projects/harbour-library",
    status: "live",
    dateUpdated: "2026-10-20T08:30:00-07:00",
    postDate: "2026-10-01T09:00:00-07:00",
    fields: { title: CRAFT_MARKERS.library, summary: CRAFT_MARKERS.librarySummary },
  }),
  // The same entry on the French site: it has no summary, which the others have.
  entry({
    id: "101",
    section: "projects",
    siteHandle: "atelier",
    typeName: "project_Entry",
    slug: "bibliotheque-du-port",
    uri: "projets/bibliotheque-du-port",
    status: "live",
    dateUpdated: "2026-10-21T08:30:00-07:00",
    postDate: "2026-10-01T09:00:00-07:00",
    fields: { title: CRAFT_MARKERS.bibliotheque },
  }),
  // Enabled on the English site, switched off for the French one.
  entry({
    id: "102",
    section: "projects",
    siteHandle: "studio",
    typeName: "project_Entry",
    slug: "tidal-baths",
    uri: "projects/tidal-baths",
    status: "live",
    dateUpdated: "2026-11-02T17:00:00-07:00",
    postDate: "2026-10-05T09:00:00-07:00",
    fields: { title: CRAFT_MARKERS.baths, summary: null },
  }),
  entry({
    id: "102",
    section: "projects",
    siteHandle: "atelier",
    typeName: "project_Entry",
    slug: "bains-de-maree",
    uri: "projets/bains-de-maree",
    status: "disabled",
    dateUpdated: "2026-11-02T17:00:00-07:00",
    postDate: "2026-10-05T09:00:00-07:00",
    fields: { title: CRAFT_MARKERS.baths },
  }),
  // A draft: saved and not enabled. The live list never holds it.
  entry({
    id: "103",
    section: "projects",
    siteHandle: "studio",
    typeName: "project_Entry",
    slug: "mill-conversion",
    uri: "projects/mill-conversion",
    status: "disabled",
    dateUpdated: "2026-11-09T10:00:00-07:00",
    postDate: null,
    fields: { title: CRAFT_MARKERS.mill },
  }),
  entry({
    id: "201",
    section: "journal",
    siteHandle: "studio",
    typeName: "journalPost_Entry",
    slug: "site-visit-notes",
    uri: "journal/site-visit-notes",
    status: "live",
    dateUpdated: "2026-11-03T12:00:00-07:00",
    postDate: "2026-11-03T12:00:00-07:00",
    fields: { title: CRAFT_MARKERS.visit },
  }),
  entry({
    id: "202",
    section: "journal",
    siteHandle: "studio",
    typeName: "journalPost_Entry",
    slug: "award-shortlist",
    uri: "journal/award-shortlist",
    status: "live",
    dateUpdated: "2026-11-04T12:00:00-07:00",
    postDate: "2026-11-04T12:00:00-07:00",
    fields: { title: CRAFT_MARKERS.shortlist },
  }),
  entry({
    id: "301",
    section: "team",
    siteHandle: "studio",
    typeName: "teamMember_Entry",
    slug: "ana",
    uri: "team/ana",
    status: "live",
    dateUpdated: "2026-09-01T09:00:00-07:00",
    postDate: "2026-06-01T09:00:00-07:00",
    fields: { title: "Ana", bio: CRAFT_MARKERS.ana },
  }),
  entry({
    id: "302",
    section: "team",
    siteHandle: "studio",
    typeName: "teamMember_Entry",
    slug: "ben",
    uri: "team/ben",
    status: "live",
    dateUpdated: "2026-10-10T09:00:00-07:00",
    postDate: "2026-10-10T09:00:00-07:00",
    fields: { title: "Ben", bio: CRAFT_MARKERS.ben },
  }),
];

/** The sites of the install, and where each lives. */
export const CRAFT_SITES = {
  studio: STUDIO_SITE,
  atelier: ATELIER_SITE,
} as const;

export interface CraftFixtureOptions {
  /** When set, a request without `Authorization: Bearer <token>` is answered 400, as Craft answers an invalid token. */
  token?: string;
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
  /** The schema allows mutations (a token with write scope): introspection shows a mutation type. */
  mutationType?: boolean;
  /** Introspection is not answered (a GraphQL error), as on an install that has turned it off. */
  noIntrospection?: boolean;
  /** Answer at most this many entries a page, whatever `limit` asks (a clamping server). */
  clamp?: number;
  /** The count `entryCount` reports, whatever the entries are (a server that lies about its size). */
  claimTotal?: number;
  /** Answer the same first page for every offset (a server that never moves on). */
  samePage?: boolean;
  /** Sections the schema does not include: asking for them is a GraphQL error. */
  forbidden?: readonly string[];
  /** Replace what a node holds, by entry id and site, for tests that need odd values (a hostile uri). */
  patch?: (node: Record<string, unknown>, e: FixtureEntry) => Record<string, unknown>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const STATUS_ORDER = ["live", "pending", "expired", "disabled"] as const;

/**
 * Craft's GraphQL endpoint over the invented install. It answers GET only, with the document in the `query`
 * parameter (Craft's documented GET form: no variables, so values are written into the document). It understands
 * the one shape the adapter builds: `entryCount(...)` and `entries(...)` with section, site, status, orderBy,
 * limit and offset, the EntryInterface fields, and `fN: field` aliases (inside `... on T_Entry { }` for custom ones).
 */
export function craftTransport(
  content: readonly FixtureEntry[] = CRAFT_CONTENT,
  options: CraftFixtureOptions = {},
): Transport {
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== CRAFT_HOST) return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(400, { message: "Invalid authorization token" });
    if (url.pathname !== "/api") return json(404, { message: "no such route" });
    const query = url.searchParams.get("query") ?? "";
    if (/^\s*mutation\b/i.test(query)) return json(400, { message: "no mutations here" });
    if (query.includes("__schema")) {
      if (options.noIntrospection)
        return json(200, { errors: [{ message: "introspection is off" }] });
      return json(200, {
        data: { __schema: { mutationType: options.mutationType ? { name: "Mutation" } : null } },
      });
    }
    const section = /section: "([A-Za-z0-9_]+)"/.exec(query)?.[1];
    if (section === undefined) return json(200, { errors: [{ message: "unknown query" }] });
    if (options.forbidden?.includes(section))
      return json(200, { errors: [{ message: "Cannot query field entries" }] });
    const statuses = [
      ...(/status: \[([^\]]*)\]/.exec(query)?.[1] ?? '"live"').matchAll(/"(\w+)"/g),
    ].map((m) => m[1]);
    for (const s of statuses)
      if (!STATUS_ORDER.includes(s as (typeof STATUS_ORDER)[number]))
        return json(200, { errors: [{ message: "bad status" }] });
    const sitePart = /site: "([^"]*)"/.exec(query)?.[1] ?? "studio";
    const rows = content.filter(
      (e) =>
        e.section === section &&
        statuses.includes(e.status) &&
        (sitePart === "*" || e.siteHandle === sitePart),
    );
    const data: Record<string, unknown> = {};
    if (/entryCount\(/.test(query)) data.total = options.claimTotal ?? rows.length;
    if (/entries\(/.test(query)) {
      const limit = Number(/limit: (\d+)/.exec(query)?.[1] ?? "100");
      const offset = Number(/offset: (\d+)/.exec(query)?.[1] ?? "0");
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        return json(200, { errors: [{ message: "limit must be 1 to 1000" }] });
      const size = Math.min(limit, options.clamp ?? limit);
      const page = options.samePage ? rows.slice(0, size) : rows.slice(offset, offset + size);
      const aliases = [...query.matchAll(/(f\d+): (?:(\w+))/g)].map((m) => ({
        alias: m[1] ?? "",
        field: m[2] ?? "",
      }));
      const fragments = [...query.matchAll(/\.\.\. on (\w+) \{([^}]*)\}/g)].map((m) => ({
        type: m[1] ?? "",
        body: m[2] ?? "",
      }));
      data.nodes = page.map((e) => {
        let node: Record<string, unknown> = {
          id: e.id,
          slug: e.slug,
          uri: e.uri,
          url:
            e.uri === null
              ? null
              : `${e.siteHandle === "studio" ? STUDIO_SITE : ATELIER_SITE}/${e.uri}`,
          siteHandle: e.siteHandle,
          status: e.status,
          dateUpdated: e.dateUpdated,
          postDate: e.postDate,
        };
        for (const { alias, field } of aliases) {
          const inFragment = fragments.find((f) => f.body.includes(`${alias}: ${field}`));
          if (inFragment !== undefined && inFragment.type !== e.typeName) continue;
          node[alias] = e.fields[field] ?? null;
        }
        if (options.patch) node = options.patch(node, e);
        return node;
      });
    }
    return json(200, { data });
  };
}
