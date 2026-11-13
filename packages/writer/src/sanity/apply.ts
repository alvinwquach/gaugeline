/**
 * Apply one approved `sanity_draft` (ADR-0010, X71): read the live document, read its draft, and create the
 * `drafts.<id>` document with the fix in it. Nothing here can make a change live: the registry has no
 * request for it, and the only write names a `drafts.` id (so it never touches the live document), which
 * Sanity refuses to create when it already exists (so it never overwrites an editor's draft). It stops at the
 * first kill switch, refusal or failed request, and appends exactly one entry to the trail.
 *
 * Before anything is sent the writer reads the approval row itself and checks it (approval.ts), then the
 * payload's shape, that every field is on the customer's `allowedFields` and not on the floor (fields.ts),
 * and the registry. In write mode it then compares the live value of each field with the digest the
 * proposal recorded (`before`): a different value means someone edited it since, and the draft is refused.
 * One write request per approval. A replay finds the draft already holding the approved value and records
 * `applied` without a second write.
 */
import { checkApproval, sameDigest, UUID } from "../approval.js";
import { checkDraftPayload } from "../kinds.js";
import { stopReason, type Mode, type Switches } from "../switches.js";
import type { Approvals, ApplyJob, Trail, TrailEntry } from "../types.js";
import {
  checkSanityRequest,
  isSanityTarget,
  SanityRegistryError,
  type SanityRequest,
  type SanityTarget,
} from "./endpoints.js";
import { isAllowedField, isAllowedFieldsList } from "./fields.js";
import { valueSha256 } from "./hash.js";
import type { SanitySend } from "./send.js";

export interface SanityApplyTarget extends SanityTarget {
  /** The organisation this worker serves. A job for another organisation is refused. */
  orgId: string;
  /** The one site this project belongs to. A job for another site is refused. */
  siteId: string;
  /**
   * The only fields a draft may change, as `<document type>.<field>` (`page.hours`). Required: with none
   * listed every field is refused. Money and secret fields are refused whatever is listed here.
   */
  allowedFields: readonly string[];
}

export interface SanityApplyDeps extends Switches {
  target: SanityApplyTarget;
  /** Where the approval row is read. A job with no approval row is refused, whoever queued it. */
  approvals: Approvals;
  /** The clock, for the 72-hour expiry. Defaults to the system clock. */
  now?: () => Date;
  send: SanitySend;
  trail: Trail;
  /** "dry-run" (the default in the worker's configuration) sends nothing and records the plan. */
  mode: Mode;
}

class Stop extends Error {
  constructor(readonly entry: Partial<TrailEntry>) {
    super("stop");
  }
}

/** The most the copy of a live document may be, as JSON text. A larger document is not copied. */
const MAX_COPY_CHARS = 500_000;
const DRAFTS = "drafts.";

interface SanityPayload {
  documentId: string;
  documentType: string;
  set: Record<string, string | number | boolean | null>;
  before: Record<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The document with `id` in a read's answer, or undefined. Only `documents` is looked at. */
function documentIn(json: unknown, id: string): Record<string, unknown> | undefined {
  if (!isObject(json) || !Array.isArray(json.documents)) return undefined;
  return json.documents.find((d): d is Record<string, unknown> => isObject(d) && d._id === id);
}

/** The digest of a value in a document, or null when it cannot be hashed (so it never matches). */
function digestOf(value: unknown): string | null {
  try {
    return valueSha256(value);
  } catch {
    return null;
  }
}

/** The copy that becomes the draft: the live document's content with the fix, under the draft's id. */
function draftCopy(live: Record<string, unknown>, p: SanityPayload, draftId: string) {
  const copy: Record<string, unknown> = {};
  // The system fields (_rev, _createdAt, _updatedAt, ...) belong to the content system and are not sent.
  for (const [k, v] of Object.entries(live)) if (!k.startsWith("_")) copy[k] = v;
  return { ...copy, ...p.set, _id: draftId, _type: p.documentType };
}

export async function applySanityDraft(job: ApplyJob, deps: SanityApplyDeps): Promise<TrailEntry> {
  const head = { draftId: job.draftId, decisionId: job.decisionId };
  const finish = async (rest: Partial<TrailEntry>): Promise<TrailEntry> => {
    const entry = { ...head, ...rest } as TrailEntry;
    await deps.trail.record(entry);
    return entry;
  };
  const refused = (reason: string) => finish({ outcome: "refused", reason });
  const { target } = deps;

  if (job.kind !== "sanity_draft" || !UUID.test(job.draftId)) return refused("kind");
  if (
    !UUID.test(target.orgId) ||
    !UUID.test(target.siteId) ||
    !isSanityTarget(target) ||
    !isAllowedFieldsList(target.allowedFields)
  ) {
    return refused("target");
  }

  const stopped = await stopReason(deps);
  if (stopped) return refused(stopped);

  // The approval row, read here, is the authority; the job only says which one to read.
  const checked = await checkApproval(job, { target, approvals: deps.approvals, now: deps.now });
  if (!checked.ok) return refused(checked.reason);

  let parsed: unknown;
  try {
    parsed = JSON.parse(job.payloadText);
  } catch {
    return refused("payload");
  }
  const check = checkDraftPayload("sanity_draft", parsed);
  if (!check.ok) return refused("payload");
  const payload = check.value as unknown as SanityPayload;
  const fields = Object.keys(payload.set);
  if (!fields.every((f) => isAllowedField(payload.documentType, f, target.allowedFields))) {
    return refused("field");
  }

  const liveId = payload.documentId;
  const draftId = `${DRAFTS}${liveId}`;
  const base = `/${target.apiVersion}/data`;
  const readLive: SanityRequest = {
    endpoint: "getDoc",
    path: `${base}/doc/${target.dataset}/${liveId}`,
  };
  const readDraft: SanityRequest = {
    endpoint: "getDoc",
    path: `${base}/doc/${target.dataset}/${draftId}`,
  };
  const write = (doc: Record<string, unknown>): SanityRequest => ({
    endpoint: "mutate",
    path: `${base}/mutate/${target.dataset}`,
    query: { returnIds: "true" },
    body: { mutations: [{ create: doc }] },
  });
  // The plan is checked against the registry now, in every mode: a dry run that passes is a write that will
  // not be refused for its shape. Every name in it is already plain, so this cannot fail for a payload that
  // got this far; if it ever did, the error would stop the job before any request. The real copy of the
  // document is built, and checked, once it is read.
  const planned = write({ ...payload.set, _id: draftId, _type: payload.documentType });
  for (const r of [readLive, readDraft, planned]) checkSanityRequest(r, target);
  if (deps.mode !== "write") {
    return finish({
      outcome: "dry_run",
      planned: [readLive, readDraft, planned].map((r) => ({ endpoint: r.endpoint, path: r.path })),
    });
  }

  /** Check the switches, send, and stop on anything but an expected status. */
  const call = async (req: SanityRequest, ok: number[]) => {
    const why = await stopReason(deps);
    if (why) throw new Stop({ outcome: "refused", reason: why });
    const res = await deps.send(req);
    if (!ok.includes(res.status)) throw new Stop({ outcome: "apply_failed", status: res.status });
    return res;
  };

  try {
    const liveRes = await call(readLive, [200, 404]);
    const live = liveRes.status === 200 ? documentIn(liveRes.json, liveId) : undefined;
    if (!live) throw new Stop({ outcome: "refused", reason: "missing" });
    if (live._type !== payload.documentType) throw new Stop({ outcome: "refused", reason: "type" });
    // Stale: someone edited the field since the fix was proposed. The digest is of what a person saw.
    for (const f of fields) {
      const now = digestOf(live[f]);
      if (now === null || !sameDigest(now, payload.before[f]!)) {
        throw new Stop({ outcome: "refused", reason: "stale" });
      }
    }

    const draftRes = await call(readDraft, [200, 404]);
    const existing = draftRes.status === 200 ? documentIn(draftRes.json, draftId) : undefined;
    if (existing) {
      // A draft is there. If it already holds the approved values this is a replay: it is the result. If
      // not, an editor has started one: it is never overwritten.
      const same = fields.every((f) => {
        const a = digestOf(existing[f]);
        const b = digestOf(payload.set[f]);
        return a !== null && b !== null && sameDigest(a, b);
      });
      if (same) return await finish({ outcome: "applied", ref: draftId });
      throw new Stop({ outcome: "refused", reason: "draft exists" });
    }

    const doc = draftCopy(live, payload, draftId);
    if (JSON.stringify(doc).length > MAX_COPY_CHARS) {
      throw new Stop({ outcome: "refused", reason: "document" });
    }
    await call(write(doc), [200]);
    return await finish({ outcome: "applied", ref: draftId });
  } catch (e) {
    if (e instanceof Stop) return finish(e.entry);
    if (e instanceof SanityRegistryError) return finish({ outcome: "refused", reason: "registry" });
    // Anything else (the network failed): leave a trail entry, then let the worker see the error.
    await finish({ outcome: "apply_failed" }).catch(() => undefined);
    throw e;
  }
}
