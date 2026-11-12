/**
 * Tenancy is enforced by the database (G34). Two organisations are seeded; every test runs as a user and a
 * role, the way a Supabase request would, and is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionSkipsRls,
  tablesWithoutOrgId,
  tablesWithoutRls,
  viewsWithoutSecurityInvoker,
} from "../audit.js";
import {
  as,
  DRAFT_A1,
  DRAFT_B1,
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
  USER_BOTH,
} from "./harness.js";

type Tx = Parameters<Parameters<typeof as>[2]>[0];

const TENANT_TABLES = [
  "organisations",
  "members",
  "sites",
  "runs",
  "findings",
  "drafts",
  "decisions",
  "site_consents",
  // Server-only (0003): no grant for anon or authenticated at all.
  "tokens",
  "idempotency_keys",
  // 0004: the queue is server-only; what changed is read like runs.
  "jobs",
  "run_changes",
  // 0006: a person reads and changes their own email setting; the send log is the server's.
  "email_preferences",
  "email_sends",
];

const SERVER_ONLY = new Set(["tokens", "idempotency_keys", "jobs", "email_sends"]);

describe.skipIf(!HAS_DATABASE)("hosted database: row-level security", () => {
  let db: TestDatabase;
  let sql: Sql;

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
  });
  afterAll(async () => {
    await db?.drop();
  });

  const userA = { role: "authenticated" as const, userId: USER_A_MEMBER };
  const ownerA = { role: "authenticated" as const, userId: USER_A_OWNER };
  const client = { role: "authenticated" as const, userId: USER_A_CLIENT };
  const service = { role: "service_role" as const };

  describe("as org A", () => {
    it("selecting org B's sites, runs, findings and drafts returns zero rows", async () => {
      const rows = await as(sql, userA, async (tx) => ({
        sites: await tx`select id from public.sites where org_id = ${ORG_B}`,
        runs: await tx`select id from public.runs where org_id = ${ORG_B}`,
        findings: await tx`select id from public.findings where site_id = ${SITE_B1}`,
        drafts: await tx`select id from public.drafts where id = ${DRAFT_B1}`,
        decisions: await tx`select id from public.decisions where org_id = ${ORG_B}`,
        members: await tx`select user_id from public.members where org_id = ${ORG_B}`,
        organisations: await tx`select org_id from public.organisations where org_id = ${ORG_B}`,
      }));
      for (const [table, r] of Object.entries(rows)) expect(r.length, table).toBe(0);
    });

    it("sees its own organisation's rows (the policies are not simply empty)", async () => {
      const rows = await as(sql, userA, async (tx) => ({
        sites: await tx`select id from public.sites order by name`,
        findings: await tx`select check_id from public.findings`,
        drafts: await tx`select id from public.drafts`,
      }));
      expect(rows.sites.map((r) => r.id)).toEqual([SITE_A2, SITE_A1]);
      expect(rows.findings.map((r) => r.check_id)).toEqual(["broken-links"]);
      expect(rows.drafts.map((r) => r.id)).toEqual([DRAFT_A1]);
    });

    it("inserting a finding with org B's site_id is rejected", async () => {
      // Claiming to be org B: the policy's WITH CHECK refuses it.
      const asB = await errorOf(
        as(
          sql,
          userA,
          (
            tx,
          ) => tx`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
            values (${ORG_B}, ${SITE_B1}, ${RUN_B1}, 'broken-links', 'high', 'x', 'https://maple-physio.test/', '0000000000000000')`,
        ),
      );
      // A signed-in person cannot insert findings at all (uploads come through the server, G35).
      expect(asB).toMatch(/permission denied/);
      // Even the server, which bypasses RLS, cannot pair org A with org B's site: the composite key refuses.
      const mixed = await errorOf(
        as(
          sql,
          service,
          (
            tx,
          ) => tx`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
            values (${ORG_A}, ${SITE_B1}, ${RUN_A1}, 'broken-links', 'high', 'x', 'https://maple-physio.test/', '0000000000000000')`,
        ),
      );
      expect(mixed).toMatch(/foreign key/);
    });

    it("a signed-in member cannot insert runs or findings; the server can, for the right site", async () => {
      for (const attempt of [
        (tx: Tx) =>
          tx`insert into public.runs (org_id, site_id, started_at) values (${ORG_A}, ${SITE_A1}, now())`,
        (tx: Tx) =>
          tx`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
             values (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'broken-links', 'high', 'x', 'https://tidewater-bar.test/', '4444444444444444')`,
      ]) {
        expect(await errorOf(as(sql, userA, attempt))).toMatch(/permission denied/);
      }
      const n = await as(sql, service, async (tx) => {
        await tx`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
          values (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'canonical-missing', 'low', 'No canonical address', 'https://tidewater-bar.test/', '1111111111111111')`;
        return (await tx`select count(*)::int as n from public.findings`)[0]!.n as number;
      });
      expect(n).toBe(3);
    });

    it("cannot update or delete another organisation's site", async () => {
      const result = await as(sql, ownerA, async (tx) => ({
        updated: (await tx`update public.sites set name = 'x' where id = ${SITE_B1} returning id`)
          .length,
        deleted: (await tx`delete from public.sites where id = ${SITE_B1} returning id`).length,
      }));
      expect(result).toEqual({ updated: 0, deleted: 0 });
    });
  });

  describe("a client viewer", () => {
    it("can read their site, cannot read another", async () => {
      const rows = await as(sql, client, async (tx) => ({
        sites: await tx`select id from public.sites`,
        runs: await tx`select id from public.runs`,
        findings: await tx`select site_id from public.findings`,
        drafts: await tx`select id from public.drafts`,
        decisions: await tx`select id from public.decisions`,
        members: await tx`select user_id from public.members`,
      }));
      expect(rows.sites.map((r) => r.id)).toEqual([SITE_A1]);
      expect(rows.runs.map((r) => r.id)).toEqual([RUN_A1]);
      expect(rows.findings.map((r) => r.site_id)).toEqual([SITE_A1]);
      expect(rows.drafts).toHaveLength(0);
      expect(rows.decisions).toHaveLength(0);
      expect(rows.members.map((r) => r.user_id)).toEqual([USER_A_CLIENT]);
    });

    it("cannot insert a finding, a run, a draft, a decision or a consent", async () => {
      const attempts = [
        (tx: Parameters<Parameters<typeof as>[2]>[0]) =>
          tx`insert into public.runs (org_id, site_id, started_at) values (${ORG_A}, ${SITE_A1}, now())`,
        (tx: Parameters<Parameters<typeof as>[2]>[0]) =>
          tx`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
             values (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'broken-links', 'high', 'x', 'https://tidewater-bar.test/', '2222222222222222')`,
        (tx: Parameters<Parameters<typeof as>[2]>[0]) =>
          tx`insert into public.drafts (org_id, site_id, kind, payload) values (${ORG_A}, ${SITE_A1}, 'redirect', '{}')`,
        (tx: Parameters<Parameters<typeof as>[2]>[0]) =>
          tx`insert into public.decisions (org_id, draft_id, decision, decided_by) values (${ORG_A}, ${DRAFT_A1}, 'approved', ${USER_A_CLIENT})`,
        (tx: Parameters<Parameters<typeof as>[2]>[0]) =>
          tx`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
             values (${ORG_A}, ${SITE_A1}, 'granted', '2026-11-12', ${USER_A_CLIENT})`,
      ];
      for (const attempt of attempts) {
        expect(await errorOf(as(sql, client, attempt))).toMatch(
          /row-level security|permission denied/,
        );
      }
    });

    it("cannot change their site", async () => {
      const updated = await as(
        sql,
        client,
        async (tx) =>
          (await tx`update public.sites set name = 'x' where id = ${SITE_A1} returning id`).length,
      );
      expect(updated).toBe(0);
    });
  });

  describe("decisions, site_consents and drafts are append-only", () => {
    for (const table of ["decisions", "site_consents", "drafts"]) {
      it(`UPDATE and DELETE on ${table} fail for the app role and the service role`, async () => {
        for (const who of [ownerA, service]) {
          const upd = await errorOf(
            as(sql, who, (tx) => tx.unsafe(`update public.${table} set org_id = org_id`)),
          );
          const del = await errorOf(as(sql, who, (tx) => tx.unsafe(`delete from public.${table}`)));
          expect(upd, `${who.role} update`).toMatch(/permission denied|append-only/);
          expect(del, `${who.role} delete`).toMatch(/permission denied|append-only/);
        }
      });

      it(`the trigger on ${table} stops even the table owner, and TRUNCATE too`, async () => {
        // The grants already refuse the app and service roles; the trigger is what stops a role that has
        // every privilege. A superuser connection stands in for "a role that could".
        const upd = await errorOf(sql.unsafe(`update public.${table} set org_id = org_id`));
        const del = await errorOf(sql.unsafe(`delete from public.${table}`));
        const trunc = await errorOf(sql.unsafe(`truncate public.${table} cascade`));
        for (const msg of [upd, del, trunc]) expect(msg).toMatch(/append-only/);
      });
    }

    it("a member records a decision as themselves, not as someone else", async () => {
      const ok = await as(sql, userA, async (tx) => {
        await tx`insert into public.decisions (org_id, draft_id, decision, reason, decided_by)
          values (${ORG_A}, ${DRAFT_A1}, 'declined', 'Menu page is being rebuilt', ${USER_A_MEMBER})`;
        return (await tx`select decision from public.draft_state where draft_id = ${DRAFT_A1}`)[0]!
          .decision as string;
      });
      expect(ok).toBe("declined");
      const forged = await errorOf(
        as(
          sql,
          userA,
          (tx) => tx`insert into public.decisions (org_id, draft_id, decision, decided_by)
            values (${ORG_A}, ${DRAFT_A1}, 'approved', ${USER_A_OWNER})`,
        ),
      );
      expect(forged).toMatch(/row-level security/);
    });

    it("the current consent is the latest row: a withdrawal is a new row, not an edit", async () => {
      const states = await as(sql, ownerA, async (tx) => {
        const before = await tx`select site_id from public.site_consent_current`;
        await tx`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
          values (${ORG_A}, ${SITE_A1}, 'withdrawn', '2026-11-12', ${USER_A_OWNER})`;
        const after = await tx`select site_id from public.site_consent_current`;
        const history =
          await tx`select action from public.site_consents where site_id = ${SITE_A1} order by id`;
        return { before, after, history };
      });
      expect(states.before.map((r) => r.site_id)).toEqual([SITE_A1]);
      expect(states.after).toHaveLength(0);
      expect(states.history.map((r) => r.action)).toEqual(["granted", "withdrawn"]);
    });

    it("only an owner or admin records consent; a member cannot", async () => {
      const msg = await errorOf(
        as(
          sql,
          userA,
          (
            tx,
          ) => tx`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
            values (${ORG_A}, ${SITE_A2}, 'granted', '2026-11-12', ${USER_A_MEMBER})`,
        ),
      );
      expect(msg).toMatch(/row-level security/);
    });
  });

  describe("the logs cannot be reordered, backdated or jammed", () => {
    const logs = [
      {
        table: "decisions",
        at: "decided_at",
        cols: `org_id, draft_id, decision, decided_by`,
        vals: (user: string) => `'${ORG_A}', '${DRAFT_A1}', 'approved', '${user}'`,
      },
      {
        table: "site_consents",
        at: "recorded_at",
        cols: `org_id, site_id, action, wording_version, recorded_by`,
        vals: (user: string) => `'${ORG_A}', '${SITE_A2}', 'granted', '2026-11-12', '${user}'`,
      },
    ];
    for (const log of logs) {
      it(`${log.table}: nobody but the owner chooses the id (OVERRIDING SYSTEM VALUE)`, async () => {
        for (const who of [ownerA, service]) {
          const msg = await errorOf(
            as(sql, who, (tx) =>
              tx.unsafe(
                `insert into public.${log.table} (id, ${log.cols}) overriding system value
                 values (9223372036854775000, ${log.vals(USER_A_OWNER)})`,
              ),
            ),
          );
          expect(msg, who.role).toMatch(/permission denied/);
        }
      });

      it(`${log.table}: nobody but the owner sets the time (${log.at})`, async () => {
        for (const who of [ownerA, service]) {
          const msg = await errorOf(
            as(sql, who, (tx) =>
              tx.unsafe(
                `insert into public.${log.table} (${log.at}, ${log.cols})
                 values ('2020-01-01', ${log.vals(USER_A_OWNER)})`,
              ),
            ),
          );
          expect(msg, who.role).toMatch(/permission denied/);
        }
      });

      it(`${log.table}: the shared id sequence cannot be moved, so one tenant cannot jam another`, async () => {
        for (const who of [ownerA, service]) {
          const moved = await errorOf(
            as(sql, who, (tx) =>
              tx.unsafe(`select setval(pg_get_serial_sequence('public.${log.table}', 'id'), 3)`),
            ),
          );
          expect(moved, who.role).toMatch(/permission denied/);
        }
        // Org B's next ordinary insert still works after org A's attempts.
        const ok = await as(sql, { role: "authenticated", userId: USER_B_OWNER }, async (tx) =>
          log.table === "decisions"
            ? tx`insert into public.decisions (org_id, draft_id, decision, decided_by)
                 values (${ORG_B}, ${DRAFT_B1}, 'approved', ${USER_B_OWNER}) returning id`
            : tx`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
                 values (${ORG_B}, ${SITE_B1}, 'granted', '2026-11-12', ${USER_B_OWNER}) returning id`,
        );
        expect(ok).toHaveLength(1);
      });
    }

    it("a withdrawal always wins over an earlier grant (the reviewer's repro)", async () => {
      const current = await as(sql, ownerA, async (tx) => {
        await tx`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
          values (${ORG_A}, ${SITE_A2}, 'granted', '2026-11-12', ${USER_A_OWNER})`;
        await tx`insert into public.site_consents (org_id, site_id, action, wording_version, recorded_by)
          values (${ORG_A}, ${SITE_A2}, 'withdrawn', '2026-11-12', ${USER_A_OWNER})`;
        return tx`select site_id from public.site_consent_current where site_id = ${SITE_A2}`;
      });
      expect(current).toHaveLength(0);
    });

    it("a draft cannot change after it is decided, not even by the server", async () => {
      const msg = await errorOf(
        as(
          sql,
          service,
          (tx) =>
            tx`update public.drafts set payload = '{"to":"https://evil.test/"}' where id = ${DRAFT_A1}`,
        ),
      );
      expect(msg).toMatch(/permission denied|append-only/);
    });

    it("a member creates a draft in their own name only", async () => {
      const own = await as(
        sql,
        userA,
        (tx) =>
          tx`insert into public.drafts (org_id, site_id, kind, payload, created_by)
           values (${ORG_A}, ${SITE_A1}, 'redirect', '{}', ${USER_A_MEMBER}) returning id`,
      );
      expect(own).toHaveLength(1);
      const forged = await errorOf(
        as(
          sql,
          userA,
          (tx) =>
            tx`insert into public.drafts (org_id, site_id, kind, payload, created_by)
             values (${ORG_A}, ${SITE_A1}, 'redirect', '{}', ${USER_A_OWNER})`,
        ),
      );
      expect(forged).toMatch(/row-level security/);
    });
  });

  describe("owners", () => {
    const adminB = { role: "authenticated" as const, userId: USER_BOTH };
    const ownerB = { role: "authenticated" as const, userId: USER_B_OWNER };

    it("an admin cannot make anyone an owner, themselves included", async () => {
      const self = await errorOf(
        as(
          sql,
          adminB,
          (tx) =>
            tx`update public.members set role = 'owner' where org_id = ${ORG_B} and user_id = ${USER_BOTH}`,
        ),
      );
      expect(self).toMatch(/row-level security/);
      const added = await errorOf(
        as(
          sql,
          adminB,
          (tx) =>
            tx`insert into public.members (org_id, user_id, role)
             values (${ORG_B}, '55555555-0000-4000-8000-000000000001', 'owner')`,
        ),
      );
      expect(added).toMatch(/row-level security/);
    });

    it("an admin cannot remove or demote an owner", async () => {
      const r = await as(sql, adminB, async (tx) => ({
        deleted: (
          await tx`delete from public.members where org_id = ${ORG_B} and user_id = ${USER_B_OWNER} returning user_id`
        ).length,
        demoted: (
          await tx`update public.members set role = 'member' where org_id = ${ORG_B} and user_id = ${USER_B_OWNER} returning user_id`
        ).length,
      }));
      expect(r).toEqual({ deleted: 0, demoted: 0 });
    });

    it("the last owner cannot leave or step down; with a second owner they can", async () => {
      const leave = await errorOf(
        as(
          sql,
          ownerB,
          (tx) =>
            tx`delete from public.members where org_id = ${ORG_B} and user_id = ${USER_B_OWNER}`,
        ),
      );
      expect(leave).toMatch(/last owner/);
      const demote = await errorOf(
        as(
          sql,
          ownerB,
          (tx) =>
            tx`update public.members set role = 'admin' where org_id = ${ORG_B} and user_id = ${USER_B_OWNER}`,
        ),
      );
      expect(demote).toMatch(/last owner/);
      const handover = await as(sql, ownerB, async (tx) => {
        await tx`update public.members set role = 'owner' where org_id = ${ORG_B} and user_id = ${USER_BOTH}`;
        return (
          await tx`delete from public.members where org_id = ${ORG_B} and user_id = ${USER_B_OWNER} returning user_id`
        ).length;
      });
      expect(handover).toBe(1);
    });

    it("deleting a whole organisation is not stopped by the last-owner rule", async () => {
      await rolledBack(sql, async (tx) => {
        const org = "0c000000-0000-4000-8000-00000000000c";
        await tx`insert into public.organisations (org_id, name) values (${org}, 'Corner Coaching')`;
        await tx`insert into public.members (org_id, user_id, role)
          values (${org}, '66666666-0000-4000-8000-000000000001', 'owner')`;
        const gone =
          await tx`delete from public.organisations where org_id = ${org} returning org_id`;
        expect(gone).toHaveLength(1);
      });
    });
  });

  describe("edge cases", () => {
    it("a connection that skips row-level security is reported, so the app never queries as the owner", async () => {
      expect(await connectionSkipsRls(sql)).toBe(true);
      // set local role does not hide the session's own role: a superuser session stays a superuser
      // session, so the check still reports it (sessions.test.ts covers the safe login role).
      expect(await as(sql, userA, (tx) => connectionSkipsRls(tx))).toBe(true);
    });

    it("roles get no privilege on sequences, and only SELECT on views", async () => {
      const seq = await sql`select grantee, object_name from information_schema.role_usage_grants
        where object_schema = 'public' and object_type = 'SEQUENCE'
          and grantee in ('anon', 'authenticated', 'service_role')`;
      expect(seq).toEqual([]);
      const seqUpdate =
        await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'S'
          and (has_sequence_privilege('authenticated', c.oid, 'UPDATE')
            or has_sequence_privilege('service_role', c.oid, 'UPDATE')
            or has_sequence_privilege('service_role', c.oid, 'USAGE'))`;
      expect(seqUpdate).toEqual([]);
      const views =
        await sql`select table_name, grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name in ('draft_state', 'site_consent_current')
          and grantee in ('anon', 'authenticated', 'service_role') and privilege_type <> 'SELECT'`;
      expect(views).toEqual([]);
    });

    it("every table has row-level security on, an org_id column, and is one the tests know", async () => {
      expect(await tablesWithoutRls(sql)).toEqual([]);
      expect(await tablesWithoutOrgId(sql)).toEqual([]);
      const tables =
        await sql`select tablename from pg_tables where schemaname = 'public' order by 1`;
      expect(tables.map((r) => r.tablename).sort()).toEqual([...TENANT_TABLES].sort());
    });

    it("every view runs with the caller's rights, so it cannot read around RLS", async () => {
      expect(await viewsWithoutSecurityInvoker(sql)).toEqual([]);
    });

    it("a table added later without RLS is caught by the audit", async () => {
      await rolledBack(sql, async (tx) => {
        await tx.unsafe(
          "create table public.later_added (id int primary key, org_id uuid not null)",
        );
        expect(await tablesWithoutRls(tx)).toEqual(["later_added"]);
        await tx.unsafe("create view public.later_view as select 1 as one");
        expect(await viewsWithoutSecurityInvoker(tx)).toEqual(["later_view"]);
      });
      expect(await tablesWithoutRls(sql)).toEqual([]);
    });

    it("a table added later is not readable by anon or a signed-in user until a migration grants it", async () => {
      await rolledBack(sql, async (tx) => {
        await tx.unsafe("create table public.later_added (id int primary key, org_id uuid)");
        const grants = await tx`select grantee from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'later_added' and grantee in ('anon', 'authenticated')`;
        expect(grants).toHaveLength(0);
      });
    });

    it("a user in two organisations sees both and nothing else", async () => {
      const both = { role: "authenticated" as const, userId: USER_BOTH };
      const rows = await as(sql, both, async (tx) => ({
        orgs: await tx`select org_id from public.organisations order by name`,
        sites: await tx`select id from public.sites order by id`,
      }));
      expect(rows.orgs.map((r) => r.org_id)).toEqual([ORG_B, ORG_A]);
      expect(rows.sites.map((r) => r.id)).toEqual([SITE_A1, SITE_A2, SITE_B1]);
      const ownerB = { role: "authenticated" as const, userId: USER_B_OWNER };
      const bOnly = await as(sql, ownerB, (tx) => tx`select id from public.sites`);
      expect(bOnly.map((r) => r.id)).toEqual([SITE_B1]);
    });

    it("anon and a signed-in stranger see nothing", async () => {
      for (const who of [
        { role: "anon" as const },
        { role: "authenticated" as const, userId: "99999999-0000-4000-8000-000000000009" },
      ]) {
        for (const table of TENANT_TABLES) {
          const msg = await errorOf(
            as(sql, who, async (tx) => {
              const r = await tx.unsafe(`select * from public.${table}`);
              if (r.length > 0) throw new Error(`${who.role} read ${r.length} rows of ${table}`);
            }),
          );
          // anon has no grant at all; a stranger has the grant but RLS returns nothing.
          if (who.role === "anon" || SERVER_ONLY.has(table))
            expect(msg, table).toMatch(/permission denied/);
          else expect(msg, table).toBe("");
        }
      }
    });

    it("findings hold a one-line evidence, never a page: long evidence is refused", async () => {
      const msg = await errorOf(
        as(
          sql,
          service,
          (
            tx,
          ) => tx`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint)
            values (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'broken-links', 'high', 'x', ${"<p>".repeat(400)}, 'https://tidewater-bar.test/', '3333333333333333')`,
        ),
      );
      expect(msg).toMatch(/findings_evidence_check/);
      const columns =
        await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'findings'`;
      expect(columns.map((r) => r.column_name).sort()).toEqual(
        [
          "check_id",
          "created_at",
          "evidence",
          "fingerprint",
          "id",
          "org_id",
          "run_id",
          "severity",
          "site_id",
          "title",
          "url",
        ].sort(),
      );
    });

    it("the indexes the spec names exist", async () => {
      const idx = await sql`select indexname, indexdef from pg_indexes where schemaname = 'public'`;
      const defs = idx.map((r) => String(r.indexdef));
      expect(
        defs.some((d) => /ON public\.findings USING btree \(site_id, fingerprint\)/.test(d)),
      ).toBe(true);
      expect(
        defs.some((d) => /ON public\.runs USING btree \(site_id, started_at DESC\)/.test(d)),
      ).toBe(true);
    });
  });
});
