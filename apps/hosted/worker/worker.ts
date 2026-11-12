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
  sanitise,
  UNTRUSTED_CAPS,
} from "@gaugeline/core";
import { type Sql, withService } from "../lib/api/db.js";
import { storeRun } from "../lib/api/handlers.js";
import { parseUpload, type Upload } from "../lib/api/schema.js";
import { secretsInValue, stringsOf } from "../lib/api/secrets.js";
import { openDatabase } from "../lib/api/startup.js";
import { diffFingerprints } from "./diff.js";
import { claimJobs, completeJob, failJob, type Job, releaseExpired } from "./queue.js";
import {
  type MorningDeps,
  MORNING_EVERY_MS,
  morningFromEnv,
  sendMorningEmails,
} from "./email/send.js";

/** The consent wording a site owner must have agreed to for probing checks to run. */
export const CONSENT_WORDING_VERSION = "2026-11-12";

/** What the checks are given: the address comes from the site row, never from anything a page said. */
export interface SiteToCheck {
  jobId: string;
  siteId: string;
  url: string;
  /** The job asked for probing checks and the site has current consent. */
  probing: boolean;
}

export type RunSite = (site: SiteToCheck) => Promise<Result>;

export interface WorkerDeps {
  sql: Sql;
  now?: () => Date;
  random?: () => number;
  /** Defaults to publicChecks(): core's checkSite through core's fetcher. */
  runSite?: RunSite;
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
      fetcher: makeFetcher(),
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
  for (let c: unknown = e, i = 0; c instanceof Error && i < 5; c = c.cause, i++)
    if (c instanceof FetchError)
      return {
        code: c.reason,
        permanent: c.reason === "private-address-refused" || c.reason === "blocked-address",
      };
  if (e instanceof Refused) return { code: e.message, permanent: true };
  const name = e instanceof Error ? e.name.toLowerCase().replace(/[^a-z0-9_-]/g, "") : "";
  return { code: /^[a-z]/.test(name) ? name.slice(0, 64) : "error", permanent: false };
}

/**
 * The result as the runs API would store it, with page text cleaned (N17) and nothing shaped like a key.
 * The scan is the runs API's: key shapes in every decoded string, never the worker's own environment.
 */
function toUpload(result: Result): Upload {
  if (stringsOf(result).some((x) => x.includes("\u0000"))) throw new Refused("invalid-result");
  const parsed = parseUpload(result);
  if (!parsed.ok) throw new Refused("invalid-result");
  const upload = parsed.value;
  // The fingerprint was taken from the finding as core made it; only the stored words are cleaned.
  upload.findings = upload.findings.map((f) => ({
    ...f,
    title: sanitise(f.title, UNTRUSTED_CAPS.title).text,
    evidence: sanitise(f.evidence, UNTRUSTED_CAPS.evidence).text,
  }));
  if (secretsInValue(upload).length > 0) throw new Refused("secret-in-result");
  return upload;
}

/** Run one claimed job to its end. Never throws: a failure is recorded on the job. */
export async function processJob(
  deps: WorkerDeps,
  job: Job,
): Promise<"done" | "queued" | "failed" | "lost"> {
  const clock = deps.now ?? (() => new Date());
  const { sql } = deps;
  try {
    const rows = await withService(
      sql,
      (tx) => tx`select s.url, exists (
          select 1 from public.site_consent_current c
          where c.site_id = s.id and c.wording_version = ${CONSENT_WORDING_VERSION}
        ) as consented
        from public.sites s where s.id = ${job.siteId}`,
    );
    const site = rows[0];
    if (!site) throw new Refused("site-gone");
    const probing = job.probing && site.consented === true;
    const runSite = deps.runSite ?? publicChecks();
    const result = await runSite({ jobId: job.id, siteId: job.siteId, url: site.url, probing });
    if (job.probing && !probing)
      result.couldNotCheck = [
        ...result.couldNotCheck.filter((c) => !PROBING_CHECKS.includes(c.id)),
        ...[...PROBING_CHECKS].sort().map((id) => ({
          id,
          reason:
            "Probing checks need the site owner's current consent on record; there is none, so they were not run.",
          url: site.url as string,
        })),
      ];
    const upload = toUpload(result);
    const hash = createHash("sha256").update(JSON.stringify(upload)).digest("hex");

    await withService(sql, async (tx) => {
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
      const prev = await tx`select r.id from public.runs r, public.runs cur
        where cur.id = ${stored.id} and r.site_id = cur.site_id and r.id <> cur.id
          and (r.started_at, r.id) < (cur.started_at, cur.id)
        order by r.started_at desc, r.id desc limit 1`;
      const previousRunId = (prev[0]?.id as string | undefined) ?? null;
      const before = previousRunId
        ? (await tx`select fingerprint from public.findings where run_id = ${previousRunId}`).map(
            (r) => r.fingerprint as string,
          )
        : [];
      const d = diffFingerprints(
        before,
        upload.findings.map((f) => f.fingerprint),
      );
      // An unchanged site gets no row, so it gets no message.
      if (d.opened.length + d.closed.length > 0)
        await tx`insert into public.run_changes (org_id, site_id, run_id, previous_run_id, opened,
            still_open, closed, opened_fingerprints, closed_fingerprints)
          values (${job.orgId}, ${job.siteId}, ${stored.id}, ${previousRunId}, ${d.opened.length},
            ${d.stillOpen.length}, ${d.closed.length}, ${d.opened}, ${d.closed})`;
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

/** Release expired leases, claim up to `limit` jobs and run them. Returns how many were claimed. */
export async function workOnce(deps: WorkerDeps, limit = 4): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  await releaseExpired(deps.sql, now);
  const jobs = await claimJobs(deps.sql, limit, now);
  await Promise.all(jobs.map((j) => processJob(deps, j)));
  return jobs.length;
}

/** Work until `signal` aborts: claim, run, and wait `idleMs` when the queue is empty. */
export async function runWorker(
  deps: WorkerDeps,
  options: { signal: AbortSignal; limit?: number; idleMs?: number; morning?: MorningDeps | null },
): Promise<void> {
  const idle = options.idleMs ?? 30_000;
  const clock = deps.now ?? (() => new Date());
  let lastMorning = Number.NEGATIVE_INFINITY;
  while (!options.signal.aborted) {
    // The morning email (X64): every few minutes, whoever it is morning for. A failure never stops the checks.
    if (options.morning && clock().getTime() - lastMorning >= MORNING_EVERY_MS) {
      lastMorning = clock().getTime();
      await sendMorningEmails(options.morning, clock()).catch(() => undefined);
    }
    if ((await workOnce(deps, options.limit)) > 0) continue;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, idle);
      options.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  // A deploy stops the worker: it finishes the jobs it holds, claims no more, and exits.
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => stop.abort());
  openWorkerDatabase(process.env)
    .then(async (sql) => {
      try {
        const morning = morningFromEnv(sql, process.env);
        if (!morning) console.error("worker: the morning email is off (RESEND_API_KEY is not set)");
        await runWorker({ sql }, { signal: stop.signal, morning });
      } finally {
        await sql.end({ timeout: 5 });
      }
    })
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
