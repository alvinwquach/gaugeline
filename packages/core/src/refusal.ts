import type { Hop } from "./fetcher.js";

/**
 * Whether an answer is the site's content or a wall in front of it. A refusal is neither a
 * finding (the site may be fine) nor a failure (the code worked): it is "could not check".
 */
export type HopOutcome =
  | { kind: "ok" }
  | { kind: "refused"; reason: "status" | "challenge" | "rate-limit"; status: number };

/**
 * Words a bot-challenge page shows instead of the site, matched only on a short page: a real page
 * that mentions a captcha is long. A frozen list; one line per service.
 */
export const CHALLENGE_MARKERS: readonly RegExp[] = Object.freeze([
  /just a moment/i,
  /attention required/i,
  /cf-chl|challenge-platform/i,
  /<form[^>]*(?:captcha|challenge)/i,
  /checking (?:if the site connection is secure|your browser)/i,
]);

/** Fewer visible words than this, and a marker, is a challenge page. */
export const CHALLENGE_MAX_WORDS = 60;

function visibleWords(html: string): number {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .trim();
  return text === "" ? 0 : text.split(/\s+/).length;
}

/** 401, 403, 429 and 503 with Retry-After are refusals; so is a short 200 challenge page. */
export function classifyHop(hop: Hop | undefined): HopOutcome {
  if (!hop) return { kind: "ok" };
  const { status } = hop;
  if (status === 401 || status === 403) return { kind: "refused", reason: "status", status };
  if (status === 429) return { kind: "refused", reason: "rate-limit", status };
  if (status === 503 && (hop.headers["retry-after"] ?? "") !== "")
    return { kind: "refused", reason: "rate-limit", status };
  if (status === 200) {
    const body = hop.body ?? "";
    if (visibleWords(body) < CHALLENGE_MAX_WORDS && CHALLENGE_MARKERS.some((m) => m.test(body)))
      return { kind: "refused", reason: "challenge", status };
  }
  return { kind: "ok" };
}

/** How a refusal reads in a could-not-check row: "rate limited (429)". */
export function describeRefusal(outcome: Extract<HopOutcome, { kind: "refused" }>): string {
  switch (outcome.reason) {
    case "status":
      return `refused automated readers (${outcome.status})`;
    case "rate-limit":
      return `rate limited (${outcome.status})`;
    case "challenge":
      return "showed a bot challenge page";
    default: {
      const never: never = outcome.reason;
      return never;
    }
  }
}
