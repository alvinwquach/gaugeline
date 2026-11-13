/**
 * The drafts inbox (G37). An agent writes a draft; a signed-in person approves it, edits it first, or
 * declines it, once; an approval enqueues one apply job for the customer's own worker. Nothing here writes
 * to a checked system: the apply job's body is the writer package, run by the customer (ADR-0010).
 *
 * Every query runs in a transaction as the signed-in person: `set local role authenticated` with their
 * claims, so row-level security decides what they see and whether they may decide (a client viewer sees no
 * drafts at all). The server checks its login with connectionSkipsRls() once at start-up (db/audit.ts).
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { checkDraftPayload, isDraftKind } from "./kinds.js";

type Tx = postgres.TransactionSql;
type Json = Record<string, unknown>;

export interface Person {
  userId: string;
}

export type Choice =
  { kind: "approve" } | { kind: "edit"; payload: unknown } | { kind: "decline"; reason?: string };

export interface WaitingDraft {
  id: string;
  siteId: string;
  kind: string;
  payload: Json;
  findingIds: string[];
  createdAt: Date;
}

/** One apply job: what the customer's worker is asked to write, after which decision. */
export interface ApplyJob {
  orgId: string;
  draftId: string;
  decisionId: string;
  kind: string;
  /** The approved payload exactly as the database holds it (jsonb text): the draft's own, or the edit. */
  payloadText: string;
  /** The approval row's SHA-256 of payloadText, computed by the database. */
  payloadSha256: string;
}

/**
 * Where an approval puts its apply job. Contract: called inside the decision's transaction, at most once
 * per draft (the unique decision makes a second call impossible), and the job must commit or roll back
 * with that transaction. The jobs table belongs to G36: its implementation inserts the job with `tx`.
 */
export interface ApplyQueue {
  enqueueApply(tx: Tx, job: ApplyJob): Promise<void>;
}

/**
 * A stand-in queue for tests and local runs, keyed on the draft id (a Map: one job per draft). It does
 * NOT honour the contract's last clause: it ignores `tx`, so a job stays here if the transaction later
 * rolls back. decide() enqueues as its last statement for that reason; production uses the jobs table.
 */
export class MemoryApplyQueue implements ApplyQueue {
  readonly jobs = new Map<string, ApplyJob>();
  async enqueueApply(_tx: Tx, job: ApplyJob): Promise<void> {
    if (!this.jobs.has(job.draftId)) this.jobs.set(job.draftId, job);
  }
}

/**
 * What the worker does first with a job (ADR-0010 part 3): the payload must hash to the approval and
 * match its kind's fixed shape. Returns the payload; throws otherwise. The writer package enforces it.
 */
export function verifyApplyJob(job: ApplyJob): Json {
  const sha = createHash("sha256").update(job.payloadText, "utf8").digest("hex");
  if (sha !== job.payloadSha256) throw new Error("the job's payload is not the one approved");
  const check = checkDraftPayload(job.kind, JSON.parse(job.payloadText));
  if (!check.ok) throw new Error(`the job's payload does not match ${job.kind}`);
  return check.value;
}

export type DecideResult =
  | { status: "recorded"; decision: "approved" | "edited" | "declined"; decisionId: string }
  | { status: "already-decided"; decision: string; decidedBy: string | null }
  | { status: "confirm-closed-findings"; closedFindingIds: string[] }
  | { status: "invalid-payload"; problems: string[] }
  | { status: "not-found" };

/** Run `fn` as the signed-in person under row-level security, and commit. */
export async function asPerson<T>(
  sql: postgres.Sql,
  who: Person,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    const claims = JSON.stringify({ role: "authenticated", sub: who.userId });
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx.unsafe("set local role authenticated");
    return fn(tx);
  })) as T;
}

/** The drafts waiting for a decision that this person may see, newest first. */
export async function listWaiting(sql: postgres.Sql, who: Person): Promise<WaitingDraft[]> {
  return asPerson(sql, who, async (tx) => {
    const rows = await tx`
      select d.id, d.site_id, d.kind, d.payload, d.finding_ids, d.created_at
      from public.drafts d join public.draft_state s on s.draft_id = d.id
      where s.decision = 'pending' order by d.created_at desc, d.id`;
    return rows.map((r) => ({
      id: r.id as string,
      siteId: r.site_id as string,
      kind: r.kind as string,
      payload: r.payload as Json,
      findingIds: r.finding_ids as string[],
      createdAt: r.created_at as Date,
    }));
  });
}

/**
 * The draft's findings that have since closed: a later run of the same site that finished cleanly no
 * longer reports their fingerprint. Approving such a draft needs a second, confirmed click.
 *
 * "Cleanly" is what the stored summary can show (G35 keeps the CLI's counts and short lists, and G36 makes a
 * run only when the checks completed; a job that failed stores no run, only a code on the job). A later run
 * does not close a finding when its summary says `partial`, carries an `error`, lists the finding's check
 * under couldNotCheck (the check never ran, so its silence means nothing), or lists 20 couldNotCheck
 * entries (the summary keeps no more, so the list may be cut off).
 */
async function closedFindings(tx: Tx, draftSite: string, findingIds: string[]): Promise<string[]> {
  if (findingIds.length === 0) return [];
  const rows = await tx`
    select f.id from public.findings f join public.runs r on r.id = f.run_id
    where f.id = any(${findingIds}::uuid[]) and f.site_id = ${draftSite}
      and exists (
        select 1 from public.runs later
        cross join lateral (
          select coalesce(case when jsonb_typeof(later.summary -> 'couldNotCheck') = 'array'
                               then later.summary -> 'couldNotCheck' end, '[]'::jsonb) as skipped) c
        where later.site_id = f.site_id and later.finished_at is not null
          and later.summary ->> 'partial' is distinct from 'true'
          and later.summary ->> 'error' is null
          and jsonb_array_length(c.skipped) < 20
          and not exists (select 1 from jsonb_array_elements(c.skipped) s
                          where s ->> 'id' = f.check_id)
          and later.started_at > r.started_at
          and not exists (select 1 from public.findings g
                          where g.run_id = later.id and g.fingerprint = f.fingerprint))
    order by f.id`;
  return rows.map((r) => r.id as string);
}

/** How many of the ids are findings of this draft's organisation and site that this person can see. */
async function ownFindings(tx: Tx, org: string, site: string, ids: string[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  const [row] = await tx`select count(*)::int as n from public.findings
    where id = any(${unique}::uuid[]) and org_id = ${org} and site_id = ${site}`;
  return row!.n === unique.length;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record one person's choice about one draft. The payload being approved (the draft's, or the edit) is
 * checked against its kind's fixed shape first, and the draft's findings must be its own site's. The
 * decision and the apply job are written in one transaction. A second choice for the same draft (a double
 * click, a colleague at the same moment) meets the unique index on decisions and reports the decision that
 * won; it writes nothing and enqueues nothing.
 */
export async function decide(
  sql: postgres.Sql,
  who: Person,
  draftId: string,
  choice: Choice,
  queue: ApplyQueue,
  options: { confirmClosed?: boolean } = {},
): Promise<DecideResult> {
  if (!UUID.test(draftId)) return { status: "not-found" };
  try {
    return await decideInTransaction(sql, who, draftId, choice, queue, options);
  } catch (error) {
    // The database holds the same shapes as kinds.ts (migration 0005) and sees the exact decimals, where
    // the app sees a parsed double. If it refuses a payload the app passed, that is the payload's
    // problem, not a failure: nothing was recorded (the transaction rolled back).
    const refusal = shapeRefusal(error);
    if (refusal) return { status: "invalid-payload", problems: [refusal] };
    throw error;
  }
}

/** The reason when `error` is the database refusing a payload's shape (23514 from 0005's triggers). */
function shapeRefusal(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== "23514" || typeof message !== "string") return undefined;
  return message.startsWith("the payload does not match the ") ? message : undefined;
}

async function decideInTransaction(
  sql: postgres.Sql,
  who: Person,
  draftId: string,
  choice: Choice,
  queue: ApplyQueue,
  options: { confirmClosed?: boolean },
): Promise<DecideResult> {
  return asPerson(sql, who, async (tx): Promise<DecideResult> => {
    const [draft] = await tx`
      select d.org_id, d.site_id, d.kind, d.payload, d.payload::text as payload_text, d.finding_ids,
        s.decision, s.decided_by
      from public.drafts d join public.draft_state s on s.draft_id = d.id where d.id = ${draftId}`;
    if (!draft) return { status: "not-found" };
    if (draft.decision !== "pending") {
      return { status: "already-decided", decision: draft.decision, decidedBy: draft.decided_by };
    }
    const kind = draft.kind as string;
    const findingIds = draft.finding_ids as string[];
    if (choice.kind !== "decline") {
      if (!isDraftKind(kind)) return { status: "invalid-payload", problems: [`kind ${kind}`] };
      const check = checkDraftPayload(
        kind,
        choice.kind === "edit" ? choice.payload : draft.payload,
      );
      if (!check.ok) return { status: "invalid-payload", problems: check.problems };
      if (!(await ownFindings(tx, draft.org_id, draft.site_id, findingIds))) {
        return {
          status: "invalid-payload",
          problems: ["finding_ids are not this site's findings"],
        };
      }
      if (!options.confirmClosed) {
        const closed = await closedFindings(tx, draft.site_id, findingIds);
        if (closed.length > 0)
          return { status: "confirm-closed-findings", closedFindingIds: closed };
      }
    }
    const decision =
      choice.kind === "approve" ? "approved" : choice.kind === "edit" ? "edited" : "declined";
    const edited = choice.kind === "edit" ? tx.json(choice.payload as postgres.JSONValue) : null;
    const reason = choice.kind === "decline" ? (choice.reason ?? null) : null;
    const [row] = await tx`
      insert into public.decisions (org_id, draft_id, decision, edited_payload, reason, decided_by)
      values (${draft.org_id}, ${draftId}, ${decision}, ${edited}, ${reason}, ${who.userId})
      on conflict (draft_id) where decision in ('approved', 'edited', 'declined') do nothing
      returning id, payload_sha256, edited_payload::text as edited_text`;
    if (!row) {
      const [won] = await tx`
        select decision, decided_by from public.draft_state where draft_id = ${draftId}`;
      return { status: "already-decided", decision: won!.decision, decidedBy: won!.decided_by };
    }
    const decisionId = String(row.id);
    // A weekly client update (X66) is an email draft that sendApprovedUpdates sends once, after this approval.
    // It never becomes an apply job, so the writer cannot send it a second time.
    const [weekly] = await tx`select 1 from public.weekly_updates where draft_id = ${draftId}`;
    if (decision !== "declined" && !weekly) {
      await queue.enqueueApply(tx, {
        orgId: draft.org_id as string,
        draftId,
        decisionId,
        kind,
        payloadText: (row.edited_text ?? draft.payload_text) as string,
        payloadSha256: row.payload_sha256 as string,
      });
    }
    return { status: "recorded", decision, decisionId };
  });
}
