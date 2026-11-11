// check-community: allow-email (invented addresses at reserved example domains, for the members fixture)
import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * The Copper Lantern's invented WordPress site: a cocktail bar whose freelancer built it with Elementor pages,
 * a handful of news posts and an events type. Nothing here was recorded from a real site: the answers are
 * written by hand in the shape of the REST API's documented responses (a JSON list, `{ rendered }` wrappers,
 * `X-WP-Total` and `X-WP-TotalPages` headers, `*_gmt` times with no zone), and `_fields` is honoured, so the
 * adapter only ever sees what it asked for.
 */
export const CONTENT_MARKERS = {
  autumn: "Autumn cocktail list is here",
  happyHour: "Happy hour moves to five",
  hire: "Hiring the back room for a party",
  home: "Where the lantern burns late",
  book: "Book a table for the weekend",
  contact: "Find us under the copper sign",
  jazz: "Jazz on the last Friday",
  draftOnly: "Winter menu, not announced yet",
  draftPage: "Christmas party packages, draft",
  privateNote: "Staff rota notes, private",
} as const;

export interface Item {
  id: number;
  type: string;
  status: string;
  slug: string;
  link: string;
  date_gmt: string;
  modified_gmt: string;
  title: { rendered: string };
  excerpt?: { rendered: string };
  content?: { rendered: string };
  featured_media?: number;
}

const HOST = "https://copper-lantern.example";

const elementor = (text: string): string =>
  `<div data-elementor-type="wp-page" class="elementor"><section class="elementor-section"><h2 class="elementor-heading-title">${text}</h2></section></div>`;

export const COPPER_LANTERN: Item[] = [
  {
    id: 11,
    type: "post",
    status: "publish",
    slug: "autumn-cocktails",
    link: `${HOST}/news/autumn-cocktails/`,
    date_gmt: "2026-11-01T08:00:00",
    modified_gmt: "2026-11-03T14:30:00",
    title: { rendered: CONTENT_MARKERS.autumn },
    excerpt: { rendered: "<p>Seven new drinks.</p>" },
    content: { rendered: "<p>Full list inside.</p>" },
  },
  {
    id: 12,
    type: "post",
    status: "publish",
    slug: "happy-hour",
    link: `${HOST}/news/happy-hour/`,
    date_gmt: "2026-09-01T08:00:00",
    modified_gmt: "2026-10-20T09:00:00",
    title: { rendered: CONTENT_MARKERS.happyHour },
    excerpt: { rendered: "" },
    content: { rendered: "<p>From Monday.</p>" },
  },
  {
    id: 13,
    type: "post",
    status: "publish",
    slug: "private-hire",
    link: `${HOST}/news/private-hire/`,
    date_gmt: "2026-06-01T08:00:00",
    modified_gmt: "2026-08-12T10:00:00",
    title: { rendered: CONTENT_MARKERS.hire },
    excerpt: { rendered: "<p>Up to forty guests.</p>" },
    content: { rendered: "<p>Ask at the bar.</p>" },
  },
  {
    id: 14,
    type: "post",
    status: "draft",
    slug: "winter-menu",
    link: `${HOST}/?p=14`,
    date_gmt: "0000-00-00T00:00:00",
    modified_gmt: "2026-11-06T09:00:00",
    title: { rendered: CONTENT_MARKERS.draftOnly },
  },
  {
    id: 15,
    type: "post",
    status: "private",
    slug: "rota",
    link: `${HOST}/news/rota/`,
    date_gmt: "2026-10-01T08:00:00",
    modified_gmt: "2026-10-02T08:00:00",
    title: { rendered: CONTENT_MARKERS.privateNote },
  },
  {
    id: 21,
    type: "page",
    status: "publish",
    slug: "home",
    link: `${HOST}/`,
    date_gmt: "2026-01-10T08:00:00",
    modified_gmt: "2026-10-30T11:00:00",
    title: { rendered: "Home" },
    excerpt: { rendered: "<p>Open until late.</p>" },
    content: { rendered: elementor(CONTENT_MARKERS.home) },
    featured_media: 0,
  },
  {
    id: 22,
    type: "page",
    status: "publish",
    slug: "book",
    link: `${HOST}/book/`,
    date_gmt: "2026-01-10T08:05:00",
    modified_gmt: "2026-09-18T11:00:00",
    title: { rendered: CONTENT_MARKERS.book },
    excerpt: { rendered: "<p>Tables for two to eight.</p>" },
    content: { rendered: elementor("Book") },
  },
  {
    id: 23,
    type: "page",
    status: "publish",
    slug: "contact",
    link: `${HOST}/contact/`,
    date_gmt: "2026-01-10T08:10:00",
    modified_gmt: "2026-07-02T11:00:00",
    title: { rendered: CONTENT_MARKERS.contact },
    content: { rendered: elementor("Contact") },
  },
  {
    id: 24,
    type: "page",
    status: "draft",
    slug: "christmas",
    link: `${HOST}/?page_id=24`,
    date_gmt: "0000-00-00T00:00:00",
    modified_gmt: "2026-11-07T09:00:00",
    title: { rendered: CONTENT_MARKERS.draftPage },
  },
  {
    id: 31,
    type: "event",
    status: "publish",
    slug: "jazz-night",
    link: `${HOST}/events/jazz-night/`,
    date_gmt: "2026-10-05T08:00:00",
    modified_gmt: "2026-10-05T08:00:00",
    title: { rendered: CONTENT_MARKERS.jazz },
  },
  {
    id: 32,
    type: "event",
    status: "publish",
    slug: "quiz-night",
    link: `${HOST}/events/quiz-night/`,
    date_gmt: "2026-10-06T08:00:00",
    modified_gmt: "2026-10-06T08:00:00",
    title: { rendered: "Quiz night" },
  },
];

/** What /wp-json/wp/v2/types lists: content, and the machinery the adapter leaves out. */
const TYPES = {
  post: { slug: "post", rest_base: "posts", rest_namespace: "wp/v2" },
  page: { slug: "page", rest_base: "pages", rest_namespace: "wp/v2" },
  event: { slug: "event", rest_base: "events", rest_namespace: "wp/v2" },
  attachment: { slug: "attachment", rest_base: "media", rest_namespace: "wp/v2" },
  wp_block: { slug: "wp_block", rest_base: "blocks", rest_namespace: "wp/v2" },
  booking: { slug: "booking", rest_base: "bookings", rest_namespace: "easy-booking/v1" },
};

const COLLECTIONS: Record<string, string> = { posts: "post", pages: "page", events: "event" };

export interface WordPressFixtureOptions {
  /** The application password's user and value: drafts and users need them. */
  app?: { user: string; password: string };
  /** The role of that user. Default administrator. */
  role?: "administrator" | "editor" | "contributor" | "subscriber";
  /** The REST API is off: every route answers 404, as with a plugin that disables it. */
  restOff?: boolean;
  /** A security plugin refuses visitors with no login (401 on every route). */
  visitorsRefused?: boolean;
  /** The users list is open to visitors (the default of a WordPress with no hardening). */
  usersPublic?: boolean;
  /** Where the site is installed, "" or "/blog". */
  root?: string;
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const REFUSED_STATUS = {
  code: "rest_forbidden_status",
  message: "Status is forbidden.",
  data: { status: 401 },
};

/** The WordPress REST API over the invented items. Only GET is answered; anything else would be a 405. */
export function wordpressTransport(
  content: Item[] = COPPER_LANTERN,
  options: WordPressFixtureOptions = {},
): Transport {
  const role = options.role ?? "administrator";
  const expected = options.app
    ? `Basic ${Buffer.from(`${options.app.user}:${options.app.password}`).toString("base64")}`
    : undefined;
  const root = options.root ?? "";
  return async (url, req) => {
    if (req.method !== "GET") return respond(405, { code: "rest_no_route" });
    const prefix = `${root}/wp-json/wp/v2/`;
    if (options.restOff || !url.pathname.startsWith(prefix))
      return respond(404, {
        code: "rest_no_route",
        message: "No route was found matching the URL.",
      });
    const route = url.pathname.slice(prefix.length);
    const authed = expected !== undefined && req.headers.authorization === expected;
    const asked = url.searchParams;
    if (options.visitorsRefused && !authed)
      return respond(401, { code: "rest_cannot_access", message: "Only authenticated users." });
    if (req.headers.authorization !== undefined && !authed)
      return respond(401, { code: "incorrect_password", message: "The password is incorrect." });

    if (route === "types") return respond(200, TYPES);

    if (route === "users") {
      if (options.usersPublic && !authed) {
        const list = [{ id: 1 }, { id: 2 }];
        return respond(200, list, { "x-wp-total": "2", "x-wp-totalpages": "1" });
      }
      if (!authed) return respond(401, { code: "rest_user_cannot_view" });
      if (role !== "administrator")
        return respond(403, { code: "rest_user_cannot_view", data: { status: 403 } });
      const users = [
        { id: 1, email: "Rosa.Ferrer@copper-lantern.example", roles: ["administrator"] },
        { id: 2, email: "dev@freelancer.example", roles: ["editor"] },
        { id: 3, email: "", roles: ["subscriber"] },
      ];
      return respond(200, users, { "x-wp-total": String(users.length), "x-wp-totalpages": "1" });
    }

    if (route === "plugins" || route === "themes") {
      if (!authed) return respond(401, { code: "rest_cannot_view_plugins" });
      if (role !== "administrator") return respond(403, { code: "rest_cannot_view_plugins" });
      return respond(
        200,
        route === "plugins"
          ? [
              { plugin: "easy-booking/easy-booking", status: "active", version: "2.1.3" },
              { plugin: "gallery-lite/gallery-lite", status: "inactive", version: "1.0.0" },
              { plugin: "elementor/elementor", status: "active", version: "3.19.0" },
              { plugin: "hello", status: "active", version: "1.7.2" },
            ]
          : [
              {
                stylesheet: "harbour-child",
                status: "active",
                version: { raw: "1.0.4", rendered: "1.0.4" },
              },
            ],
      );
    }

    const type = COLLECTIONS[route];
    if (type === undefined) return respond(404, { code: "rest_no_route" });

    const statuses = (asked.get("status") ?? "publish").split(",");
    const isPublic = statuses.every((s) => s === "publish");
    if (!isPublic) {
      if (!authed) return respond(401, REFUSED_STATUS);
      // A subscriber may list nothing unpublished; a contributor may list posts and not pages.
      if (role === "subscriber" || (role === "contributor" && type !== "post"))
        return respond(403, { code: "rest_forbidden_status", data: { status: 403 } });
    }
    let rows = content.filter((i) => i.type === type && statuses.includes(i.status));
    const after = asked.get("modified_after");
    if (after !== null) rows = rows.filter((i) => `${i.modified_gmt}Z` > after);
    rows = [...rows].sort((a, b) => a.id - b.id);
    const perPage = Number(asked.get("per_page") ?? "10");
    const page = Number(asked.get("page") ?? "1");
    const pages = Math.max(1, Math.ceil(rows.length / perPage));
    if (page > pages) return respond(400, { code: "rest_post_invalid_page_number" });
    const fields = (asked.get("_fields") ?? "").split(",").filter(Boolean);
    const slice = rows.slice((page - 1) * perPage, page * perPage).map((i) => {
      if (fields.length === 0) return i;
      const all = i as unknown as Record<string, unknown>;
      return Object.fromEntries(fields.filter((f) => f in all).map((f) => [f, all[f]]));
    });
    return respond(200, slice, {
      "x-wp-total": String(rows.length),
      "x-wp-totalpages": String(pages),
    });
  };
}
