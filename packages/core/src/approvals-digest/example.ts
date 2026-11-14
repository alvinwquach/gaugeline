/**
 * The invented inbox the docs page and the eval set share (AG-14): a cocktail bar and a pop-up kitchen, four
 * drafts waiting, one past its 72 hours. No real client, venue, address or person.
 */
import { EVAL_EPOCH_MS } from "../evals/types.js";
import type { ApprovalsDigestOptions } from "./digest.js";

/** The eval harness's own fixed clock, so the docs page and the eval set read the same morning. */
export const EXAMPLE_NOW = new Date(EVAL_EPOCH_MS);
export const BAR = "a1000000-0000-4000-8000-0000000000a1";
export const POPUP = "a1000000-0000-4000-8000-0000000000a2";

/** One pending draft as the API and the MCP tool return it (the title and excerpt in their labelled slots). */
export function exampleDraft(
  n: number,
  siteId: string,
  kind: string,
  createdAt: string,
  title: string,
  excerpt = "The text the draft would send.",
) {
  const slot = (source: string, text: string) => ({ untrusted: true, source, text });
  return {
    id: `a1d20000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    siteId,
    kind,
    title: slot("draft title", title),
    excerpt: slot("draft excerpt", excerpt),
    payloadSha256: "c".repeat(64),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 72 * 3_600_000).toISOString(),
    findingIds: [],
  };
}

export const EXAMPLE_DRAFTS = [
  exampleDraft(1, BAR, "email", "2026-11-10T14:00:00.000Z", "Your menu link is fixed"),
  exampleDraft(
    2,
    BAR,
    "pull_request",
    "2026-11-12T15:00:00.000Z",
    "Point the menu link at /drinks",
  ),
  exampleDraft(3, POPUP, "sanity_draft", "2026-11-11T11:00:00.000Z", "Update the booking banner"),
  exampleDraft(4, POPUP, "email", "2026-11-13T11:00:00.000Z", "Booking confirmation wording"),
  exampleDraft(5, POPUP, "email", "2026-11-09T00:00:00.000Z", "Old opening-hours note"),
];

export const EXAMPLE_OPTIONS: ApprovalsDigestOptions = {
  appUrl: "https://app.northgate.example",
  siteNames: new Map([
    [BAR, "The Tidewater Bar"],
    [POPUP, "Juniper Pop-up Kitchen"],
  ]),
};
