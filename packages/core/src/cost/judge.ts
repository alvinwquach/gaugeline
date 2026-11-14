import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { Severity } from "../model.js";
import { cacheRead, lifetimeOf } from "./cache.js";
import { firstDifference, stripVolatile, type Difference } from "./volatile.js";

/** What one visit to a page answered: its status, headers and body. Nothing else is kept. */
export interface Observation {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

/** A page visited twice, a few seconds apart, or why it could not be. */
export type PageRead =
  | {
      ok: true;
      /** The address read, after redirects. */
      url: string;
      path: string;
      /** The settings list this path as one that should be served from a cache. */
      markedStatic: boolean;
      first: Observation;
      second: Observation;
      /** Milliseconds the run waited between the two visits. */
      gapMs: number;
    }
  | { ok: false; url: string; path: string; reason: string };

type Read = Extract<PageRead, { ok: true }>;

export type CauseId = "output-changes-every-request" | "never-cached" | "revalidate-too-often";

/** One likely reason a page costs more than it should, as the summary and the finding say it. */
export interface Cause {
  id: CauseId;
  severity: Severity;
  /** One plain sentence a client could read. */
  sentence: string;
  /** What was seen, for the finding's evidence. */
  evidence: string;
}

const clip = (text: string, max = 60): string => escapeInvisible(text, max);
const ok2xx = (o: Observation): boolean => o.status >= 200 && o.status < 300;
const seconds = (ms: number): string => {
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? "" : "s"}`;
};

/** Names of cookies a page sets, from a Set-Cookie header (several are joined with ", "). */
function cookieNames(header: string | undefined): string[] {
  if (!header) return [];
  return [...header.matchAll(/(?:^|,\s*)([A-Za-z0-9_.-]+)=/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

const EXPERIMENT_COOKIE =
  /ab[_-]?test|variant|variation|experiment|split|bucket|cohort|optimizely|vwo|growthbook|^ab[_-]|[_-]ab$/i;

export type ChangeVerdict =
  | { kind: "stable" }
  | { kind: "changes"; cause: Difference["kind"]; sentence: string; evidence: string }
  | { kind: "unreadable"; reason: string };

const LOOKS_LIKE: Record<Difference["kind"], string> = {
  time: " (it looks like a time)",
  id: " (it looks like an id or token)",
  number: " (it looks like a counter)",
  other: "",
};

const CHANGE_SENTENCE: Record<Difference["kind"], string> = {
  time: "This page changes on every visit because it prints the current time; caching can't help it.",
  id: "This page changes on every visit because it prints a value that is new on every visit (an id or token); caching can't help it.",
  number:
    "This page changes on every visit because it prints a number that changes on every visit (a counter); caching can't help it.",
  other:
    "This page changes on every visit: its HTML is different on two visits seconds apart; caching can't help it.",
};

/** Why two visits cannot be compared as pages, or undefined when they can. */
function unreadable(r: Read): string | undefined {
  for (const [name, o] of [
    ["first", r.first],
    ["second", r.second],
  ] as const)
    if (!ok2xx(o))
      return `the ${name} visit to ${clip(r.path)} answered HTTP ${o.status}, not a page`;
  return undefined;
}

/**
 * Do two visits to a page, a few seconds apart, give different HTML once the volatile values (nonces,
 * CSRF values) are removed? A page that does defeats caching: every visit is built again. Both visits are
 * sent with no cookies (the fetcher keeps none), so a variant chosen by a cookie is the one a first-time
 * visitor gets; a cookie that looks like an experiment is named in the evidence.
 */
export function compareVisits(r: Read): ChangeVerdict {
  const bad = unreadable(r);
  if (bad) return { kind: "unreadable", reason: bad };
  if (r.first.body === undefined || r.second.body === undefined)
    return { kind: "unreadable", reason: `a visit to ${clip(r.path)} gave no body to compare` };
  const diff = firstDifference(stripVolatile(r.first.body), stripVolatile(r.second.body));
  if (!diff) return { kind: "stable" };
  const cookies = [
    ...new Set([
      ...cookieNames(r.first.headers["set-cookie"]),
      ...cookieNames(r.second.headers["set-cookie"]),
    ]),
  ].filter((n) => EXPERIMENT_COOKIE.test(n));
  const note =
    cookies.length > 0
      ? `. The page also sets ${cookies.length === 1 ? "a cookie that looks" : "cookies that look"} like ${cookies.length === 1 ? "an experiment" : "experiments"} (${cookies.map((c) => clip(c, 40)).join(", ")}); both visits were sent without cookies, so a variant picked at random shows up here as a change`
      : "";
  const where = diff.context === "" ? "at the start of the page" : `after "${clip(diff.context)}"`;
  return {
    kind: "changes",
    cause: diff.kind,
    sentence: CHANGE_SENTENCE[diff.kind],
    evidence: `Two visits ${seconds(r.gapMs)} apart gave different HTML ${where}: "${clip(diff.first)}" the first time, "${clip(diff.second)}" the second${LOOKS_LIKE[diff.kind]}${note}`,
  };
}

export type CachingVerdict =
  | { kind: "not-applicable" }
  | { kind: "cached" }
  | { kind: "never"; sentence: string; evidence: string }
  | { kind: "unknown"; reason: string };

/**
 * For a page marked static: did the CDN ever serve it from its cache over two visits? Judged only from the
 * headers the hosts document (x-vercel-cache, cf-cache-status, age). A hit on either visit means it is
 * cached; a miss on both is never cached; no status on the second visit cannot be judged.
 */
export function cachingVerdict(r: Read): CachingVerdict {
  if (!r.markedStatic) return { kind: "not-applicable" };
  const bad = unreadable(r);
  if (bad) return { kind: "unknown", reason: bad };
  const a = cacheRead(r.first.headers);
  const b = cacheRead(r.second.headers);
  if (a.state === "hit" || b.state === "hit") return { kind: "cached" };
  if (b.state !== "miss")
    return {
      kind: "unknown",
      reason: `${clip(r.path)} is marked static but its response carries no cache status (x-vercel-cache, cf-cache-status or age), so Gaugeline cannot tell whether a cache served it`,
    };
  const seen =
    a.state === "miss" && a.header === b.header
      ? `${b.header} on both visits`
      : `${b.header} on the second visit`;
  return {
    kind: "never",
    sentence:
      "This page is marked static but it is never served from the CDN's cache, so the host builds it again for every visitor.",
    evidence: `${clip(r.path)} is marked static, and ${seen}, ${seconds(r.gapMs)} apart: a cached page would have been a hit the second time`,
  };
}

export type LifetimeVerdict =
  | { kind: "not-applicable" }
  | { kind: "fine" }
  | { kind: "short"; seconds: number; sentence: string; evidence: string }
  | { kind: "unknown"; reason: string };

/**
 * For a page marked static: is its cache lifetime under `minimum` seconds? The lifetime is s-maxage when
 * the header has one, else max-age; no-store, no-cache and private are zero. A max-age with no s-maxage
 * is the browser's, not the CDN's: Vercel and Cloudflare keep such a page until the next deploy or purge,
 * so when the CDN answered a hit it is fine.
 */
export function lifetimeVerdict(r: Read, minimum: number): LifetimeVerdict {
  if (!r.markedStatic) return { kind: "not-applicable" };
  const bad = unreadable(r);
  if (bad) return { kind: "unknown", reason: bad };
  const life = lifetimeOf(r.second.headers) ?? lifetimeOf(r.first.headers);
  if (!life)
    return {
      kind: "unknown",
      reason: `${clip(r.path)} is marked static but its response has no Cache-Control lifetime to judge`,
    };
  if (
    life.from.startsWith("max-age=") &&
    (cacheRead(r.first.headers).state === "hit" || cacheRead(r.second.headers).state === "hit")
  )
    return { kind: "fine" };
  if (life.seconds >= minimum) return { kind: "fine" };
  const every =
    life.seconds === 0
      ? "tells caches not to keep it at all, so the host builds it again for every visitor"
      : `is ${life.seconds} second${life.seconds === 1 ? "" : "s"}, so the host rebuilds it about every ${life.seconds === 1 ? "second" : `${life.seconds} seconds`} instead of keeping the last copy`;
  return {
    kind: "short",
    seconds: life.seconds,
    sentence:
      life.seconds === 0
        ? `This page is marked static, but its cache header ${every}.`
        : `This page is marked static, but its cache lifetime ${every}.`,
    evidence: `${clip(r.path)} is marked static and sends Cache-Control with ${life.from}, a lifetime under the minimum of ${minimum} second${minimum === 1 ? "" : "s"}`,
  };
}

export interface Judgement {
  changes: ChangeVerdict;
  caching: CachingVerdict;
  lifetime: LifetimeVerdict;
  /** The causes to report, likeliest first, each named once. */
  causes: Cause[];
}

/**
 * Everything the three page checks and the summary say about one page. A lifetime of a second or more
 * explains a miss, so then the short lifetime is the cause and "never cached" is left out; a lifetime of
 * nothing at all is "never cached", and the short lifetime is left out.
 */
export function judgePage(r: Read, minimum: number): Judgement {
  const changes = compareVisits(r);
  const caching = cachingVerdict(r);
  const lifetime = lifetimeVerdict(r, minimum);
  const causes: Cause[] = [];
  if (changes.kind === "changes")
    causes.push({
      id: "output-changes-every-request",
      severity: "medium",
      sentence: changes.sentence,
      evidence: changes.evidence,
    });
  const shortLifetime = lifetime.kind === "short" && lifetime.seconds > 0;
  if (caching.kind === "never" && !shortLifetime)
    causes.push({
      id: "never-cached",
      severity: "low",
      sentence: caching.sentence,
      evidence: caching.evidence,
    });
  if (lifetime.kind === "short" && (shortLifetime || caching.kind !== "never"))
    causes.push({
      id: "revalidate-too-often",
      severity: "low",
      sentence: lifetime.sentence,
      evidence: lifetime.evidence,
    });
  return { changes, caching, lifetime, causes };
}

/** The causes of cost on a page, likeliest first. */
export const causesOf = (r: Read, minimum: number): Cause[] => judgePage(r, minimum).causes;
