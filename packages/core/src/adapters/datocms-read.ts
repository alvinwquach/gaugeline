import { type PartialRead } from "./collect.js";
import type { DatocmsAdapter, DraftRead } from "./datocms.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";

/**
 * What the DatoCMS check needs, read once: for each collection the settings name, whether a request that asks for
 * drafts is given a record the published list does not have. Ids and counts only: never a field or a name.
 */
export interface DatocmsReading {
  /** What the findings are about: the Content Delivery API's address (the checks read the CMS, not one page). */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Without it nothing is asked. */
  ownerConsent: boolean;
  /** The settings say (`expectPublishedOnly`) the token is meant for published content only. Without it nothing is asked. */
  expectedPublishedOnly: boolean;
  /** The settings name no collection (the API lists none), so nothing was read: the check is could-not-check, not a pass. */
  nothingNamed: boolean;
  drafts: DraftRead[];
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadDatocmsOptions {
  adapter: DatocmsAdapter;
  /** The address to show findings under. Default: the Content Delivery API's. */
  site?: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
}

/**
 * Read a DatoCMS project for the draft check. Only with the owner's consent, and only when the settings say the token is meant for published content
 * only (`expectPublishedOnly`), and only for the collections the settings name: per collection, one published list
 * and one list that asks for drafts, as ids. A collection DatoCMS will not give is recorded with its reason and the
 * others are still read; a rate limit that stays ends the read and marks it partial.
 */
export async function readDatocms(options: ReadDatocmsOptions): Promise<DatocmsReading> {
  const { adapter } = options;
  const reading: DatocmsReading = {
    site: options.site ?? "https://graphql.datocms.com/",
    ownerConsent: options.ownerConsent === true,
    expectedPublishedOnly: adapter.publishedOnlyExpected(),
    nothingNamed: adapter.collections().length === 0,
    drafts: [],
  };
  // Nothing is asked without the owner's consent (CLAUDE.md rule 14), when there is nothing to ask about, or when the
  // owner did not say the token is meant for published content only.
  if (!reading.ownerConsent || reading.nothingNamed || !reading.expectedPublishedOnly)
    return reading;
  try {
    reading.drafts = await adapter.draftReading();
  } catch (err) {
    if (err instanceof AdapterRateLimitedError) {
      const had = Array.isArray(err.partial) ? (err.partial as DraftRead[]) : [];
      reading.drafts = had;
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: had.length,
      };
    } else if (err instanceof AdapterCouldNotCheck) {
      reading.drafts = adapter.collections().map((type) => ({
        type,
        state: "unread",
        published: 0,
        extra: 0,
        extraIds: [],
        reason: err.reason,
      }));
    } else throw err;
  }
  return reading;
}
