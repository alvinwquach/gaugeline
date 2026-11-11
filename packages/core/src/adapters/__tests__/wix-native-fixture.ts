import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";

/**
 * Marlow Coaching's invented Wix Data collections: a one-person career-coaching practice whose freelancer built
 * the site on Wix, with a Programs collection (one dynamic page for each program) and a Testimonials collection.
 * Nothing here was recorded from Wix: the answers are in the shape of Query Data Items as the build knew it
 * (the platform's pages could not be reached, see docs/integrations/wix.md), so they are uncited. The text in
 * the items (titles, blurbs, quotes) is what an adapter must never return.
 */
export const MARLOW_SITE_ID = "6b1f0c2e-3d4a-4e5f-9a8b-7c6d5e4f3a2b";

export const WIX_NATIVE_MARKERS = {
  spring: "Spring cohort, twelve weeks, for people who quit on Friday",
  springBlurb: "Six places, a call every Thursday, a plan by week four",
  oneToOne: "One to one, a single session to decide what to do next",
  summer: "Summer intensive, not announced yet",
  quote: "I had a plan by week four and a new job by week nine",
  author: "A client who asked not to be named",
} as const;

export interface WixItem {
  id: string;
  data: Record<string, unknown>;
}

const at = (iso: string) => ({ $date: iso });

export const MARLOW_COLLECTIONS: Record<string, WixItem[]> = {
  Programs: [
    {
      id: "prog-spring-cohort",
      data: {
        _id: "prog-spring-cohort",
        _updatedDate: at("2026-11-09T07:30:00.000Z"),
        title: WIX_NATIVE_MARKERS.spring,
        slug: "spring-cohort",
        blurb: WIX_NATIVE_MARKERS.springBlurb,
      },
    },
    {
      id: "prog-one-to-one",
      data: {
        _id: "prog-one-to-one",
        _updatedDate: at("2026-10-28T10:00:00.000Z"),
        title: WIX_NATIVE_MARKERS.oneToOne,
        slug: "one-to-one",
      },
    },
    {
      id: "prog-summer-intensive",
      data: {
        _id: "prog-summer-intensive",
        _updatedDate: at("2026-08-02T09:00:00.000Z"),
        title: WIX_NATIVE_MARKERS.summer,
        slug: "summer-intensive",
        blurb: "",
      },
    },
  ],
  Testimonials: [
    {
      id: "quote-1",
      data: {
        _id: "quote-1",
        _updatedDate: at("2026-09-01T09:00:00.000Z"),
        quote: WIX_NATIVE_MARKERS.quote,
        author: WIX_NATIVE_MARKERS.author,
      },
    },
    {
      id: "quote-2",
      data: {
        _id: "quote-2",
        _updatedDate: at("2026-10-05T09:00:00.000Z"),
        quote: WIX_NATIVE_MARKERS.quote,
      },
    },
  ],
};

/** What the server was asked, for a test's `handler` to decide on. */
export interface WixCall {
  collection: string;
  /** The offset the cursor stands for (0 on the first page), or undefined when the cursor is not one this server made. */
  offset: number | undefined;
  cursor: string | undefined;
  limit: number;
  /** The projection sent on the first page. */
  fields: string[] | undefined;
  /** 0-based order of the queries this transport has answered. */
  n: number;
}

export interface WixReply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface WixTransportOptions {
  /** The API key the server accepts, as the whole Authorization header value. */
  key: string;
  siteId?: string;
  collections?: Record<string, WixItem[]>;
  /** The most items the server gives in one answer, whatever limit was asked. */
  serverMax?: number;
  /** Collections the key may not read: 403. */
  deny?: readonly string[];
  /** Replace the answer to one call (a 429, a broken list, a repeated cursor): return undefined to answer as usual. */
  handler?: (call: WixCall) => WixReply | undefined;
}

const cursorFor = (offset: number): string => Buffer.from(`offset:${offset}`).toString("base64url");
const offsetOf = (cursor: string): number | undefined => {
  const m = /^offset:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? Number(m[1]) : undefined;
};

const json = (r: WixReply) => ({
  status: r.status,
  headers: { "content-type": "application/json", ...(r.headers ?? {}) },
  body: Readable.from([Buffer.from(JSON.stringify(r.body ?? {}))]),
});

/**
 * Wix Data as the invented site's CMS: `POST www.wixapis.com/wix-data/v2/items/query`, answered from memory, with
 * a key that is the whole Authorization header value and the site's id in `wix-site-id`. Anything else is a 404.
 * It pages by cursor: each answer carries `pagingMetadata.cursors.next` and `hasNext`, and the last carries
 * neither a cursor nor `hasNext: true`.
 */
export function wixTransport(options: WixTransportOptions): Transport {
  const collections = options.collections ?? MARLOW_COLLECTIONS;
  let n = 0;
  return (url, req) => {
    if (url.host !== "www.wixapis.com" || url.pathname !== "/wix-data/v2/items/query")
      return Promise.resolve(json({ status: 404, body: { message: "not found" } }));
    if (req.method !== "POST") return Promise.resolve(json({ status: 405 }));
    if (
      req.headers.authorization !== options.key ||
      req.headers["wix-site-id"] !== (options.siteId ?? MARLOW_SITE_ID)
    )
      return Promise.resolve(json({ status: 401, body: { message: "unauthorized" } }));
    const body = JSON.parse(req.body ?? "{}") as {
      dataCollectionId?: string;
      query?: { cursorPaging?: { limit?: number; cursor?: string }; fields?: string[] };
    };
    const collection = body.dataCollectionId ?? "";
    const paging = body.query?.cursorPaging ?? {};
    const cursor = paging.cursor;
    const offset = cursor === undefined ? 0 : offsetOf(cursor);
    const limit = paging.limit ?? 50;
    const call: WixCall = {
      collection,
      offset,
      cursor,
      limit,
      fields: body.query?.fields,
      n: n++,
    };
    const custom = options.handler?.(call);
    if (custom !== undefined) return Promise.resolve(json(custom));
    if (options.deny?.includes(collection))
      return Promise.resolve(
        json({ status: 403, body: { message: "PERMISSION_DENIED", details: collection } }),
      );
    const items = collections[collection];
    if (items === undefined || offset === undefined)
      return Promise.resolve(json({ status: 404, body: { message: "WDE0025" } }));
    const size = Math.min(limit, options.serverMax ?? 1000);
    const page = items.slice(offset, offset + size);
    const end = offset + page.length;
    const more = end < items.length;
    return Promise.resolve(
      json({
        status: 200,
        body: {
          dataItems: page.map((i) => ({ id: i.id, dataCollectionId: collection, data: i.data })),
          pagingMetadata: {
            count: page.length,
            cursors: more ? { next: cursorFor(end) } : {},
            hasNext: more,
          },
        },
      }),
    );
  };
}

export { cursorFor };
