/**
 * Shared stand-ins for the Sanity apply tests. The stand-in answers the two registered requests the way the
 * recorded shapes in the PR's Sources do: a read returns `{ documents: [...] }`, a create of an id that
 * exists is refused with 409, a create of a new id answers `{ transactionId, results: [{ id, operation }] }`.
 * It holds the documents in memory and records every request. No network, no account, no token.
 */
import { valueSha256 } from "../sanity/hash.js";
import { createSanityStandIn, type StandInOptions } from "../sanity/standin.js";
import type { SanityApplyDeps } from "../sanity/apply.js";
import type { ApplyJob, TrailEntry } from "../types.js";
import { approvalFor, job, NOW, ORG, SITE } from "./helpers.js";

export const SANITY_TARGET = {
  orgId: ORG,
  siteId: SITE,
  projectId: "tidewtr1",
  dataset: "production",
  apiVersion: "v2025-02-19",
  allowedFields: ["page.hours", "page.phone", "page.title"],
} as const;

/** The live document: an invented bar, with Sanity's system fields. */
export const LIVE = {
  _id: "menu-page",
  _type: "page",
  _rev: "rev-live-1",
  _createdAt: "2026-01-02T10:00:00Z",
  _updatedAt: "2026-10-01T10:00:00Z",
  title: "The Tidewater Bar",
  hours: "Mon to Sat, 4pm to 11pm",
  phone: "+44 20 7946 0000",
  sections: [{ _key: "a1", heading: "Drinks", items: ["Gin", "Rum"] }],
};

export const SANITY_PAYLOAD = {
  documentId: "menu-page",
  documentType: "page",
  set: { hours: "Mon to Sun, 4pm to 11pm" },
  before: { hours: valueSha256(LIVE.hours) },
};

export const sanityJob = (payload: unknown = SANITY_PAYLOAD, over: Partial<ApplyJob> = {}) =>
  job(payload, { kind: "sanity_draft", ...over });

type Doc = Record<string, unknown>;

/** The stand-in holding the live document (and a draft, if given). `live: null` holds no live document. */
export function fakeSanity(
  options: {
    live?: Doc | null;
    draft?: Doc | null;
    after?: StandInOptions["after"];
    /** Answer the write with this status and a body that carries text the trail must never keep. */
    mutateStatus?: number;
    readStatus?: number;
  } = {},
) {
  const live = options.live === undefined ? LIVE : options.live;
  const documents = [live, options.draft].filter((d): d is Doc => d !== null && d !== undefined);
  return createSanityStandIn(SANITY_TARGET, {
    documents,
    after: options.after,
    writeStatus: options.mutateStatus,
    readStatus: options.readStatus,
  });
}

/** Deps for one Sanity job: the approval table holds the row for `forJob` unless told otherwise. */
export function sanityDeps(
  over: Partial<SanityApplyDeps> & { send: SanityApplyDeps["send"] },
  forJob: ApplyJob = sanityJob(),
  approval: Parameters<typeof approvalFor>[1] | null = {},
): SanityApplyDeps & { log: TrailEntry[]; lookups: string[] } {
  const log: TrailEntry[] = [];
  const lookups: string[] = [];
  return {
    target: SANITY_TARGET,
    trail: { record: async (e) => void log.push(e) },
    approvals: {
      find: async (id) => {
        lookups.push(id);
        return approval === null ? null : approvalFor(forJob, approval);
      },
    },
    mode: "write",
    env: {},
    orgPaused: async () => false,
    now: () => NOW,
    log,
    lookups,
    ...over,
  };
}
