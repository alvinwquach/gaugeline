/**
 * Apply one approved email draft (ADR-0010, X75): build one plain-text message addressed to the site's
 * configured contacts and save it as a draft in the customer's own Gmail. Gaugeline never sends: sending
 * is the person's act, in their mail program, and this module has no request that could.
 *
 * Like the pull request writer, it stops at the first kill switch, refusal or failed request and appends
 * exactly one entry to the trail. The job is a claim: the approval row is read and compared first
 * (../approval.ts: the payload hash covers the subject and the body; the recipients are not in the payload
 * at all, they come from the worker's configuration). Then the payload's shape, the message, and the
 * registry, which reads the finished message back and refuses any recipient that is not a configured one.
 *
 * One approval makes one draft: a decision the approval row already shows as applied, or that this
 * process is applying or has applied, is refused as a duplicate. Gmail has no idempotency key and the
 * narrow scope cannot list drafts, so the guard is the approval row and this process; a network failure
 * after Gmail created the draft but before the entry was written can leave one extra draft in Drafts,
 * which the person deletes, and which cannot be sent by this code.
 */
import { checkApproval, UUID } from "../approval.js";
import { checkDraftPayload } from "../kinds.js";
import { stopReason, type Mode, type Switches } from "../switches.js";
import type { Approvals, ApplyJob, Trail, TrailEntry } from "../types.js";
import { RegistryError } from "../github/endpoints.js";
import { checkGmailRequest, DRAFTS_PATH, type GmailRequest } from "./endpoints.js";
import { isPlainAddress, MAX_RECIPIENTS, MimeError, buildRaw } from "./mime.js";
import { MailTokenError, type CreateDraft } from "./send.js";
import { mailBody } from "./text.js";

export interface MailTarget {
  /** The organisation this worker serves. A job for another organisation is refused. */
  orgId: string;
  /** The one site this mailbox belongs to. A job for another site is refused. */
  siteId: string;
  /**
   * The site's client contacts, from the worker's configuration and nowhere else: the only addresses a
   * draft may be addressed to, and the ones it is addressed to. Never from the payload or from page text.
   */
  contacts: readonly string[];
  /** Contacts that bounced last time: left off the draft. When none is left, the job is refused. */
  bounced?: readonly string[];
}

export interface MailDeps extends Switches {
  target: MailTarget;
  /** Creates the draft: `gmailSender(...)`, which checks the registry again and holds the token. */
  createDraft: CreateDraft;
  trail: Trail;
  /** Where the approval row is read. Required: a job with no approval row is refused, whoever queued it. */
  approvals: Approvals;
  /** "dry-run" (the default in the worker's configuration) sends nothing and records the plan. */
  mode: Mode;
  /** The clock, for the 72-hour expiry. Defaults to the system clock. */
  now?: () => Date;
}

/** A plain id Gmail returns (letters, digits, "_" and "-"): the only thing recorded of its answer. */
const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Decisions this process is applying (true) or has applied (true); a decision that failed or was refused
 * is set back to false so it can be tried again. A Map of booleans, set and read in O(1): the duplicate
 * guard is claimed before the first await, so two calls at once cannot both pass it.
 */
const claimed = new Map<string, boolean>();

function validTarget(t: MailTarget): boolean {
  return (
    UUID.test(t.orgId) &&
    UUID.test(t.siteId) &&
    Array.isArray(t.contacts) &&
    t.contacts.length >= 1 &&
    t.contacts.length <= MAX_RECIPIENTS &&
    t.contacts.every(isPlainAddress)
  );
}

export async function applyEmailDraft(job: ApplyJob, deps: MailDeps): Promise<TrailEntry> {
  const key = String(job.decisionId);
  if (claimed.get(key) === true) {
    const entry: TrailEntry = {
      draftId: job.draftId,
      decisionId: job.decisionId,
      outcome: "refused",
      reason: "duplicate",
    };
    await deps.trail.record(entry);
    return entry;
  }
  claimed.set(key, true);
  let entry: TrailEntry | undefined;
  try {
    entry = await run(job, deps);
    return entry;
  } finally {
    if (entry?.outcome !== "applied") claimed.set(key, false);
  }
}

async function run(job: ApplyJob, deps: MailDeps): Promise<TrailEntry> {
  const head = { draftId: job.draftId, decisionId: job.decisionId };
  const finish = async (rest: Partial<TrailEntry>): Promise<TrailEntry> => {
    const entry = { ...head, ...rest } as TrailEntry;
    await deps.trail.record(entry);
    return entry;
  };
  const refused = (reason: string) => finish({ outcome: "refused", reason });
  const { target } = deps;

  if (job.kind !== "email" || !UUID.test(job.draftId)) return refused("kind");
  if (!validTarget(target)) return refused("target");

  const stopped = await stopReason(deps);
  if (stopped) return refused(stopped);

  // The approval row, read here, is the authority; the job only says which one to read.
  const checked = await checkApproval(job, deps);
  if (!checked.ok) return refused(checked.reason);
  if (checked.approval.later.includes("applied")) return refused("duplicate");

  // The payload must match the kind's fixed shape: the same schema the inbox checked before it recorded
  // the approval. It has a subject and a body and nothing else: no recipient, no header, no flag.
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.payloadText);
  } catch {
    return refused("payload");
  }
  const check = checkDraftPayload("email", parsed);
  if (!check.ok) return refused("payload");
  const { subject, body } = check.value as { subject: string; body: string };

  const bounced = new Set((target.bounced ?? []).map((a) => a.toLowerCase()));
  const to = target.contacts.filter((a) => !bounced.has(a.toLowerCase()));
  if (to.length === 0) return refused("recipient");

  let request: GmailRequest;
  try {
    request = {
      endpoint: "createDraft",
      path: DRAFTS_PATH,
      body: { message: { raw: buildRaw({ to, subject, body: mailBody(body) }) } },
    };
    // Checked now, in every mode: a dry run that passes is a write that will not be refused for its shape.
    checkGmailRequest(request, target.contacts);
  } catch (e) {
    if (e instanceof MimeError) return refused("payload");
    if (e instanceof RegistryError) return refused("registry");
    throw e;
  }
  if (deps.mode !== "write") {
    return finish({
      outcome: "dry_run",
      planned: [{ endpoint: request.endpoint, path: request.path }],
    });
  }

  // The switches again, before the request.
  const why = await stopReason(deps);
  if (why) return refused(why);
  try {
    const res = await deps.createDraft(request);
    if (res.status === 200) {
      const id = res.json?.id;
      return await finish({ outcome: "applied", ...(id && DRAFT_ID.test(id) ? { ref: id } : {}) });
    }
    // A token Gmail does not accept (revoked, expired, or a scope removed): the draft stays in the inbox.
    const reconnect = res.status === 401 || res.status === 403;
    return await finish({
      outcome: "apply_failed",
      status: res.status,
      ...(reconnect ? { reason: "reconnect" } : {}),
    });
  } catch (e) {
    if (e instanceof MailTokenError) return refused("disconnected");
    if (e instanceof RegistryError) return refused("registry");
    // Anything else (the network failed): leave a trail entry, then let the worker see the error.
    await finish({ outcome: "apply_failed" }).catch(() => undefined);
    throw e;
  }
}
