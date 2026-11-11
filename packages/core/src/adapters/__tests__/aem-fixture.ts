import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Harbourline Hotels' invented Adobe Experience Manager site: a small hotel group whose site a freelancer's agency
 * built on AEM Sites, with room, offer and venue Content Fragments served by persisted GraphQL queries from the
 * publish tier. Nothing here was recorded from a real site, and every address is on a reserved `.example` domain.
 *
 * The shapes are the ones the adapter documents (uncited: Adobe's docs were not reachable when this was written):
 * `GET /graphql/execute.json/<config>/<query>`, a paginated query answering `edges` and `pageInfo`, a list query
 * answering `items`, and `;first=<n>;after=<cursor>` for the next page. A draft is saved in the author tier and is
 * never in an answer of the publish tier, so the fixture holds one that the transport never serves.
 */
export const AEM_SITE = "https://www.harbourline-hotels.example";
export const AEM_HOST = "www.harbourline-hotels.example";
export const AEM_CONFIG_NAME = "harbourline";
export const AEM_ENV = { AEM_PUBLISH_URL: AEM_SITE, AEM_CONFIG: AEM_CONFIG_NAME } as const;

/** Text that is in the client's content, drafts included, and must never reach a report, a log or a hash input. */
export const AEM_MARKERS = {
  harbour: "Harbour view double with a window seat over the quay",
  harbourSummary: "Thirty square metres, breakfast on the terrace included",
  garden: "Garden room with its own door to the herb beds",
  suite: "Winter suite, not announced until the brochure is printed",
  winter: "Three nights for the price of two until the end of February",
  spa: "Spa weekend with a late checkout on Sunday",
  terrace: "The Terrace restaurant, open to non-residents on Fridays",
  cellar: "The Cellar bar and its Thursday jazz evening",
} as const;

export interface FixtureFragment {
  /** The DAM path (`_path`). */
  path: string;
  /** published: served by the publish tier. draft: saved in the author tier only. */
  status: "published" | "draft";
  modified?: string;
  fields: Record<string, unknown>;
}

export interface FixtureQuery {
  /** The persisted query's name. */
  name: string;
  /** paginated: `edges` and `pageInfo`. list: `items` only. */
  form: "paginated" | "list";
  items: FixtureFragment[];
}

const dam = (p: string) => `/content/dam/harbourline/en/${p}`;

export const AEM_CONTENT: FixtureQuery[] = [
  {
    name: "rooms",
    form: "paginated",
    items: [
      {
        path: dam("rooms/harbour-view"),
        status: "published",
        modified: "2026-10-20T08:30:00.000Z",
        fields: { name: AEM_MARKERS.harbour, summary: AEM_MARKERS.harbourSummary, sleeps: 2 },
      },
      // No summary: a field an item lacks is left out of its hashes, never hashed as empty.
      {
        path: dam("rooms/garden"),
        status: "published",
        modified: "2026-11-02T17:00:00.000Z",
        fields: { name: AEM_MARKERS.garden, sleeps: 3 },
      },
      // A draft: saved and not published. The publish tier never holds it.
      {
        path: dam("rooms/winter-suite"),
        status: "draft",
        modified: "2026-11-09T10:00:00.000Z",
        fields: { name: AEM_MARKERS.suite },
      },
    ],
  },
  {
    name: "offers",
    form: "list",
    items: [
      {
        path: dam("offers/winter-stay"),
        status: "published",
        modified: "2026-11-03T12:00:00.000Z",
        fields: { name: AEM_MARKERS.winter },
      },
    ],
  },
  {
    name: "venues",
    form: "paginated",
    items: [
      {
        path: dam("venues/terrace"),
        status: "published",
        modified: "2026-09-01T09:00:00.000Z",
        fields: { name: "Terrace", about: AEM_MARKERS.terrace },
      },
      {
        path: dam("venues/cellar"),
        status: "published",
        modified: "2026-10-10T09:00:00.000Z",
        fields: { name: "Cellar", about: AEM_MARKERS.cellar },
      },
    ],
  },
];

export interface AemFixtureOptions {
  /** Called with every request, to see what was asked. */
  onRequest?: (method: string, url: URL, headers: Record<string, string>) => void;
  /** How many fragments a paginated query answers when it is asked with no `first`. Default 100. */
  firstPage?: number;
  /** A status the publish tier answers for a query instead of its result, by query name (401 for a protected one). */
  refuse?: Readonly<Record<string, number>>;
  /** What the publish tier answers for a query in place of the fixture's, by name: for a hostile or odd answer. */
  override?: (name: string, params: Record<string, string>) => unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const cursorOf = (offset: number) => Buffer.from(`o:${offset}`).toString("base64");
const offsetOf = (cursor: string | undefined): number =>
  cursor === undefined ? 0 : Number(Buffer.from(cursor, "base64").toString().slice(2));

/** The `_metadata` block a query that asks for the modification time returns. */
export const metadataOf = (modified: string | undefined) =>
  modified === undefined
    ? {}
    : { _metadata: { calendarMetadata: [{ name: "cq:lastModified", value: modified }] } };

/** The publish tier over the invented site. Only a GET is answered, and the draft is never served. */
export function aemTransport(
  content: readonly FixtureQuery[] = AEM_CONTENT,
  options: AemFixtureOptions = {},
): Transport {
  return (url, req) => {
    options.onRequest?.(req.method, url, req.headers);
    if (url.host !== AEM_HOST) return json(404, { message: "not here" });
    if (req.method !== "GET") return json(405, { message: "method not allowed" });
    const prefix = `/graphql/execute.json/${AEM_CONFIG_NAME}/`;
    if (!url.pathname.startsWith(prefix)) return json(404, { message: "no such route" });
    const [name = "", ...rest] = url.pathname.slice(prefix.length).split(";");
    const params: Record<string, string> = {};
    for (const part of rest) {
      const at = part.indexOf("=");
      if (at > 0) params[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1));
    }
    const refused = options.refuse?.[name];
    if (refused !== undefined) return json(refused, { message: "no" });
    const odd = options.override?.(name, params);
    if (odd !== undefined) return json(200, odd);
    const query = content.find((q) => q.name === name);
    if (!query) return json(404, { message: "no such persisted query" });
    const live = query.items.filter((i) => i.status === "published");
    const node = (f: FixtureFragment) => ({
      _path: f.path,
      ...metadataOf(f.modified),
      ...f.fields,
    });
    if (query.form === "list")
      return json(200, { data: { [`${name}List`]: { items: live.map(node) } } });
    const size = params.first === undefined ? (options.firstPage ?? 100) : Number(params.first);
    const from = offsetOf(params.after);
    const slice = live.slice(from, from + size);
    const end = from + slice.length;
    return json(200, {
      data: {
        [`${name}Paginated`]: {
          edges: slice.map((f, i) => ({ cursor: cursorOf(from + i + 1), node: node(f) })),
          pageInfo: { hasNextPage: end < live.length, endCursor: cursorOf(end) },
        },
      },
    });
  };
}
