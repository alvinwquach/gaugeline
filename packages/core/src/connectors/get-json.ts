import { LIMITS } from "../limits.js";
import type { Fetcher } from "../fetcher.js";
import { ConnectorRateLimitedError, connectorGet, type ConnectorRequest } from "./http.js";

/** Proposed: the longest Retry-After Gaugeline waits for, in seconds. A longer one is given up on. */
export const MAX_RETRY_SECONDS = 60;

/** The answer was bigger than one response may be (LIMITS.bodyBytes). A caller that can ask for less may do so. */
export class ResponseTooLargeError extends Error {
  constructor(system: string) {
    super(
      `${system}'s answer is larger than ${LIMITS.bodyBytes / (1024 * 1024)} MB, which is more than a page should be.`,
    );
    this.name = "ResponseTooLargeError";
  }
}

export interface JsonSource {
  fetcher: Fetcher;
  /** Headers for every request: the key goes here, never into an address. */
  request: Pick<ConnectorRequest, "authorization" | "headers" | "anonymous">;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep: (ms: number) => Promise<void>;
  /** The system's name for messages, such as "Shopify". */
  system: string;
}

/**
 * One GET, parsed as JSON. A 429 with a Retry-After of at most MAX_RETRY_SECONDS is waited out and
 * asked again once (with `fresh`, so the fetcher's memory of the 429 is not served back); a second
 * 429, or one with no usable Retry-After, is thrown as ConnectorRateLimitedError. 401, 403 and other
 * statuses are thrown as connectorGet throws them, for the caller to put in its own words. Returns
 * the parsed body and the response headers (lower-case names).
 */
export async function getJson(
  source: JsonSource,
  url: string,
): Promise<{ body: unknown; headers: Record<string, string>; url: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const hop = await connectorGet(source.fetcher, url, {
        ...source.request,
        // The fetcher remembers answers: a retry must not be handed the 429 it already got.
        ...(attempt > 0 ? { fresh: true } : {}),
      });
      if (hop.truncated) throw new ResponseTooLargeError(source.system);
      try {
        return { body: JSON.parse(hop.body ?? "") as unknown, headers: hop.headers, url: hop.url };
      } catch {
        throw new Error(`${source.system} answered with something that is not JSON.`);
      }
    } catch (err) {
      if (
        err instanceof ConnectorRateLimitedError &&
        attempt === 0 &&
        err.retrySeconds !== undefined &&
        err.retrySeconds <= MAX_RETRY_SECONDS
      ) {
        await source.sleep(err.retrySeconds * 1000);
        continue;
      }
      throw err;
    }
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An id sent as a number or as text, as text. Anything else (or empty) is null. */
export function idText(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

/** A SKU as text, or undefined when there is none (never an empty string). */
export function skuText(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
