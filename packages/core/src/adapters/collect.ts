import { AdapterRateLimitedError } from "./types.js";
import type {
  AdapterDescription,
  ContentAdapter,
  PublishedDoc,
  PublishedOptions,
} from "./types.js";

export interface PartialRead {
  reason: "rate-limited";
  /** When the platform said to try again, in its own terms ("in 120 seconds"). */
  retry?: string;
  /** How many items were read before it stopped. */
  delivered: number;
}

export interface Collected {
  docs: PublishedDoc[];
  /** Present when the read stopped early: the docs are real, and the list is not the whole. */
  partial?: PartialRead;
}

/**
 * Everything published() gives, with a rate limit reported instead of thrown: the items read so
 * far are returned and `partial` says why the list stops. Any other failure is thrown as it is, so
 * a read that could not be made is never taken for an empty list.
 */
export async function collectPublished(
  adapter: ContentAdapter,
  options?: PublishedOptions,
): Promise<Collected> {
  const docs: PublishedDoc[] = [];
  try {
    for await (const doc of adapter.published(options)) docs.push(doc);
  } catch (err) {
    if (!(err instanceof AdapterRateLimitedError)) throw err;
    return {
      docs,
      partial: {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: docs.length,
      },
    };
  }
  return { docs };
}

/** One plain sentence for a partial read, for a report's could-not-check line. */
export function describePartial(p: PartialRead): string {
  return `Read ${p.delivered} ${p.delivered === 1 ? "item" : "items"}, then the platform asked Gaugeline to slow down.${p.retry ? ` Try again ${p.retry}.` : ""} The rest was not read, so what is listed is not everything.`;
}

const KEY_WORDS = {
  "read-only": "a read-only key",
  scoped: "a scoped key",
  "full-access": "a full-access key (Gaugeline only reads with it)",
} as const;

/**
 * The line a run prints about the content system it read, so nobody is surprised by what key it
 * used: "Content system: Sanity, with a read-only key. Endpoints and how to make the key: <docs>".
 */
export function adapterHeader(d: AdapterDescription): string {
  return `Content system: ${d.name}, with ${KEY_WORDS[d.keyKind]}. Endpoints and how to make the key: ${d.docsUrl}`;
}
