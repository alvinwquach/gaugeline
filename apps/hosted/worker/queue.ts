/**
 * The jobs table as a queue (migration 0004). A claim is a lease: one short transaction takes up to n
 * queued rows with FOR UPDATE SKIP LOCKED (rows another worker is claiming at that moment are passed
 * over, not waited for) and marks them running with the claim time and one more attempt. The checks run
 * outside any transaction. A lease older than 15 minutes is a worker that died: the job goes back to
 * the queue. (id, attempts) names one claim, so a worker that lost its lease cannot finish the job.
 *
 * Every query takes `now` from the caller: the worker passes the real clock, the tests a fixed one.
 */
import { type Sql, type Tx, withService } from "../lib/api/db.js";

export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

export interface Job {
  id: string;
  orgId: string;
  siteId: string;
  kind: "nightly" | "manual";
  /** The job asks for probing checks (the worker still needs a current consent row). */
  probing: boolean;
  /** This claim's number: 1 for the first. */
  attempts: number;
}

/**
 * How long to wait before attempt `attempt + 1`: the step doubles each time (1, 2, 4 minutes, capped at
 * 30) and the wait is a random point in its upper half ("equal jitter"), so jobs that failed together
 * do not all come back in the same second.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

/** Claim up to `limit` jobs that are due. */
export async function claimJobs(sql: Sql, limit: number, now: Date): Promise<Job[]> {
  const rows = await withService(
    sql,
    (tx) => tx`with due as (
        select id from public.jobs
        where status = 'queued' and run_after <= ${now}
        order by run_after, id
        for update skip locked
        limit ${limit}
      )
      update public.jobs j set status = 'running', locked_at = ${now}, attempts = j.attempts + 1
      from due where j.id = due.id
      returning j.id, j.org_id, j.site_id, j.kind, j.probing, j.attempts`,
  );
  return rows.map((r) => ({
    id: r.id as string,
    orgId: r.org_id as string,
    siteId: r.site_id as string,
    kind: r.kind as Job["kind"],
    probing: r.probing as boolean,
    attempts: r.attempts as number,
  }));
}

/** Leases older than 15 minutes go back to the queue, or fail when they have had all their attempts. */
export async function releaseExpired(sql: Sql, now: Date): Promise<number> {
  const rows = await withService(
    sql,
    (tx) => tx`update public.jobs
      set status = case when attempts >= ${MAX_ATTEMPTS} then 'failed' else 'queued' end,
        locked_at = null, run_after = ${now}, last_error = 'lease-expired',
        finished_at = case when attempts >= ${MAX_ATTEMPTS} then ${now}::timestamptz end
      where status = 'running' and locked_at < ${new Date(now.getTime() - LEASE_MS)}
      returning id`,
  );
  return rows.length;
}

/**
 * Ends this claim as a success, inside the caller's transaction (the one that writes the run). False
 * when the claim is no longer ours: the transaction must then write nothing.
 */
export async function completeJob(
  tx: Tx,
  job: Job,
  now: Date,
  runId: string | null,
): Promise<boolean> {
  const rows = await tx`update public.jobs
    set status = 'done', locked_at = null, run_id = ${runId}, last_error = null, finished_at = ${now}
    where id = ${job.id} and attempts = ${job.attempts} and status = 'running'
    returning id`;
  return rows.length === 1;
}

/** Ends this claim as a failure: back to the queue after a backoff, or failed for good. */
export async function failJob(
  sql: Sql,
  job: Job,
  now: Date,
  code: string,
  options: { permanent?: boolean; random?: () => number } = {},
): Promise<"queued" | "failed" | "lost"> {
  const last = options.permanent === true || job.attempts >= MAX_ATTEMPTS;
  const next = new Date(now.getTime() + backoffMs(job.attempts, options.random));
  const rows = await withService(
    sql,
    (tx) => tx`update public.jobs
      set status = ${last ? "failed" : "queued"}, locked_at = null, last_error = ${code},
        run_after = ${last ? now : next}, finished_at = ${last ? now : null}
      where id = ${job.id} and attempts = ${job.attempts} and status = 'running'
      returning id`,
  );
  if (rows.length === 0) return "lost";
  return last ? "failed" : "queued";
}
