/**
 * The outbox kind for an agent's message (0016, AG-13 and AG-14), against a real Postgres: what the new
 * columns and constraints accept and refuse, that the old kinds survive the upgrade, that two organisations
 * never see or point at each other's rows, and that nobody gains a grant (no body column, no write for
 * a signed-in person or for an agent). Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe.skipIf(!HAS_DATABASE)("the agent message outbox kind (0016)", () => {
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
  const roles = async (q: Sql) =>
    (await q`select rolname from pg_roles where rolname !~ '^pg_' order by 1`).map(
      (r) => r.rolname as string,
    );

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
    // The previous version first, with a night's delivery and a test message in it, then 0016 on top.
    db = await freshDatabase({ to: 15 });
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
    await migrate(sql, MIGRATIONS_DIR);
    await sql`insert into public.runs (id, org_id, site_id, started_at, finished_at, summary)
      values (${RUN_A2}, ${ORG_A}, ${SITE_A1}, '2026-11-11T03:00:00Z', '2026-11-11T03:01:00Z', '{}')`;
  });
  afterAll(async () => {
    await db?.drop();
  });

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
    beforeAll(async () => {
      await alert(CHANNEL_B, ORG_B, SITE_B1, RUN_B1);
      await digest(CHANNEL_B, ORG_B, "2026-11-13");
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
        /notification_deliveries_channel_id_org_id_fkey/,
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
        /notification_deliveries_channel_id_org_id_fkey/,
      );
    });
  });

  describe("who writes", () => {
    it("the server's role queues a row and updates only the five delivery columns", async () => {
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
        // Earlier tests queued this very alert for good: the page shows the first one, on a clean outbox.
        await tx`delete from public.notification_deliveries where agent_kind is not null`;
        rows = await tx.unsafe(sqlBlock!);
      });
      expect(JSON.stringify(rows, null, 2)).toBe(output);
    });
  });

  describe("the database's own safety questions", () => {
    it("every table has row-level security", async () => {
      expect(await tablesWithoutRls(sql)).toEqual([]);
    });

    it("adds no table, no function and no role, and no grant to an agent", async () => {
      expect(await tables(sql)).toEqual(before.tables);
      expect(await functions(sql)).toEqual(before.functions);
      expect(await roles(sql)).toEqual(before.roles);
      const grants = await sql`select grantee, table_name, privilege_type
        from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'gaugeline_agent'`;
      expect(grants).toEqual([]);
    });
  });
});
