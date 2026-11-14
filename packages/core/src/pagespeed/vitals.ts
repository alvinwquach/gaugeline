import { escapeInvisible } from "../checks/hidden-text/escape.js";

/**
 * Core Web Vitals and what Google's PageSpeed Insights answers (PERF-01).
 *
 * Two kinds of number, never mixed:
 * - FIELD data is what real visitors' Chrome measured (the Chrome UX Report). It decides pass or fail.
 * - LAB data is one simulated load on Google's servers (Lighthouse, mobile). It is advice and never fails a page.
 *
 * Field data is judged from the buckets, not from the answer's `percentile` field. Google's reference for the
 * answer says that field holds "pc90" for version 5, while web.dev defines a vital as passing at the 75th
 * percentile, so the field is ignored. The two ways to say it are the same fact: the 75th percentile is within the
 * good range exactly when at least 75% of loads are in the good bucket, and it is beyond the poor limit exactly
 * when more than 25% of loads are in the poor bucket.
 */

/** The three vitals, with web.dev's "good" and "poor" limits (milliseconds; layout shift is a score). */
export const VITALS = {
  lcp: { name: "Largest Contentful Paint", good: 2500, poor: 4000 },
  inp: { name: "Interaction to Next Paint", good: 200, poor: 500 },
  cls: { name: "Cumulative Layout Shift", good: 0.1, poor: 0.25 },
} as const;

export const VITAL_IDS = ["lcp", "inp", "cls"] as const;
export type VitalId = (typeof VITAL_IDS)[number];

export type VitalVerdict = "good" | "needs-improvement" | "poor";

/** For display, shares are whole thousandths cut down (750 is 75.0%); the verdict is decided on the raw shares. */
export interface FieldMetric {
  id: VitalId;
  verdict: VitalVerdict;
  goodPermille: number;
  poorPermille: number;
}

export type FieldRead =
  | {
      kind: "field";
      /** "page": this address. "origin": the whole site's visitors, because the page has too few. */
      scope: "page" | "origin";
      metrics: FieldMetric[];
      /** Vitals the answer does not carry: could not check, never a pass. */
      missing: VitalId[];
      /** Vitals the answer carries in a shape that is not the definition, with the plain reason. */
      unreadable: { id: VitalId; why: string }[];
    }
  | { kind: "none"; reason: string };

export type LabRead =
  | {
      kind: "lab";
      /** The Lighthouse performance score, 0 to 100. */
      score: number;
      lcpMs?: number;
      tbtMs?: number;
      clsThousandths?: number;
      speedIndexMs?: number;
      fcpMs?: number;
    }
  | { kind: "none"; reason: string };

export interface PageSpeedAnswer {
  /** The address Google ended on (clipped, invisible characters shown as escapes). */
  id: string;
  field: FieldRead;
  lab: LabRead;
}

export class PageSpeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageSpeedError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The metric ids Google uses are matched by the vital's own words, so a prefix such as EXPERIMENTAL_ is fine. */
const KEYS: Record<VitalId, string> = {
  lcp: "largest_contentful_paint",
  inp: "interaction_to_next_paint",
  cls: "cumulative_layout_shift",
};

/** Layout shift buckets come as 0.1 and 0.25, or scaled by 100 as 10 and 25. */
const edgeMatches = (id: VitalId, got: unknown, limit: number): boolean =>
  typeof got === "number" && (got === limit || (id === "cls" && got === limit * 100));

function readMetric(id: VitalId, raw: unknown): FieldMetric | string {
  if (!isRecord(raw) || !Array.isArray(raw.distributions))
    return "its buckets are not in the answer";
  const [good, middle, poor] = raw.distributions as unknown[];
  if (raw.distributions.length !== 3 || !isRecord(good) || !isRecord(middle) || !isRecord(poor))
    return "it does not have the three buckets (good, needs improvement, poor)";
  const shares = [good, middle, poor].map((b) => num(b.proportion));
  if (shares.some((s) => s === undefined || s < 0 || s > 1)) return "a bucket has no share";
  const total = (shares as number[]).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 0.02) return "the shares do not add up to 100%";
  if (!edgeMatches(id, good.max, VITALS[id].good) || !edgeMatches(id, middle.max, VITALS[id].poor))
    return "the buckets are not web.dev's good and poor limits";
  // The verdict is the exact comparison on the raw shares, as web.dev states it: good is at least 75% of
  // loads in the good bucket, poor is more than 25% in the poor bucket. Rounding first would let 74.95% pass.
  const [goodShare, , poorShare] = shares as [number, number, number];
  const verdict: VitalVerdict =
    goodShare >= 0.75 ? "good" : poorShare > 0.25 ? "poor" : "needs-improvement";
  // For display, whole thousandths cut down (never up), so a share just under 75% never shows as 75%.
  const goodPermille = Math.floor(goodShare * 1000 + 1e-6);
  const poorPermille = Math.floor(poorShare * 1000 + 1e-6);
  return { id, verdict, goodPermille, poorPermille };
}

function readExperience(raw: unknown, scope: "page" | "origin"): FieldRead | undefined {
  if (!isRecord(raw) || !isRecord(raw.metrics)) return undefined;
  const found = new Map<VitalId, unknown>();
  for (const [key, value] of Object.entries(raw.metrics)) {
    const lower = key.toLowerCase();
    for (const id of VITAL_IDS)
      if (lower.includes(KEYS[id]) && !found.has(id)) found.set(id, value);
  }
  if (found.size === 0) return undefined;
  const metrics: FieldMetric[] = [];
  const missing: VitalId[] = [];
  const unreadable: { id: VitalId; why: string }[] = [];
  for (const id of VITAL_IDS) {
    if (!found.has(id)) {
      missing.push(id);
      continue;
    }
    const read = readMetric(id, found.get(id));
    if (typeof read === "string") unreadable.push({ id, why: read });
    else metrics.push(read);
  }
  return { kind: "field", scope, metrics, missing, unreadable };
}

function readField(json: Record<string, unknown>): FieldRead {
  const page = readExperience(
    json.loadingExperience,
    isRecord(json.loadingExperience) && json.loadingExperience.origin_fallback === true
      ? "origin"
      : "page",
  );
  if (page) return page;
  const origin = readExperience(json.originLoadingExperience, "origin");
  if (origin) return origin;
  return {
    kind: "none",
    reason:
      "Google has no real-user data for this page or its site (the Chrome UX Report needs enough visitors), so it was not judged.",
  };
}

function readLab(json: Record<string, unknown>): LabRead {
  const lh = json.lighthouseResult;
  if (!isRecord(lh)) return { kind: "none", reason: "The answer holds no Lighthouse run." };
  if (isRecord(lh.runtimeError))
    return {
      kind: "none",
      reason: "Lighthouse reported an error for this page, so its numbers were dropped.",
    };
  const categories = isRecord(lh.categories) ? lh.categories : {};
  const perf = isRecord(categories.performance) ? categories.performance : {};
  const score = num(perf.score);
  if (score === undefined || score < 0 || score > 1)
    return { kind: "none", reason: "Lighthouse gave no performance score for this page." };
  const audits = isRecord(lh.audits) ? lh.audits : {};
  const value = (id: string): number | undefined => {
    const a = audits[id];
    return isRecord(a) ? num(a.numericValue) : undefined;
  };
  const lcp = value("largest-contentful-paint");
  const tbt = value("total-blocking-time");
  const cls = value("cumulative-layout-shift");
  const si = value("speed-index");
  const fcp = value("first-contentful-paint");
  return {
    kind: "lab",
    score: Math.round(score * 100),
    ...(lcp === undefined ? {} : { lcpMs: Math.round(lcp) }),
    ...(tbt === undefined ? {} : { tbtMs: Math.round(tbt) }),
    ...(cls === undefined ? {} : { clsThousandths: Math.round(cls * 1000) }),
    ...(si === undefined ? {} : { speedIndexMs: Math.round(si) }),
    ...(fcp === undefined ? {} : { fcpMs: Math.round(fcp) }),
  };
}

/**
 * PageSpeed Insights' answer, read field by field. Everything in it is data from outside: only numbers and
 * the final address are kept, the address clipped and its invisible characters escaped, and nothing in the
 * answer (an audit's text, an error message) is ever carried into a finding.
 */
export function parsePageSpeed(json: unknown): PageSpeedAnswer {
  if (!isRecord(json)) throw new PageSpeedError("PageSpeed Insights' answer was not a result.");
  const id = typeof json.id === "string" ? escapeInvisible(json.id, 150) : "";
  return { id, field: readField(json), lab: readLab(json) };
}
