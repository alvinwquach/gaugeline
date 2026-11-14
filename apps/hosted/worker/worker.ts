/**
 * The nightly worker (G36): claims jobs from the queue, runs the public checks with core (never a copy of
 * a check), stores the run the way the runs API does (storeRun), and writes what changed since the site's
 * previous run. Checks never run inside a request: a request times out and dies with its instance, while
 * a job outlives a deploy (its lease ends and another worker takes it).
 *
 *   GAUGELINE_DATABASE_URL=postgres://<app login>@... node --import tsx apps/hosted/worker/worker.ts
 *
 * The login is the app's, never the owner: openWorkerDatabase asks connectionSkipsRls() once, at start-up,
 * outside any transaction, and refuses to start otherwise. Every unit of work runs as service_role.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  buildResult,
  checkSite,
  createFetcher,
  FetchError,
  type Fetcher,
  PROBING_CHECKS,
  type Result,
} from "@gaugeline/core";
import { type Sql, type Tx, withService } from "../lib/api/db.js";
import { storeRun } from "../lib/api/handlers.js";
import { parseUpload, type Upload } from "../lib/api/schema.js";
import { secretsInValue } from "../lib/api/secrets.js";
import { openDatabase } from "../lib/api/startup.js";
import { cleanFindings, cleanReason, fitLimits, settleCrossField, stripNul } from "./clean.js";
import { bounded, DeadlineError, guardFetcher } from "./deadline.js";
import { diffRuns, notRunIn } from "./diff.js";
import { queueMorningDigests, queueRegressionAlert } from "./agent-messages.js";
import { morningCadence } from "./email/cadence.js";
import {
  type MorningDeps,
  MORNING_EVERY_MS,
  morningFromEnv,
  sendMorningEmails,
} from "./email/send.js";
import { deliverDue, type NotifyDeps, notifyDepsFrom, queueRunNotifications } from "./notify.js";
import { runPool } from "./pool.js";
import {
  claimJobs,
  completeJob,
  failJob,
  JOB_DEADLINE_MS,
  type Job,
  releaseExpired,
} from "./queue.js";

/** The consent wording a site owner must have agreed to for probing checks to run. */
export const CONSENT_WORDING_VERSION = "2026-11-12";

/** What the checks are given: the address comes from the site row, never from anything a page said. */
export interface SiteToCheck {
  jobId: string;
  siteId: string;
  url: string;
  /** The job asked for probing checks and the site has current consent. */
  probing: boolean;
  /** Aborts at the job's deadline. A stand-in may watch it; the real checks reach it through their fetcher. */
  signal: AbortSignal;
}

export type RunSite = (site: SiteToCheck) => Promise<Result>;

export interface WorkerDeps {
  sql: Sql;
  now?: () => Date;
  random?: () => number;
  /** Defaults to publicChecks(): core's checkSite through core's fetcher. */
  runSite?: RunSite;
  /** How long the checks of one job may run; JOB_DEADLINE_MS unless a test shortens it. */
  deadlineMs?: number;
  /** Tests only: stands in for queueRunNotifications, to show a failure there never fails the run. */
  queueNotifications?: typeof queueRunNotifications;
  /** Tests only: stands in for queueRegressionAlert, to show a failure there never fails the run. */
  queueAgentMessages?: typeof queueRegressionAlert;
  /** Sends queued notifications (X67). The worker's start-up always sets it (notifyDepsFrom). */
  notify?: NotifyDeps;
}

/** The worker's database: the app login, refused when it could read around row-level security. */
export const openWorkerDatabase = openDatabase;

/**
 * Core's checks for one site, through core's fetcher: GET and HEAD only, private and metadata addresses
 * refused (no allowPrivate, no target exception). Probing checks only when `site.probing`.
 */
export function publicChecks(makeFetcher: () => Fetcher = () => createFetcher()): RunSite {
  return async (site) => {
    const startedAt = new Date();
    const { result, snapshot } = await checkSite({
      address: site.url,
      fetcher: guardFetcher(makeFetcher(), site.signal),
      ownerConsent: site.probing,
    });
    return buildResult({
      url: snapshot.requestedUrl,
      startedAt,
      findings: result.findings,
      passed: result.passed,
      failed: result.failed.map((f) => f.id),
      couldNotCheck: result.couldNotCheck,
      sampled: result.sampled,
    });
  };
}

class LostLease extends Error {}
class Refused extends Error {}

/** A short code for a job row and the log: an error's class or a fetch refusal, never its message. */
function errorCode(e: unknown): { code: string; permanent: boolean } {
  for (let c: unknown = e, i = 0; c instanceof Error && i < 5; c = c.cause, i++) {
    if (c instanceof DeadlineError) return { code: "deadline", permanent: false };
    if (c instanceof FetchError)
      return {
        code: c.reason,
        permanent: c.reason === "private-address-refused" || c.reason === "blocked-address",
      };
  }
  if (e instanceof Refused) return { code: e.message, permanent: true };
  const name = e instanceof Error ? e.name.toLowerCase().replace(/[^a-z0-9_-]/g, "") : "";
  return { code: /^[a-z]/.test(name) ? name.slice(0, 64) : "error", permanent: false };
}

/**
 * The result as the runs API would store it, with page text cleaned and nothing shaped like a key.
 *
 * A NUL byte or a key-shaped string in a title, an evidence line, an address or a reason is page text, so
 * it is cleaned (clean.ts), not a reason to lose the night; the run notes how many fields were touched
 * (`redactedFields`, a count only). The fingerprint is core's, taken from the finding before cleaning.
 * An address over the table's limit is cut and an empty title replaced before parseUpload (fitLimits), so
 * neither can refuse the night. The last scan is the runs API's, unchanged: key shapes in every decoded
 * string, never the worker's own environment. Some leak detectors read context from the joined text, so
 * what that scan still matches after per-field cleaning is dropped in steps (settleCrossField) and
 * counted, instead of refusing the run. A refusal is left only for what dropping page text cannot fix.
 */
export function toUpload(result: Result): Upload {
  const clean = fitLimits(stripNul(result));
  let reasons = 0;
  clean.couldNotCheck = clean.couldNotCheck.map((c) => {
    const reason = cleanReason(c.reason);
    reasons += Number(reason.touched);
    return { ...c, reason: reason.text };
  });
  const parsed = parseUpload(clean);
  if (!parsed.ok) throw new Refused("invalid-result");
  const upload = parsed.value;
  const redacted = cleanFindings(upload) + reasons + settleCrossField(upload);
  if (redacted > 0) upload.summary.redactedFields = redacted;
  if (secretsInValue(upload).length > 0) throw new Refused("secret-in-result");
  return upload;
}

/** The result as if the probing checks had not been asked for: no finding of theirs, each one listed as not run. */
function withoutProbing(result: Result, siteUrl: string): Result {
  const probing = new Set<string>(PROBING_CHECKS);
  return {
    ...result,
    findings: result.findings.filter((f) => !probing.has(f.checkId)),
    passed: result.passed.filter((id) => !probing.has(id)),
    failed: result.failed.filter((id) => !probing.has(id)),
    couldNotCheck: [
      ...result.couldNotCheck.filter((c) => !probing.has(c.id)),
      ...[...PROBING_CHECKS].sort().map((id) => ({
        id,
        reason:
          "Probing checks need the site owner's current consent on record; there is none, so they were not run.",
        url: siteUrl,
      })),
    ],
  };
}

/** Whether the site has consent on record for the wording the worker knows. */
const consentedNow = async (tx: Tx, siteId: string): Promise<boolean> =>
  (
    await tx`select exists (
        select 1 from public.site_consent_current c
        where c.site_id = ${siteId} and c.wording_version = ${CONSENT_WORDING_VERSION}
      ) as consented`
  )[0]!.consented === true;

/**
 * Run one claimed job to its end. Never throws: a failure is recorded on the job.
 *
 * "skipped" is a job whose site was paused after the job was queued: it ends as `done` with no run, and the
 * site is not requested.
 */
export async function processJob(
  deps: WorkerDeps,
  job: Job,
): Promise<"done" | "skipped" | "queued" | "failed" | "lost"> {
  const clock = deps.now ?? (() => new Date());
  const { sql } = deps;
  try {
    const rows = await withService(
      sql,
      (tx) => tx`select s.url, s.active, exists (
          select 1 from public.site_consent_current c
          where c.site_id = s.id and c.wording_version = ${CONSENT_WORDING_VERSION}
        ) as consented
        from public.sites s where s.id = ${job.siteId}`,
    );
    const site = rows[0];
    if (!site) throw new Refused("site-gone");
    if (site.active !== true)
      return (await withService(sql, (tx) => completeJob(tx, job, clock(), null)))
        ? "skipped"
        : "lost";
    const probing = job.probing && site.consented === true;
    const runSite = deps.runSite ?? publicChecks();
    // The checks have until the deadline, which is well under the lease: past it the job's slot is freed
    // and its fetcher stops, so a slow site cannot outlive the claim and be run twice.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), deps.deadlineMs ?? JOB_DEADLINE_MS);
    let result: Result;
    try {
      result = await bounded(stop.signal, () =>
        runSite({
          jobId: job.id,
          siteId: job.siteId,
          url: site.url as string,
          probing,
          signal: stop.signal,
        }),
      );
    } finally {
      clearTimeout(timer);
    }

    await withService(sql, async (tx) => {
      // Consent is read again here, in the transaction that stores the run: one withdrawn while the checks
      // ran keeps its probing findings out of the run.
      const keepProbing = probing && (await consentedNow(tx, job.siteId));
      const upload = toUpload(
        job.probing && !keepProbing ? withoutProbing(result, site.url as string) : result,
      );
      const hash = createHash("sha256").update(JSON.stringify(upload)).digest("hex");
      const stored = await storeRun(
        tx,
        { orgId: job.orgId, siteId: job.siteId },
        upload,
        null,
        hash,
      );
      if (stored.kind !== "created") throw new Error("the run was not created");
      // Ours only while the claim is: another worker that took the job after our lease ended wins.
      if (!(await completeJob(tx, job, clock(), stored.id))) throw new LostLease();
      // The previous run is the last one a worker made for this site. An upload from the customer's CI is
      // never "last night": its time is the customer's clock, and it has run other checks.
      const prev = await tx`select r.id, r.summary from public.runs r, public.runs cur
        where cur.id = ${stored.id} and r.site_id = cur.site_id and r.id <> cur.id
          and (r.started_at, r.id) < (cur.started_at, cur.id)
          and exists (select 1 from public.jobs j
            where j.run_id = r.id and j.site_id = r.site_id and j.status = 'done')
        order by r.started_at desc, r.id desc limit 1`;
      const previousRunId = (prev[0]?.id as string | undefined) ?? null;
      const before = previousRunId
        ? (
            await tx`select check_id, fingerprint from public.findings where run_id = ${previousRunId}`
          ).map((r) => ({ checkId: r.check_id as string, fingerprint: r.fingerprint as string }))
        : [];
      const d = diffRuns(
        { findings: before, notRun: notRunIn(prev[0]?.summary) },
        { findings: upload.findings, notRun: notRunIn(upload.summary) },
      );
      // An unchanged site gets no row, so it gets no message.
      if (d.opened.length + d.closed.length > 0)
        await tx`insert into public.run_changes (org_id, site_id, run_id, previous_run_id, opened,
            still_open, closed, opened_fingerprints, closed_fingerprints)
          values (${job.orgId}, ${job.siteId}, ${stored.id}, ${previousRunId}, ${d.opened.length},
            ${d.stillOpen.length}, ${d.closed.length}, ${d.opened}, ${d.closed})`;
      // Notifications (X67) go in the same transaction (an outbox row per matching channel, sent later),
      // inside a savepoint: whatever goes wrong there is rolled back alone and logged as a fixed code; it
      // never fails or rolls back the night's run.
      const queue = deps.queueNotifications ?? queueRunNotifications;
      await tx
        .savepoint((sp) =>
          queue(sp, { orgId: job.orgId, siteId: job.siteId, runId: stored.id, now: clock() }),
        )
        .catch(() => console.error(`worker: job ${job.id} notifications not queued: queue-failed`));
      // An agent's alert (AG-13), in its own savepoint: it queues only when the run got worse than the one
      // before, only for a channel that takes agent messages, and a failure there is as harmless as above.
      const queueAgent = deps.queueAgentMessages ?? queueRegressionAlert;
      await tx
        .savepoint((sp) =>
          queueAgent(sp, { orgId: job.orgId, siteId: job.siteId, runId: stored.id, now: clock() }),
        )
        .catch(() =>
          console.error(`worker: job ${job.id} agent messages not queued: queue-failed`),
        );
    });
    return "done";
  } catch (e) {
    if (e instanceof LostLease) return "lost";
    const { code, permanent } = errorCode(e);
    console.error(`worker: job ${job.id} attempt ${job.attempts} failed: ${code}`);
    try {
      return await failJob(sql, job, clock(), code, {
        permanent,
        ...(deps.random ? { random: deps.random } : {}),
      });
    } catch {
      // The database is away: the lease ends and another worker retries the job.
      return "lost";
    }
  }
}

/** Release expired leases, claim up to `limit` jobs and run them all. Returns how many were claimed. */
export async function workOnce(deps: WorkerDeps, limit = 4): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  await releaseExpired(deps.sql, now);
  const jobs = await claimJobs(deps.sql, limit, now);
  await Promise.all(jobs.map((j) => processJob(deps, j)));
  return jobs.length;
}

/**
 * Work until `signal` aborts, as a pool: at most `limit` jobs run at once, and the moment one finishes its
 * slot claims the next job that is due, so one slow site never holds the others back. When the queue is
 * empty it looks again after `idleMs`. On abort it claims nothing more and waits for the jobs it holds.
 */
export async function runWorker(
  deps: WorkerDeps,
  options: {
    signal: AbortSignal;
    limit?: number;
    idleMs?: number;
    morning?: MorningDeps | null;
    /** For tests: the step run on the morning cadence (sendMorningEmails unless given). */
    morningStep?: (deps: MorningDeps, now: Date) => Promise<unknown>;
    /** For tests: how often the step is due (MORNING_EVERY_MS unless given). */
    morningEveryMs?: number;
    /** For tests: the step that queues the morning digests (queueMorningDigests unless given). */
    agentDigestStep?: (sql: Sql, now: Date) => Promise<unknown>;
  },
): Promise<void> {
  const now = () => (deps.now ?? (() => new Date()))();
  // The morning email (X64): every few minutes, whoever it is morning for. It is started from the claim
  // without being awaited, so it never holds a free slot while a job is due, and a failure never stops the checks.
  // One notification sender at a time, beside the jobs (X67): a slow channel never holds a claim back.
  let sending: Promise<unknown> | undefined;
  const sendDue = () => {
    if (!deps.notify || sending) return;
    sending = deliverDue(deps.notify)
      .catch(() => console.error("notify: sending queued notifications failed"))
      .finally(() => (sending = undefined));
  };
  const morningDeps = options.morning;
  const morning = morningDeps
    ? morningCadence(
        (at) => (options.morningStep ?? sendMorningEmails)(morningDeps, at),
        now,
        options.morningEveryMs ?? MORNING_EVERY_MS,
      )
    : undefined;
  // The morning digest of waiting drafts (AG-14): it only queues rows, on its own cadence and the worker's
  // clock, for the sender above to send. Only when notifications are on at all.
  const digests = deps.notify
    ? morningCadence(
        (at) => (options.agentDigestStep ?? queueMorningDigests)(deps.sql, at),
        now,
        options.morningEveryMs ?? MORNING_EVERY_MS,
        "agent digest",
      )
    : undefined;
  try {
    await runPool({
      signal: options.signal,
      limit: options.limit ?? 4,
      idleMs: options.idleMs ?? 30_000,
      claim: async (free) => {
        morning?.tick();
        digests?.tick();
        sendDue();
        await releaseExpired(deps.sql, now());
        return claimJobs(deps.sql, free, now());
      },
      work: (job) => processJob(deps, job),
    });
  } finally {
    await morning?.settled();
    await digests?.settled();
    // A deploy stops the worker: the send in flight finishes first.
    await sending;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  // A deploy stops the worker: it finishes the jobs it holds, claims no more, and exits.
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => stop.abort());
  openWorkerDatabase(process.env)
    .then(async (sql) => {
      try {
        // The SecretStore is checked before the first job (docs/hosted/secrets.md): a wrong set-up stops here.
        const notify = await notifyDepsFrom(process.env, sql);
        const morning = morningFromEnv(sql, process.env);
        if (!morning) console.error("worker: the morning email is off (RESEND_API_KEY is not set)");
        else if (morning.refusal)
          console.error(
            "worker: the morning email will not send: the sender domain is not configured (set GAUGELINE_EMAIL_FROM)",
          );
        await runWorker({ sql, notify }, { signal: stop.signal, morning });
      } finally {
        await sql.end({ timeout: 5 });
      }
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
