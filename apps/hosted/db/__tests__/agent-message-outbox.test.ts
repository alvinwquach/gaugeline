/**
 * The outbox kind for an agent's message (0017, AG-13 and AG-14), against a real Postgres: what the new
 * columns and constraints accept and refuse, that the old kinds survive the upgrade, that two organisations
 * never see or point at each other's rows, and that nobody gains a grant (no body column, no write for
 * a signed-in person or for an agent). Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR } from "../migrate.js";
import { tablesWithoutRls } from "../audit.js";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  RUN_A1,
  RUN_B1,
  rolledBack,
  seed,
  SITE_A1,
  SITE_A2,
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
} from "./harness.js";

const CHANNEL_A = "ca000000-0000-4000-8000-0000000000a1"; // Northgate's Slack channel
const CHANNEL_A_SENTRY = "ca000000-0000-4000-8000-0000000000a2";
const CHANNEL_B = "cb000000-0000-4000-8000-0000000000b1"; // Brightfield's Slack channel
const RUN_A2 = "a1a20000-0000-4000-8000-0000000000a2"; // a second night at the same site

describe.skipIf(!HAS_DATABASE)("the agent message outbox kind (0017)", () => {
  let db: TestDatabase;
  let sql: Sql;
  let before: { tables: string[]; functions: string[]; roles: string[] };
  const tables = async (q: Sql) =>
    (
      await q`select tablename from pg_tables where schemaname in ('public', 'private') order by 1`
    ).map((r) => r.tablename as string);
  const functions = async (q: Sql) =>
    (
      await q`select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') order by 1`
    ).map((r) => r.f as string);
  // Roles belong to the whole server, and other test files create theirs (gl_*) at the same time: only the
  // product's own roles are compared.
  const roles = async (q: Sql) =>
    (
      await q`select rolname from pg_roles where rolname ~ '^(gaugeline_|anon|authenticated|service_role)' order by 1`
    ).map((r) => r.rolname as string);

  const service = { role: "service_role" as const };
  const ownerA = { role: "authenticated" as const, userId: USER_A_OWNER };
  const memberA = { role: "authenticated" as const, userId: USER_A_MEMBER };
  const clientA = { role: "authenticated" as const, userId: USER_A_CLIENT };
  const ownerB = { role: "authenticated" as const, userId: USER_B_OWNER };

  const alert = (channel: string, org: string, site: string, run: string) =>
    sql`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id, findings)
      values (${org}, ${channel}, 'agent', ${site}, 'regression-alert', ${run}, 2) returning id`;
  const digest = (channel: string, org: string, day: string) =>
    sql`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date)
      values (${org}, ${channel}, 'agent', 'approvals-digest', ${day}) returning id`;

  beforeAll(async () => {
    // The previous version first, with a night's delivery and a test message in it, then 0017 on top.
    db = await freshDatabase({ to: 16 });
    sql = db.sql;
    await seed(sql);
    await sql`insert into public.notification_channels (id, org_id, kind, label, host, secret_name) values
      (${CHANNEL_A}, ${ORG_A}, 'slack', 'Tidewater alerts', 'hooks.slack.com', 'notify-aaaa0001'),
      (${CHANNEL_A_SENTRY}, ${ORG_A}, 'sentry', 'Tidewater errors', 'o1.ingest.sentry.io', 'notify-aaaa0002'),
      (${CHANNEL_B}, ${ORG_B}, 'slack', 'Physio alerts', 'hooks.slack.com', 'notify-bbbb0001')`;
    await sql`insert into public.notification_deliveries (org_id, channel_id, kind, run_id, site_id, findings)
      values (${ORG_A}, ${CHANNEL_A}, 'run', ${RUN_A1}, ${SITE_A1}, 1)`;
    await sql`insert into public.notification_deliveries (org_id, channel_id, kind) values (${ORG_A}, ${CHANNEL_A}, 'test')`;
    before = {
      tables: await tables(sql),
      functions: await functions(sql),
      roles: await roles(sql),
    };
    // 0017 only: a migration after it (0018, an agent's token expiry) adds its own function, which this
    // file's "adds one trigger function" question must not count.
    await migrate(sql, MIGRATIONS_DIR, { to: 17 });
    await sql`insert into public.runs (id, org_id, site_id, started_at, finished_at, summary)
      values (${RUN_A2}, ${ORG_A}, ${SITE_A1}, '2026-11-11T03:00:00Z', '2026-11-11T03:01:00Z', '{}')`;
  });
  afterAll(async () => {
    await db?.drop();
  });
  // Every test starts with an empty agent outbox and the channels as they were: the rules under test are the
  // database's, and one test's rows (three waiting digests, say) must not decide another's.
  afterEach(async () => {
    await sql`delete from public.notification_deliveries where kind = 'agent'`;
    await sql`update public.notification_channels set agent_messages = false, status = 'active',
      disabled_reason = null, disabled_at = null`;
  });
  const enable = (...ids: string[]) =>
    sql`update public.notification_channels set agent_messages = true where id in ${sql(ids)}`;

  describe("the upgrade", () => {
    it("keeps the rows that were there, and every old kind still works", async () => {
      const rows =
        await sql`select kind, agent_kind, subject_run_id, digest_date from public.notification_deliveries
        order by kind`;
      expect(rows).toEqual([
        { kind: "run", agent_kind: null, subject_run_id: null, digest_date: null },
        { kind: "test", agent_kind: null, subject_run_id: null, digest_date: null },
      ]);
      // A 'run' row still needs its run, and a 'test' row still has none.
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind) values (${ORG_A}, ${CHANNEL_A}, 'run')`,
        ),
      ).toMatch(/notification_deliveries_check/);
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind, run_id, site_id) values (${ORG_A}, ${CHANNEL_A}, 'test', ${RUN_A1}, ${SITE_A1})`,
        ),
      ).toMatch(/notification_deliveries_check/);
    });

    it("leaves a channel that does not take agent messages as it was", async () => {
      expect(
        await sql`select id, agent_messages from public.notification_channels order by id`,
      ).toEqual([
        { id: CHANNEL_A, agent_messages: false },
        { id: CHANNEL_A_SENTRY, agent_messages: false },
        { id: CHANNEL_B, agent_messages: false },
      ]);
    });

    it("holds no column that can carry a message, an address or a recipient", async () => {
      const cols = await sql`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'notification_deliveries' order by 1`;
      expect(cols.map((c) => c.column_name)).toEqual([
        "agent_kind",
        "attempts",
        "channel_id",
        "created_at",
        "digest_date",
        "error_code",
        "findings",
        "http_status",
        "id",
        "kind",
        "locked_at",
        "org_id",
        "run_id",
        "send_after",
        "sent_at",
        "site_id",
        "status",
        "subject_run_id",
      ]);
    });
  });

  describe("what a row may hold", () => {
    beforeEach(async () => {
      await enable(CHANNEL_A);
    });
    it("accepts a regression alert for a run, and a digest for a day", async () => {
      const a = await as(
        sql,
        service,
        (tx) =>
          tx`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id, findings)
          values (${ORG_A}, ${CHANNEL_A}, 'agent', ${SITE_A1}, 'regression-alert', ${RUN_A2}, 2)
          returning status, kind, agent_kind, attempts`,
      );
      expect(a).toEqual([
        { status: "queued", kind: "agent", agent_kind: "regression-alert", attempts: 0 },
      ]);
      const d = await as(
        sql,
        service,
        (tx) =>
          tx`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date)
          values (${ORG_A}, ${CHANNEL_A}, 'agent', 'approvals-digest', '2026-11-13') returning status`,
      );
      expect(d).toEqual([{ status: "queued" }]);
    });

    it("refuses an agent row that does not say which message, or says one it does not know", async () => {
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind) values (${ORG_A}, ${CHANNEL_A}, 'agent')`,
        ),
      ).toMatch(/notification_deliveries_agent_shape/);
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date) values (${ORG_A}, ${CHANNEL_A}, 'agent', 'publish-site', '2026-11-13')`,
        ),
      ).toMatch(/notification_deliveries_agent_kind_known/);
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind) values (${ORG_A}, ${CHANNEL_A}, 'approve')`,
        ),
      ).toMatch(/notification_deliveries_kind_check/);
    });

    it("refuses an agent message on a row of another kind, and the wrong subject for a kind", async () => {
      // agent_kind on a night's run.
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind, run_id, site_id, agent_kind, digest_date)
            values (${ORG_A}, ${CHANNEL_A}, 'run', ${RUN_A2}, ${SITE_A1}, 'approvals-digest', '2026-11-13')`,
        ),
      ).toMatch(/notification_deliveries_agent_shape/);
      // A subject on a test message.
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind, digest_date) values (${ORG_A}, ${CHANNEL_A}, 'test', '2026-11-13')`,
        ),
      ).toMatch(/notification_deliveries_agent_shape/);
      // An alert with no run, or with no site, or with a day.
      for (const [site, run, day] of [
        [SITE_A1, null, null],
        [null, RUN_A2, null],
        [SITE_A1, RUN_A2, "2026-11-13"],
      ] as const)
        expect(
          await errorOf(
            sql`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id, digest_date)
              values (${ORG_A}, ${CHANNEL_A}, 'agent', ${site}, 'regression-alert', ${run}, ${day})`,
          ),
        ).toMatch(/notification_deliveries_agent_shape|notification_deliveries_subject_run_fkey/);
      // A digest with no day, with a run, or with a site.
      for (const [site, run, day] of [
        [null, null, null],
        [null, RUN_A2, "2026-11-13"],
        [SITE_A1, null, "2026-11-13"],
      ] as const)
        expect(
          await errorOf(
            sql`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id, digest_date)
              values (${ORG_A}, ${CHANNEL_A}, 'agent', ${site}, 'approvals-digest', ${run}, ${day})`,
          ),
        ).toMatch(/notification_deliveries_agent_shape/);
    });

    it("is one row per channel and per run, and per channel and per day", async () => {
      await sql`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id)
        values (${ORG_A}, ${CHANNEL_A}, 'agent', ${SITE_A1}, 'regression-alert', ${RUN_A1})`;
      expect(await errorOf(alert(CHANNEL_A, ORG_A, SITE_A1, RUN_A1))).toMatch(
        /notification_deliveries_agent_alert_once/,
      );
      // Queueing it twice is one row, the way the worker does it.
      const again =
        await sql`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id)
        values (${ORG_A}, ${CHANNEL_A}, 'agent', ${SITE_A1}, 'regression-alert', ${RUN_A1})
        on conflict do nothing returning id`;
      expect(again).toHaveLength(0);
      await digest(CHANNEL_A, ORG_A, "2026-11-12");
      expect(await errorOf(digest(CHANNEL_A, ORG_A, "2026-11-12"))).toMatch(
        /notification_deliveries_agent_digest_once/,
      );
      // Another day is another digest, and the night's own 'run' row for the same run does not collide.
      await digest(CHANNEL_A, ORG_A, "2026-11-14");
      expect(
        await sql`select count(*)::int as n from public.notification_deliveries
          where channel_id = ${CHANNEL_A} and (run_id = ${RUN_A1} or subject_run_id = ${RUN_A1})`,
      ).toEqual([{ n: 2 }]);
    });

    it("removes an alert with its run, and every row with its channel", async () => {
      await rolledBack(sql, async (tx) => {
        await tx`insert into public.runs (id, org_id, site_id, started_at, finished_at, summary)
          values ('a1a30000-0000-4000-8000-0000000000a3', ${ORG_A}, ${SITE_A2}, now(), now(), '{}')`;
        await tx`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind, subject_run_id)
          values (${ORG_A}, ${CHANNEL_A}, 'agent', ${SITE_A2}, 'regression-alert', 'a1a30000-0000-4000-8000-0000000000a3')`;
        await tx`delete from public.runs where id = 'a1a30000-0000-4000-8000-0000000000a3'`;
        expect(
          await tx`select 1 from public.notification_deliveries where site_id = ${SITE_A2}`,
        ).toHaveLength(0);
        await tx`delete from public.notification_channels where id = ${CHANNEL_A}`;
        expect(
          await tx`select 1 from public.notification_deliveries where channel_id = ${CHANNEL_A}`,
        ).toHaveLength(0);
      });
    });
  });

  describe("which channels take agent messages", () => {
    it("is off until the owner's server turns it on, and only for Slack", async () => {
      expect(
        await as(
          sql,
          service,
          (tx) =>
            tx`update public.notification_channels set agent_messages = true where id = ${CHANNEL_A} returning agent_messages`,
        ),
      ).toEqual([{ agent_messages: true }]);
      expect(
        await errorOf(
          as(
            sql,
            service,
            (tx) =>
              tx`update public.notification_channels set agent_messages = true where id = ${CHANNEL_A_SENTRY}`,
          ),
        ),
      ).toMatch(/notification_channels_agent_messages_slack/);
    });

    it("is not changed by a signed-in person, whatever their role", async () => {
      for (const who of [ownerA, memberA, clientA])
        expect(
          await errorOf(
            as(
              sql,
              who,
              (tx) =>
                tx`update public.notification_channels set agent_messages = true where id = ${CHANNEL_A}`,
            ),
          ),
        ).toMatch(/permission denied/);
    });
  });

  describe("tenancy", () => {
    beforeEach(async () => {
      await enable(CHANNEL_A, CHANNEL_B);
      await alert(CHANNEL_B, ORG_B, SITE_B1, RUN_B1);
      await digest(CHANNEL_B, ORG_B, "2026-11-13");
      await digest(CHANNEL_A, ORG_A, "2026-11-13");
    });

    it("org A's staff read org A's agent rows and no row of org B", async () => {
      for (const who of [ownerA, memberA]) {
        const rows = await as(
          sql,
          who,
          (tx) =>
            tx`select org_id, kind, agent_kind from public.notification_deliveries where kind = 'agent'`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([ORG_A]));
      }
      expect(
        await as(
          sql,
          ownerA,
          (tx) =>
            tx`select 1 from public.notification_deliveries where channel_id = ${CHANNEL_B} or org_id = ${ORG_B}`,
        ),
      ).toHaveLength(0);
    });

    it("org B's owner reads org B's rows and none of org A's", async () => {
      const rows = await as(
        sql,
        ownerB,
        (tx) =>
          tx`select org_id, agent_kind from public.notification_deliveries order by agent_kind`,
      );
      expect(rows).toEqual([
        { org_id: ORG_B, agent_kind: "approvals-digest" },
        { org_id: ORG_B, agent_kind: "regression-alert" },
      ]);
    });

    it("a client viewer reads none, and anon is refused", async () => {
      expect(
        await as(sql, clientA, (tx) => tx`select 1 from public.notification_deliveries`),
      ).toHaveLength(0);
      expect(
        await errorOf(
          as(sql, { role: "anon" }, (tx) => tx`select 1 from public.notification_deliveries`),
        ),
      ).toMatch(/permission denied/);
    });

    it("a row cannot point at another organisation's channel, run or site", async () => {
      // Org A's rows with org B's channel; org B's with org A's run; org A's alert for org B's site and run.
      expect(await errorOf(alert(CHANNEL_B, ORG_A, SITE_A1, RUN_A2))).toMatch(
        /notification_deliveries_channel_id_org_id_fkey|does not take agent messages/,
      );
      expect(await errorOf(alert(CHANNEL_B, ORG_B, SITE_B1, RUN_A2))).toMatch(
        /notification_deliveries_subject_run_fkey/,
      );
      expect(await errorOf(alert(CHANNEL_A, ORG_A, SITE_B1, RUN_B1))).toMatch(
        /notification_deliveries_subject_run_fkey/,
      );
      expect(await errorOf(alert(CHANNEL_A, ORG_A, SITE_A1, RUN_B1))).toMatch(
        /notification_deliveries_subject_run_fkey/,
      );
      expect(await errorOf(digest(CHANNEL_B, ORG_A, "2026-11-20"))).toMatch(
        /notification_deliveries_channel_id_org_id_fkey|does not take agent messages/,
      );
    });
  });

  describe("who writes", () => {
    beforeEach(async () => {
      await enable(CHANNEL_A);
    });

    it("the server's role queues a row and updates only the eight delivery columns", async () => {
      const queued = await as(sql, service, async (tx) => {
        const [r] =
          await tx`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date)
          values (${ORG_A}, ${CHANNEL_A}, 'agent', 'approvals-digest', '2026-12-01') returning id`;
        await tx`update public.notification_deliveries set status = 'sending', attempts = 1, locked_at = now()
          where id = ${r!.id}`;
        const refused = await errorOf(
          tx`update public.notification_deliveries set agent_kind = 'regression-alert' where id = ${r!.id}`,
        );
        return refused;
      });
      expect(queued).toMatch(/permission denied/);
    });

    it("a signed-in person, anon and an agent can insert, update and delete nothing", async () => {
      for (const who of [
        ownerA,
        memberA,
        clientA,
        { role: "anon" as const },
        { role: "gaugeline_agent" as const },
      ]) {
        const label = who.role + ("userId" in who ? `:${who.userId}` : "");
        for (const stmt of [
          `insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date) values ('${ORG_A}', '${CHANNEL_A}', 'agent', 'approvals-digest', '2026-12-02')`,
          `update public.notification_deliveries set status = 'sent'`,
          `delete from public.notification_deliveries`,
        ])
          expect(await errorOf(as(sql, who, (tx) => tx.unsafe(stmt))), `${label}: ${stmt}`).toMatch(
            /permission denied/,
          );
      }
    });

    it("an agent cannot read the outbox either", async () => {
      expect(
        await errorOf(
          as(
            sql,
            { role: "gaugeline_agent" },
            (tx) => tx`select 1 from public.notification_deliveries`,
          ),
        ),
      ).toMatch(/permission denied/);
      expect(
        await errorOf(
          as(
            sql,
            { role: "gaugeline_agent" },
            (tx) => tx`select agent_messages from public.notification_channels`,
          ),
        ),
      ).toMatch(/permission denied/);
    });
  });

  describe("the database enforces the channel's opt-in", () => {
    const asServer = (fn: Parameters<typeof as>[2]) => as(sql, service, fn);

    it("refuses a row for a channel that does not take agent messages, as every role that may insert", async () => {
      for (const run of [
        () => errorOf(digest(CHANNEL_A, ORG_A, "2026-11-13")),
        () => errorOf(alert(CHANNEL_A, ORG_A, SITE_A1, RUN_A2)),
        () =>
          errorOf(
            asServer(
              (tx) =>
                tx`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date)
                  values (${ORG_A}, ${CHANNEL_A}, 'agent', 'approvals-digest', '2026-11-13')`,
            ),
          ),
      ])
        expect(await run()).toMatch(/the channel does not take agent messages/);
    });

    it("refuses a row for a disabled channel, and for a Sentry project", async () => {
      await enable(CHANNEL_A);
      await sql`update public.notification_channels set status = 'disabled', disabled_reason = 'rejected',
        disabled_at = now() where id = ${CHANNEL_A}`;
      expect(await errorOf(digest(CHANNEL_A, ORG_A, "2026-11-13"))).toMatch(
        /the channel does not take agent messages/,
      );
      expect(
        await errorOf(
          sql`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date)
            values (${ORG_A}, ${CHANNEL_A_SENTRY}, 'agent', 'approvals-digest', '2026-11-13')`,
        ),
      ).toMatch(/the channel does not take agent messages/);
    });

    it("reads the opt-in at the moment of the insert: turned off, nothing more is queued, and what was queued stays", async () => {
      await enable(CHANNEL_A);
      await digest(CHANNEL_A, ORG_A, "2026-11-13");
      await sql`update public.notification_channels set agent_messages = false where id = ${CHANNEL_A}`;
      expect(await errorOf(digest(CHANNEL_A, ORG_A, "2026-11-14"))).toMatch(
        /does not take agent messages/,
      );
      expect(
        await sql`select digest_date::text as d from public.notification_deliveries where kind = 'agent'`,
      ).toEqual([{ d: "2026-11-13" }]);
    });

    it("leaves the other kinds alone: a night's run is queued for a channel that does not take agent messages", async () => {
      await sql`insert into public.notification_deliveries (org_id, channel_id, kind, run_id, site_id)
        values (${ORG_A}, ${CHANNEL_A}, 'run', ${RUN_A2}, ${SITE_A1})`;
      await sql`delete from public.notification_deliveries where run_id = ${RUN_A2}`;
    });
  });

  describe("a digest's day and how many wait", () => {
    beforeEach(async () => {
      await enable(CHANNEL_A);
    });

    it("refuses a day before this table existed and a day past the century, and takes the days between", async () => {
      for (const day of ["2026-10-31", "1999-01-01", "2100-01-01", "9999-12-31"])
        expect(await errorOf(digest(CHANNEL_A, ORG_A, day)), day).toMatch(
          /notification_deliveries_digest_date_sane/,
        );
      for (const day of ["2026-11-01", "2026-11-13", "2099-12-31"])
        expect(await errorOf(digest(CHANNEL_A, ORG_A, day)), day).toBe("");
    });

    // The cap counts the days around the database's own today: the tests take their days from it.
    const day = async (offset: number) =>
      (await sql`select ((now() at time zone 'UTC')::date + ${offset}::int)::text as d`)[0]!
        .d as string;

    it("holds at most three digests waiting for a channel, and takes another once one is sent", async () => {
      const [d0, d1, d2, d3] = [await day(-1), await day(0), await day(1), await day(2)] as [
        string,
        string,
        string,
        string,
      ];
      for (const d of [d0, d1, d2]) await digest(CHANNEL_A, ORG_A, d);
      expect(await errorOf(digest(CHANNEL_A, ORG_A, d3))).toMatch(
        /already has three digests waiting/,
      );
      // Another channel is counted on its own.
      await enable(CHANNEL_B);
      expect(await errorOf(digest(CHANNEL_B, ORG_B, d1))).toBe("");
      // One is claimed and sent: it no longer waits.
      await sql`update public.notification_deliveries set status = 'sending', locked_at = now()
        where digest_date = ${d0}`;
      expect(await errorOf(digest(CHANNEL_A, ORG_A, d3))).toMatch(
        /already has three digests waiting/,
      );
      await sql`update public.notification_deliveries set status = 'sent', sent_at = now(), locked_at = null
        where digest_date = ${d0}`;
      expect(await errorOf(digest(CHANNEL_A, ORG_A, d3))).toBe("");
    });

    it("is not starved by rows dated far from today: three waiting for the end of the century leave today's free", async () => {
      for (const d of ["2099-12-29", "2099-12-30", "2099-12-31"]) await digest(CHANNEL_A, ORG_A, d);
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(0)))).toBe("");
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(1)))).toBe("");
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(-1)))).toBe("");
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(2)))).toMatch(
        /already has three digests waiting/,
      );
      // The far group has its own allowance of three: the three above fill it, a fourth far one is refused,
      // and a row well out of today's window never uses today's.
      expect(await errorOf(digest(CHANNEL_A, ORG_A, "2099-12-28"))).toMatch(
        /already has three digests waiting/,
      );
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(30)))).toMatch(
        /already has three digests waiting/,
      );
    });

    it("counts the days two either side of today as today's group, and a third day out as the far one", async () => {
      // -2, 0 and +2 are the edges of the near group: three of them fill it.
      for (const n of [-2, 0, 2]) await digest(CHANNEL_A, ORG_A, await day(n));
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(1)))).toMatch(
        /already has three digests waiting/,
      );
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(-1)))).toMatch(
        /already has three digests waiting/,
      );
      // -3 and +3 are the far group's, which is empty.
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(-3)))).toBe("");
      expect(await errorOf(digest(CHANNEL_A, ORG_A, await day(3)))).toBe("");
    });

    it("does not cap alerts: each is tied to a real run", async () => {
      await alert(CHANNEL_A, ORG_A, SITE_A1, RUN_A1);
      await alert(CHANNEL_A, ORG_A, SITE_A1, RUN_A2);
      expect(
        await sql`select 1 from public.notification_deliveries where kind = 'agent'`,
      ).toHaveLength(2);
    });
  });

  describe("a row only moves forward", () => {
    beforeEach(async () => {
      await enable(CHANNEL_A);
    });
    const row = async () => (await digest(CHANNEL_A, ORG_A, "2026-11-13"))[0]!.id as string;
    // Committed updates by the schema owner: the trigger runs for every role, and each step sees the last.
    const move = (id: string, set: string) =>
      errorOf(sql.unsafe(`update public.notification_deliveries set ${set} where id = '${id}'`));

    it("is inserted queued and untouched, never already sent, failed, claimed or with a code", async () => {
      for (const cols of [
        "status, sent_at",
        "status",
        "status, locked_at",
        "attempts",
        "http_status",
        "error_code",
      ] as const) {
        const values: Record<string, string> = {
          status: cols.startsWith("status")
            ? cols === "status"
              ? "'failed'"
              : "'sent'"
            : "'queued'",
          sent_at: "now()",
          locked_at: "now()",
          attempts: "1",
          http_status: "200",
          error_code: "'http-200'",
        };
        const names = cols.split(", ");
        const stmt = `insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date, ${names.join(", ")})
          values ('${ORG_A}', '${CHANNEL_A}', 'agent', 'approvals-digest', '2026-11-13', ${names.map((n) => values[n]).join(", ")})`;
        expect(await errorOf(sql.unsafe(stmt)), cols).toMatch(
          /an agent message is queued, not sent/,
        );
      }
    });

    it("goes queued, sending, sent and no further, and not straight from queued to sent", async () => {
      const id = await row();
      expect(await move(id, "status = 'sent', sent_at = now()")).toMatch(
        /only moves forward|is final/,
      );
      expect(await move(id, "status = 'failed'")).toMatch(/only moves forward|is final/);
      expect(await move(id, "status = 'sending', locked_at = now()")).toBe("");
      expect(await move(id, "status = 'sent', sent_at = now(), locked_at = null")).toBe("");
      for (const back of ["queued", "sending", "failed"])
        expect(await move(id, `status = '${back}'`), back).toMatch(/only moves forward|is final/);
    });

    it("makes a sent or failed row final: not rewritten, not even with the status it has", async () => {
      const sent = await row();
      await move(sent, "status = 'sending', locked_at = now()");
      await move(sent, "status = 'sent', sent_at = now(), locked_at = null");
      const failed = (await digest(CHANNEL_A, ORG_A, "2026-11-14"))[0]!.id as string;
      await move(failed, "status = 'sending', locked_at = now()");
      await move(failed, "status = 'failed', error_code = 'http-500', locked_at = null");
      for (const id of [sent, failed])
        for (const set of [
          "status = status, sent_at = null, attempts = 0",
          "status = status, error_code = null",
          "findings = 99",
          "http_status = 200",
        ])
          expect(await move(id, set), set).toMatch(/is final/);
      expect(
        await sql`select status, attempts, error_code from public.notification_deliveries where id = ${failed}`,
      ).toEqual([{ status: "failed", attempts: 0, error_code: "http-500" }]);
    });

    it("keeps the worker's retry: a claimed row may go back to queued, and a failed one stays failed", async () => {
      const id = await row();
      expect(await move(id, "status = 'sending', locked_at = now()")).toBe("");
      expect(await move(id, "status = 'queued', locked_at = null")).toBe("");
      expect(await move(id, "status = 'sending', locked_at = now()")).toBe("");
      expect(await move(id, "status = 'failed', error_code = 'http-500', locked_at = null")).toBe(
        "",
      );
      expect(await move(id, "status = 'queued'")).toMatch(/only moves forward|is final/);
      expect(await move(id, "status = 'sent', sent_at = now()")).toMatch(
        /only moves forward|is final/,
      );
    });

    it("leaves the other kinds as they were: a night's run may still be written in any order", async () => {
      await sql`insert into public.notification_deliveries (org_id, channel_id, kind, run_id, site_id, status, sent_at)
        values (${ORG_A}, ${CHANNEL_A}, 'run', ${RUN_A2}, ${SITE_A1}, 'sent', now())`;
      await sql`update public.notification_deliveries set status = 'queued', sent_at = null where run_id = ${RUN_A2}`;
      await sql`delete from public.notification_deliveries where run_id = ${RUN_A2}`;
    });
  });

  describe("concurrent inserts and an opt-out cannot race the guard", () => {
    beforeEach(async () => {
      await enable(CHANNEL_A);
    });
    // The second statement is waiting on a lock the first connection holds.
    const blocked = async () => {
      for (let i = 0; i < 400; i++) {
        const w = await sql`select 1 from pg_locks where not granted`;
        if (w.length > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("the second statement never waited for the first");
    };
    const day = async (n: number) =>
      (await sql`select ((now() at time zone 'UTC')::date + ${n}::int)::text as d`)[0]!.d as string;

    it("two inserts at once with two digests waiting leave three, not four", async () => {
      await digest(CHANNEL_A, ORG_A, await day(0));
      await digest(CHANNEL_A, ORG_A, await day(1));
      const [d2, dMinus] = [await day(2), await day(-1)];
      let second: Promise<string> | undefined;
      await sql.begin(async (tx) => {
        await tx`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date)
          values (${ORG_A}, ${CHANNEL_A}, 'agent', 'approvals-digest', ${d2})`;
        // Another connection tries while this one has not committed: it must wait, not count two.
        second = errorOf(digest(CHANNEL_A, ORG_A, dMinus));
        await blocked();
      });
      expect(await second).toMatch(/already has three digests waiting/);
      expect(
        await sql`select count(*)::int as n from public.notification_deliveries where kind = 'agent'`,
      ).toEqual([{ n: 3 }]);
    });

    it("a night's findings and an agent message queued in two transactions at once do not deadlock", async () => {
      // Each transaction queues a 'run' row (a key-share lock on the channel through its foreign key) and then
      // an agent row (the guard locks the channel). With a lock that conflicts with key-share each waits for
      // the other: with for no key update neither does.
      const [runX, runY] = [
        "a1a60000-0000-4000-8000-0000000000c1",
        "a1a60000-0000-4000-8000-0000000000c2",
      ];
      for (const r of [runX, runY])
        await sql`insert into public.runs (id, org_id, site_id, started_at, finished_at, summary)
          values (${r}, ${ORG_A}, ${SITE_A1}, '2026-11-12T03:00:00Z', '2026-11-12T03:01:00Z', '{}')`;
      let arrived = 0;
      let release: () => void = () => {};
      const both = new Promise<void>((r) => (release = r));
      const queueBoth = (run: string, d: string) =>
        sql
          .begin(async (tx) => {
            await tx`insert into public.notification_deliveries (org_id, channel_id, kind, run_id, site_id)
              values (${ORG_A}, ${CHANNEL_A}, 'run', ${run}, ${SITE_A1})`;
            if (++arrived === 2) release();
            await both;
            await tx`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind, digest_date)
              values (${ORG_A}, ${CHANNEL_A}, 'agent', 'approvals-digest', ${d})`;
          })
          .finally(release); // a failure in one never leaves the other waiting at the barrier
      const [one, two] = await Promise.allSettled([
        queueBoth(runX, await day(0)),
        queueBoth(runY, await day(1)),
      ]);
      expect([one, two].map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual([
        "ok",
        "ok",
      ]);
      expect(
        await sql`select kind from public.notification_deliveries where kind = 'agent'`,
      ).toHaveLength(2);
      await sql`delete from public.notification_deliveries where run_id in ${sql([runX, runY])}`;
    });

    it("an insert that is waiting while the channel is turned off is refused, not queued", async () => {
      let second: Promise<string> | undefined;
      await sql.begin(async (tx) => {
        await tx`update public.notification_channels set agent_messages = false where id = ${CHANNEL_A}`;
        second = errorOf(digest(CHANNEL_A, ORG_A, "2026-11-13"));
        await blocked();
      });
      expect(await second).toMatch(/the channel does not take agent messages/);
      expect(
        await sql`select 1 from public.notification_deliveries where kind = 'agent'`,
      ).toHaveLength(0);
    });
  });

  describe("the docs page", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../../../../docs/hosted/notifications.md", import.meta.url)),
      "utf8",
    );
    const sqlBlock = /```sql\n([\s\S]*?)\n```/.exec(page.split("## Agent messages")[1] ?? "")?.[1];
    const output = /```json title=Output\n([\s\S]*?)\n```/.exec(page)?.[1];

    it("shows the row the database returns for the statement it shows", async () => {
      expect(sqlBlock).toBeDefined();
      let rows: unknown;
      await rolledBack(sql, async (tx) => {
        // The page shows two statements: the channel takes agent messages, then the alert is queued.
        const statements = sqlBlock!.split(/;\s*\n\s*(?=\S)/);
        expect(statements).toHaveLength(2);
        for (const st of statements) rows = await tx.unsafe(st);
      });
      expect(JSON.stringify(rows, null, 2)).toBe(output);
    });
  });

  describe("the database's own safety questions", () => {
    it("every table has row-level security", async () => {
      expect(await tablesWithoutRls(sql)).toEqual([]);
    });

    it("adds no table and no role, one trigger function that no role can run, and no grant to an agent", async () => {
      expect(await tables(sql)).toEqual(before.tables);
      expect(await functions(sql)).toEqual(
        [...before.functions, "private.agent_delivery_guard"].sort(),
      );
      const who = await sql`select r.rolname, has_function_privilege(r.rolname,
          'private.agent_delivery_guard()', 'execute') as can
        from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'gaugeline_agent', 'gaugeline_worker')
        order by 1`;
      expect(who.every((r) => r.can === false)).toBe(true);
      expect(await roles(sql)).toEqual(before.roles);
      const grants = await sql`select grantee, table_name, privilege_type
        from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'gaugeline_agent'`;
      expect(grants).toEqual([]);
    });
  });
});
