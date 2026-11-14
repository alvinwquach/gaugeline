import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import type { TransportResponse } from "../../transport.js";

/**
 * The invented world the PageSpeed tests run in. Nothing here touches a network and nothing is a real
 * measurement. The answers are written by hand in the shape of Google's published reference for the
 * PageSpeed Insights API (the discovery document at pagespeedonline.googleapis.com), because the shared quota
 * of the keyless API was used up when a real answer was asked for (HTTP 429), so none was recorded.
 */

export type Shares = readonly [good: number, middle: number, poor: number];

/** A metric as `loadingExperience.metrics` writes it: three buckets that add up to 1. */
export function metric(shares: Shares, edges: readonly [number, number], percentile = 0) {
  return {
    percentile,
    distributions: [
      { min: 0, max: edges[0], proportion: shares[0] },
      { min: edges[0], max: edges[1], proportion: shares[1] },
      { min: edges[1], proportion: shares[2] },
    ],
    category: "AVERAGE",
  };
}

export interface FieldShares {
  lcp?: Shares;
  inp?: Shares;
  /** The score is scaled by 100 in the bucket edges (10 and 25 for 0.1 and 0.25). */
  cls?: Shares;
}

export function experience(id: string, shares: FieldShares, over: Record<string, unknown> = {}) {
  const metrics: Record<string, unknown> = {};
  if (shares.lcp) metrics.LARGEST_CONTENTFUL_PAINT_MS = metric(shares.lcp, [2500, 4000]);
  if (shares.inp) metrics.INTERACTION_TO_NEXT_PAINT = metric(shares.inp, [200, 500]);
  if (shares.cls) metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE = metric(shares.cls, [10, 25]);
  return { id, initial_url: id, metrics, overall_category: "AVERAGE", ...over };
}

export interface LabNumbers {
  score: number | null;
  lcp?: number;
  tbt?: number;
  cls?: number;
  si?: number;
  fcp?: number;
}

export function lighthouse(lab: LabNumbers, over: Record<string, unknown> = {}) {
  const audit = (id: string, numericValue: number | undefined) =>
    numericValue === undefined ? {} : { [id]: { id, numericValue, score: 0.5 } };
  return {
    lighthouseVersion: "13.0.0",
    configSettings: { formFactor: "mobile" },
    categories: { performance: { id: "performance", score: lab.score } },
    audits: {
      ...audit("largest-contentful-paint", lab.lcp),
      ...audit("total-blocking-time", lab.tbt),
      ...audit("cumulative-layout-shift", lab.cls),
      ...audit("speed-index", lab.si),
      ...audit("first-contentful-paint", lab.fcp),
    },
    ...over,
  };
}

export interface AnswerOptions {
  /** Real-user data for this address (absent: the key is left out, as for a page nobody visits). */
  field?: FieldShares | false;
  /** Real-user data for the whole origin. */
  origin?: FieldShares | false;
  /** True: the page-level key holds the origin's data, flagged as a fallback. */
  fallback?: boolean;
  lab?: LabNumbers | false;
}

/** What `runPagespeed` answers, in the shape of the reference. */
export function answer(id: string, o: AnswerOptions = {}) {
  const origin = new URL(id).origin + "/";
  return {
    kind: "pagespeedonline#result",
    id,
    analysisUTCTimestamp: "2026-11-13T12:00:00.000Z",
    ...(o.field === false || o.field === undefined
      ? {}
      : { loadingExperience: experience(id, o.field) }),
    ...(o.fallback && o.origin
      ? { loadingExperience: experience(origin, o.origin, { origin_fallback: true }) }
      : {}),
    ...(o.origin === false || o.origin === undefined
      ? {}
      : { originLoadingExperience: experience(origin, o.origin) }),
    ...(o.lab === false || o.lab === undefined ? {} : { lighthouseResult: lighthouse(o.lab) }),
  };
}

const respond = (status: number, type: string, body: string): TransportResponse => ({
  status,
  headers: { "content-type": type },
  body: Readable.from([Buffer.from(body)]),
});

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export type Reply = { status: number; body: unknown } | { down: string };

/**
 * pagespeedonline.googleapis.com, answered from `replies` by the address asked about (the `url` parameter). An
 * address with no entry gets the reference's 400 for a page it cannot load. Every request is recorded.
 */
export function pageSpeedTransport(replies: Record<string, Reply>): {
  transport: Transport;
  seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    if (url.hostname !== "pagespeedonline.googleapis.com")
      return Promise.resolve(respond(404, "text/plain", "not here"));
    const asked = url.searchParams.get("url") ?? "";
    const reply = replies[asked];
    if (reply === undefined)
      return Promise.resolve(
        respond(
          400,
          "application/json",
          JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } }),
        ),
      );
    if ("down" in reply)
      return Promise.reject(
        Object.assign(new Error(`connect ${reply.down}`), { code: reply.down }),
      );
    return Promise.resolve(
      respond(
        reply.status,
        "application/json",
        typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
      ),
    );
  };
  return { transport, seen };
}
