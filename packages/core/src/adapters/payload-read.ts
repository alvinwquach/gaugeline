import type { PartialRead } from "./collect.js";
import type { PayloadAdapter, PayloadPublicCollection } from "./payload.js";
import { AdapterRateLimitedError } from "./types.js";

/**
 * What the Payload check needs, read once: what a visitor with no key can list of the collections the settings
 * mark private (only when the owner consented), and what stopped the read. Collection slugs and counts only: never a
 * field, never a document.
 */
export interface PayloadReading {
  /** The origin of the API that was asked: what a finding points to. */
  site: string;
  /** The owner agreed to probing checks. Without it nothing was asked as a visitor. */
  ownerConsent: boolean;
  /** The collections the settings mark private (`privateCollections`). */
  markedPrivate: string[];
  /** What a visitor with no key can list of them. Empty without consent. */
  publicCollections: PayloadPublicCollection[];
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadPayloadOptions {
  adapter: PayloadAdapter;
  /** The address of Payload's API, such as https://studio.quillon-coffee.example/api. It is only shown, never asked here. */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
}

/**
 * Read a Payload site for the Payload check. With the owner's consent, one keyless GET per collection the settings
 * mark private; a rate limit that stays ends the read and marks it partial. Without consent, or with nothing marked
 * private, nothing is asked as a visitor (CLAUDE.md rule 14).
 */
export async function readPayload(options: ReadPayloadOptions): Promise<PayloadReading> {
  const { adapter } = options;
  const reading: PayloadReading = {
    site: new URL(options.site).origin,
    ownerConsent: options.ownerConsent === true,
    markedPrivate: adapter.privateCollections(),
    publicCollections: [],
  };
  if (reading.ownerConsent && reading.markedPrivate.length > 0) {
    try {
      reading.publicCollections = await adapter.publicCollections();
    } catch (err) {
      if (!(err instanceof AdapterRateLimitedError)) throw err;
      reading.publicCollections = err.partial as PayloadPublicCollection[];
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: reading.publicCollections.length,
      };
    }
  }
  return reading;
}
