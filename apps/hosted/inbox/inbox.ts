/**
 * The drafts inbox (G37). An agent writes a draft; a signed-in person approves it, edits it first, or
 * declines it, once; an approval enqueues one apply job for the customer's own worker. Nothing here writes
 * to a checked system: the apply job's body is the writer package, run by the customer (ADR-0010).
 *
 * Every query runs in a transaction as the signed-in person: `set local role authenticated` with their
 * claims, so row-level security decides what they see and whether they may decide (a client viewer sees no
 * drafts at all). The server checks its login with connectionSkipsRls() once at start-up (db/audit.ts).
 */
import type postgres from "postgres";

type Tx = postgres.TransactionSql;
type Json = Record<string, unknown>;

export interface Person {
  userId: string;
}

export type Choice =
  { kind: "approve" } | { kind: "edit"; payload: Json } | { kind: "decline"; reason?: string };

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
  /** The approved payload: the draft's own, or the edited one. */
  payload: Json;
}

/**
 * Where an approval puts its apply job. The jobs table belongs to G36: its implementation inserts the job
 * in the same transaction as the decision, keyed on the draft id so a retry cannot add a second one.
 */
export interface ApplyQueue {
  enqueueApply(tx: Tx, job: ApplyJob): Promise<void>;
}

/** A stand-in queue for tests and local runs, keyed on the draft id (a Map: one job per draft). */
export class MemoryApplyQueue implements ApplyQueue {
  readonly jobs = new Map<string, ApplyJob>();
  async enqueueApply(_tx: Tx, job: ApplyJob): Promise<void> {
    if (!this.jobs.has(job.draftId)) this.jobs.set(job.draftId, job);
  }
}

export type DecideResult =
  | { status: "recorded"; decision: "approved" | "edited" | "declined"; decisionId: string }
  | { status: "already-decided"; decision: string; decidedBy: string | null }
  | { status: "confirm-closed-findings"; closedFindingIds: string[] }
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
 * The findings a draft fixes that have since closed: a later finished run of the same site no longer
 * reports their fingerprint. Approving such a draft needs a second, confirmed click.
 */
async function closedFindings(tx: Tx, findingIds: string[]): Promise<string[]> {
  if (findingIds.length === 0) return [];
  const rows = await tx`
    select f.id from public.findings f join public.runs r on r.id = f.run_id
    where f.id = any(${findingIds}::uuid[])
      and exists (
        select 1 from public.runs later
        where later.site_id = f.site_id and later.finished_at is not null and later.started_at > r.started_at
          and not exists (select 1 from public.findings g
                          where g.run_id = later.id and g.fingerprint = f.fingerprint))
    order by f.id`;
  return rows.map((r) => r.id as string);
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Record one person's choice about one draft. The decision and the apply job are written in one
 * transaction. A second choice for the same draft (a double click, a colleague at the same moment) meets
 * the unique index on decisions and reports the decision that won; it writes nothing and enqueues nothing.
 */
export async function decide(
  sql: postgres.Sql,
  who: Person,
  draftId: string,
  choice: Choice,
  queue: ApplyQueue,
  options: { confirmClosed?: boolean } = {},
): Promise<DecideResult> {
  if (choice.kind === "edit" && !isObject(choice.payload)) {
    throw new Error("an edited payload must be a JSON object");
  }
  return asPerson(sql, who, async (tx): Promise<DecideResult> => {
    const [draft] = await tx`
      select d.org_id, d.kind, d.payload, d.finding_ids, s.decision, s.decided_by
      from public.drafts d join public.draft_state s on s.draft_id = d.id where d.id = ${draftId}`;
    if (!draft) return { status: "not-found" };
    if (draft.decision !== "pending") {
      return { status: "already-decided", decision: draft.decision, decidedBy: draft.decided_by };
    }
    if (choice.kind !== "decline" && !options.confirmClosed) {
      const closed = await closedFindings(tx, draft.finding_ids as string[]);
      if (closed.length > 0) return { status: "confirm-closed-findings", closedFindingIds: closed };
    }
    const decision =
      choice.kind === "approve" ? "approved" : choice.kind === "edit" ? "edited" : "declined";
    const edited = choice.kind === "edit" ? tx.json(choice.payload as postgres.JSONValue) : null;
    const reason = choice.kind === "decline" ? (choice.reason ?? null) : null;
    const [row] = await tx`
      insert into public.decisions (org_id, draft_id, decision, edited_payload, reason, decided_by)
      values (${draft.org_id}, ${draftId}, ${decision}, ${edited}, ${reason}, ${who.userId})
      on conflict (draft_id) where decision in ('approved', 'edited', 'declined') do nothing
      returning id`;
    if (!row) {
      const [won] = await tx`
        select decision, decided_by from public.draft_state where draft_id = ${draftId}`;
      return { status: "already-decided", decision: won!.decision, decidedBy: won!.decided_by };
    }
    const decisionId = String(row.id);
    if (decision !== "declined") {
      await queue.enqueueApply(tx, {
        orgId: draft.org_id as string,
        draftId,
        decisionId,
        kind: draft.kind as string,
        payload: choice.kind === "edit" ? choice.payload : (draft.payload as Json),
      });
    }
    return { status: "recorded", decision, decisionId };
  });
}
