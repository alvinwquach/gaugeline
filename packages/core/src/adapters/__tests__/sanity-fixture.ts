import { Readable } from "node:stream";
import { evaluate, parse } from "groq-js";
import type { Transport } from "../../fetcher.js";

/**
 * Fernhill Coaching's invented Sanity dataset: a solo coach's site built by a freelancer. Nothing here
 * was recorded from a real dataset; the answers come from running the query the adapter sent over
 * these documents with groq-js, in the shape of Sanity's query API (`{ ms, query, result }`), so a
 * query that is not valid GROQ is answered 400 the way Sanity would.
 */
export const CONTENT_MARKERS = {
  welcome: "Finding your next step with a coach",
  spring: "Spring cohort now open",
  faq: "Questions people ask before booking",
  quote: "I finally stopped dreading Mondays",
  draftOnly: "Autumn prices, not announced yet",
  draftEdit: "Spring cohort now open (edit in progress)",
} as const;

export const FERNHILL: Record<string, unknown>[] = [
  {
    _id: "post-welcome",
    _type: "post",
    _updatedAt: "2026-10-20T09:00:00Z",
    publishedAt: "2026-09-01T08:00:00Z",
    slug: { current: "finding-your-next-step" },
    title: CONTENT_MARKERS.welcome,
    summary: "A short note on how sessions work.",
  },
  {
    _id: "post-spring",
    _type: "post",
    _updatedAt: "2026-11-03T14:30:00Z",
    publishedAt: "2026-11-01T08:00:00Z",
    slug: { current: "spring-cohort" },
    title: CONTENT_MARKERS.spring,
  },
  {
    _id: "post-faq",
    _type: "post",
    _updatedAt: "2026-08-12T10:00:00Z",
    slug: { current: "faq" },
    title: CONTENT_MARKERS.faq,
    summary: "Cancellations, rescheduling and what to bring.",
  },
  {
    _id: "package-one-to-one",
    _type: "package",
    _updatedAt: "2026-09-15T12:00:00Z",
    name: "One-to-one",
    slug: { current: "one-to-one" },
  },
  {
    _id: "package-group",
    _type: "package",
    _updatedAt: "2026-09-15T12:05:00Z",
    name: "Group programme",
    slug: { current: "group-programme" },
  },
  {
    _id: "testimonial-1",
    _type: "testimonial",
    _updatedAt: "2026-07-01T09:00:00Z",
    quote: CONTENT_MARKERS.quote,
    author: "A past client",
  },
  {
    _id: "testimonial-2",
    _type: "testimonial",
    _updatedAt: "2026-07-02T09:00:00Z",
    quote: "Worth every session",
    author: "Another client",
  },
  // Unpublished work: only a token that can read drafts sees these, and published queries never do.
  {
    _id: "drafts.post-spring",
    _type: "post",
    _updatedAt: "2026-11-05T09:00:00Z",
    title: CONTENT_MARKERS.draftEdit,
  },
  {
    _id: "drafts.post-autumn",
    _type: "post",
    _updatedAt: "2026-11-06T09:00:00Z",
    title: CONTENT_MARKERS.draftOnly,
  },
];

export interface SanityFixtureOptions {
  /** A private dataset: 401 unless the request carries this token. */
  token?: string;
}

const json = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** Sanity's query endpoint over the invented documents: the published perspective leaves drafts out. */
export function sanityTransport(
  content: Record<string, unknown>[] = FERNHILL,
  options: SanityFixtureOptions = {},
): Transport {
  return async (url, req) => {
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`)
      return json(401, { error: { description: "Unauthorized", type: "corsOriginError" } });
    const query = url.searchParams.get("query") ?? "";
    const published = url.searchParams.get("perspective") === "published";
    const dataset = content.filter((d) => !(published && String(d._id).startsWith("drafts.")));
    try {
      const result = await (await evaluate(parse(query), { dataset })).get();
      return await json(200, { ms: 3, query, result });
    } catch {
      return json(400, { error: { description: "unsupported query", type: "queryParseError" } });
    }
  };
}
