/**
 * The queue and the worker against a real Postgres: claiming with SKIP LOCKED, leases, retries, the diff
 * by fingerprint and the consent rule. The worker connects as the app's login (not the owner) and works
 * as service_role, as it does in production. The checks are stood in for (a function returning a result)
 * except in the end-to-end test, which runs core's real checks against a fixture site.
 */
import {
  buildResult,
  createFetcher,
  fingerprint,
  PROBING_CHECKS,
  type Result,
} from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  RUN_A1,
  RUN_B1,
  seed,
  SITE_A1,
  SITE_A2,
  SITE_B1,
  type Sql,
  type TestDatabase,
} from "../../db/__tests__/harness.js";
import { appLogin } from "../../app/api/__tests__/app-login.js";
import { claimJobs } from "../queue.js";
import {
  CONSENT_WORDING_VERSION,
  openWorkerDatabase,
  processJob,
  publicChecks,
  type SiteToCheck,
  type WorkerDeps,
  workOnce,
} from "../worker.js";

type Finding = Result["findings"][number];

const T0 = Date.parse("2026-11-12T03:00:00Z");
const at = (minutes: number) => () => new Date(T0 + minutes * 60_000);

const finding = (n: number): Finding => ({
  checkId: "broken-links",
  severity: "high",
  title: `Broken link to the ${n}th menu`,
  evidence: `/menu links to /drinks-${"abcdefghij"[n]} (404)`,
  url: "https://tidewater-bar.test/menu",
});
const fp = (f: Finding) => fingerprint(f);

/** A stand-in for the checks: counts calls per site and returns the findings it is given. */
function standIn(findings: (site: SiteToCheck) => Finding[] = () => []) {
  const calls: SiteToCheck[] = [];
  const runSite = async (site: SiteToCheck): Promise<Result> => {
    calls.push(site);
    return buildResult({
      url: site.url,
      startedAt: new Date(T0 + calls.length * 1000),
      findings: findings(site),
      passed: [],
      failed: [],
    });
  };
  return { calls, runSite };
}

describe.skipIf(!HAS_DATABASE)("nightly queue and worker", () => {
  let db: TestDatabase;
  let owner: Sql;
  let one: Awaited<ReturnType<typeof appLogin>>;
  let two: Awaited<ReturnType<typeof appLogin>>;

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    one = await appLogin(owner);
    two = await appLogin(owner);
  });
  afterAll(async () => {
    await one?.drop();
    await two?.drop();
    await db?.drop();
  });
  beforeEach(async () => {
    await owner`delete from public.jobs`;
    await owner`delete from public.runs where id not in (${RUN_A1}, ${RUN_B1})`;
  });

  async function enqueue(siteId: string, count = 1, over: { probing?: boolean } = {}) {
    const rows = await owner`insert into public.jobs (org_id, site_id, kind, probing, run_after)
      select s.org_id, s.id, 'manual', ${over.probing ?? false}, ${new Date(T0)}
      from public.sites s, generate_series(1, ${count}) where s.id = ${siteId}
      returning id`;
    return rows.map((r) => r.id as string);
  }
  const job = async (id: string) =>
    (
      await owner`select status, attempts, last_error, run_id, locked_at from public.jobs where id = ${id}`
    )[0]!;
  const runsOf = async (siteId: string) =>
    Number(
      (await owner`select count(*)::int as n from public.runs where site_id = ${siteId}`)[0]!.n,
    );

  it("starts only as a login that respects row-level security (asked once, outside a transaction)", async () => {
    await expect(openWorkerDatabase({ GAUGELINE_DATABASE_URL: db.url })).rejects.toThrow(
      /skips row-level security/,
    );
    const sql = await openWorkerDatabase({ GAUGELINE_DATABASE_URL: one.url });
    await sql.end();
  });

  it("two workers, 100 jobs: every job runs exactly once", async () => {
    const ids = await enqueue(SITE_A2, 100);
    const ran = new Map<string, number>();
    const counting = (sql: Sql): WorkerDeps => ({
      sql,
      now: at(1),
      runSite: async (site) => {
        ran.set(site.jobId, (ran.get(site.jobId) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 2));
        return buildResult({
          url: site.url,
          startedAt: new Date(),
          findings: [],
          passed: [],
          failed: [],
        });
      },
    });
    const drain = async (deps: WorkerDeps) => {
      while ((await workOnce(deps, 7)) > 0);
    };
    await Promise.all([drain(counting(one.sql)), drain(counting(two.sql))]);
    expect(ran.size).toBe(100);
    expect([...ran.values()].every((n) => n === 1)).toBe(true);
    expect(new Set(ids)).toEqual(new Set(ran.keys()));
    const states =
      await owner`select status, attempts, count(*)::int as n from public.jobs group by 1, 2`;
    expect(states).toEqual([{ status: "done", attempts: 1, n: 100 }]);
    expect(await runsOf(SITE_A2)).toBe(100);
  });

  it("a worker killed mid-job: the job is retried after the lock expires, and only once", async () => {
    const [id] = await enqueue(SITE_A2);
    // Worker one claims the job and dies before finishing it.
    const [claimed] = await claimJobs(one.sql, 1, new Date(T0));
    expect(claimed!.id).toBe(id);
    const s = standIn();
    // Ten minutes on, the lease still holds: nobody else takes the job.
    expect(await workOnce({ sql: two.sql, now: at(10), runSite: s.runSite })).toBe(0);
    // Sixteen minutes on, it is released and worker two runs it.
    expect(await workOnce({ sql: two.sql, now: at(16), runSite: s.runSite })).toBe(1);
    expect(await job(id!)).toMatchObject({ status: "done", attempts: 2, locked_at: null });
    // Worker one comes back to life and finishes its old claim: it has lost the lease, nothing is written.
    expect(await processJob({ sql: one.sql, now: at(17), runSite: s.runSite }, claimed!)).toBe(
      "lost",
    );
    expect(await runsOf(SITE_A2)).toBe(1);
  });

  it("a job that fails three times is marked failed and does not block the queue", async () => {
    const [bad] = await enqueue(SITE_B1);
    const good = await enqueue(SITE_A2, 3);
    const tries: string[] = [];
    const deps = (minutes: number): WorkerDeps => ({
      sql: one.sql,
      now: at(minutes),
      random: () => 0,
      runSite: async (site) => {
        tries.push(site.siteId);
        if (site.siteId === SITE_B1) throw new TypeError("the checks broke");
        return buildResult({
          url: site.url,
          startedAt: new Date(),
          findings: [],
          passed: [],
          failed: [],
        });
      },
    });
    expect(await workOnce(deps(0), 10)).toBe(4);
    for (const g of good) expect((await job(g)).status).toBe("done");
    expect(await job(bad!)).toMatchObject({
      status: "queued",
      attempts: 1,
      last_error: "typeerror",
    });
    // Backoff: 30 s after the first failure, 60 s after the second (random 0: the low end of the jitter).
    expect(await workOnce(deps(0.25), 10)).toBe(0);
    expect(await workOnce(deps(1), 10)).toBe(1);
    expect(await workOnce(deps(1.5), 10)).toBe(0);
    expect(await workOnce(deps(3), 10)).toBe(1);
    expect(await job(bad!)).toMatchObject({ status: "failed", attempts: 3, locked_at: null });
    expect(await workOnce(deps(60), 10)).toBe(0);
    expect(tries.filter((t) => t === SITE_B1)).toHaveLength(3);
  });

  it("a site whose address is loopback is refused by the fetcher, not retried, and nothing is requested", async () => {
    const site = await startFixture("clean");
    try {
      await owner`update public.sites set url = ${site.origin} where id = ${SITE_A2}`;
      const [id] = await enqueue(SITE_A2);
      // The default checks: core's fetcher with no allowPrivate. The address comes from the site row.
      expect(await workOnce({ sql: one.sql, now: at(0), runSite: publicChecks() })).toBe(1);
      expect(await job(id!)).toMatchObject({
        status: "failed",
        attempts: 1,
        last_error: "blocked-address",
      });
      expect(site.total).toBe(0);
    } finally {
      await owner`update public.sites set url = 'https://juniper-popup.test' where id = ${SITE_A2}`;
      await site.close();
    }
  });

  it("end to end: core's checks run against a site and the run is stored through the runs API's path", async () => {
    const site = await startFixture("clean");
    try {
      await owner`update public.sites set url = ${site.origin} where id = ${SITE_A2}`;
      const [id] = await enqueue(SITE_A2);
      const checks = publicChecks(() => createFetcher({ allowPrivate: true }));
      expect(await workOnce({ sql: one.sql, now: at(0), runSite: checks })).toBe(1);
      const j = await job(id!);
      expect(j.status).toBe("done");
      const run = (
        await owner`select summary from public.runs where id = ${j.run_id as string}`
      )[0]!;
      expect(run.summary).toMatchObject({ schema: 2, url: `${site.origin}/` });
      expect((run.summary as { passed: number }).passed).toBeGreaterThan(10);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await owner`update public.sites set url = 'https://juniper-popup.test' where id = ${SITE_A2}`;
      await site.close();
    }
  });

  describe("the diff by fingerprint", () => {
    const changes = () =>
      owner`select opened, still_open, closed, opened_fingerprints, closed_fingerprints, previous_run_id
        from public.run_changes where site_id = ${SITE_A2} order by created_at, id`;

    it("opened, still open and closed are computed from fingerprints; an unchanged site writes nothing", async () => {
      let night: Finding[] = [finding(1), finding(2)];
      const s = standIn(() => night);
      const deps = (minutes: number): WorkerDeps => ({
        sql: one.sql,
        now: at(minutes),
        runSite: s.runSite,
      });

      await enqueue(SITE_A2);
      await workOnce(deps(0));
      expect(await changes()).toEqual([
        expect.objectContaining({ opened: 2, still_open: 0, closed: 0, previous_run_id: null }),
      ]);

      night = [finding(2), finding(3)];
      await enqueue(SITE_A2);
      await workOnce(deps(1));
      const [, second] = await changes();
      expect(second).toMatchObject({
        opened: 1,
        still_open: 1,
        closed: 1,
        opened_fingerprints: [fp(finding(3))],
        closed_fingerprints: [fp(finding(1))],
      });

      // The same findings (one with a reworded title, which is not part of its identity): no change, no row.
      night = [finding(2), { ...finding(3), title: "Broken link to the 3rd menu, again" }];
      await enqueue(SITE_A2);
      await workOnce(deps(2));
      expect(await changes()).toHaveLength(2);
      expect(await runsOf(SITE_A2)).toBe(3);
    });

    it("page text is stored cleaned: no hidden directives in a title or an evidence line", async () => {
      const hidden = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e); // Unicode tag characters
      const s = standIn(() => [
        { ...finding(4), title: `Menu${hidden} link broken`, evidence: `/menu${hidden} 404` },
      ]);
      const [id] = await enqueue(SITE_A2);
      await workOnce({ sql: one.sql, now: at(0), runSite: s.runSite });
      const runId = (await job(id!)).run_id as string;
      const rows = await owner`select title, evidence from public.findings where run_id = ${runId}`;
      expect(rows).toEqual([{ title: "Menu link broken", evidence: "/menu 404" }]);
    });
  });

  describe("probing checks", () => {
    const run = async (siteId: string, probing: boolean) => {
      const s = standIn();
      const [id] = await enqueue(siteId, 1, { probing });
      await workOnce({ sql: one.sql, now: at(0), runSite: s.runSite });
      const j = await job(id!);
      const summary = (
        await owner`select summary from public.runs where id = ${j.run_id as string}`
      )[0]!.summary as { couldNotCheck: { id: string; reason: string }[] };
      return { asked: s.calls[0]!.probing, couldNotCheck: summary.couldNotCheck.map((c) => c.id) };
    };

    it("are off by default, even with consent on record", async () => {
      // SITE_A1 has a current consent row in the seed.
      expect(await run(SITE_A1, false)).toEqual({ asked: false, couldNotCheck: [] });
    });

    it("run when the job asks and the site has current consent", async () => {
      expect(CONSENT_WORDING_VERSION).toBe("2026-11-12");
      expect((await run(SITE_A1, true)).asked).toBe(true);
    });

    it("are refused without consent, with consent withdrawn, or with consent to older wording", async () => {
      const probing = [...PROBING_CHECKS].sort();
      expect(await run(SITE_A2, true)).toEqual({ asked: false, couldNotCheck: probing });

      await owner`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
        values (${ORG_A}, ${SITE_A2}, 'granted', '2026-01-01', '11111111-0000-4000-8000-000000000001')`;
      expect(await run(SITE_A2, true)).toEqual({ asked: false, couldNotCheck: probing });

      await owner`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
        values (${ORG_A}, ${SITE_A2}, 'granted', ${CONSENT_WORDING_VERSION}, '11111111-0000-4000-8000-000000000001'),
               (${ORG_A}, ${SITE_A2}, 'withdrawn', ${CONSENT_WORDING_VERSION}, '11111111-0000-4000-8000-000000000001')`;
      expect(await run(SITE_A2, true)).toEqual({ asked: false, couldNotCheck: probing });
    });
  });

  it("a deploy during the fan-out (the worker restarts) loses no jobs", async () => {
    const ids = await enqueue(SITE_A2, 20);
    const s = standIn();
    // The old worker finishes 5 jobs, has 5 more claimed when it is stopped, and never comes back.
    await workOnce({ sql: one.sql, now: at(0), runSite: s.runSite }, 5);
    await claimJobs(one.sql, 5, new Date(T0));
    // The new worker starts: it runs what is queued now, and what the old one held once the lease ends.
    const next: WorkerDeps = { sql: two.sql, now: at(1), runSite: s.runSite };
    while ((await workOnce(next, 4)) > 0);
    next.now = at(20);
    while ((await workOnce(next, 4)) > 0);
    const done = await owner`select id from public.jobs where status = 'done'`;
    expect(new Set(done.map((r) => r.id as string))).toEqual(new Set(ids));
    expect(s.calls).toHaveLength(20);
    expect(await runsOf(SITE_A2)).toBe(20);
  });

  it("no secret reaches a job row: an error is stored as its class, never its message", async () => {
    const key = ["sk", "live", "Zx81Qw".repeat(4)].join("_");
    const [id] = await enqueue(SITE_A2);
    await workOnce({
      sql: one.sql,
      now: at(0),
      runSite: async () => {
        throw new Error(`the key ${key} was rejected`);
      },
    });
    const row = await owner`select to_jsonb(j)::text as t from public.jobs j where id = ${id!}`;
    expect(row[0]!.t).not.toContain(key);
    expect((await job(id!)).last_error).toBe("error");
  });
});
