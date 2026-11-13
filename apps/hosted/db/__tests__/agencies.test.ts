// check-community: allow-email (invented people at reserved example domains: the invite tests need addresses)
/**
 * Agencies (X66), enforced by the database: sites grouped by client, two client viewers who each see only
 * their own site, invites that cannot grant more than the inviter holds, and a weekly update that is recorded
 * as sent only after a person approved it. Every test runs as a user and a role and is rolled back.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
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

// Invented (rule 12). Org A, an agency, has two clients: a bar (SITE_A1) and a pop-up kitchen (SITE_A2).
const CLIENT_BAR = "c1000000-0000-4000-8000-0000000000c1";
const CLIENT_KITCHEN = "c2000000-0000-4000-8000-0000000000c2";
const CLIENT_CLINIC = "c3000000-0000-4000-8000-0000000000c3"; // org B's client
const USER_A_ADMIN = "11111111-0000-4000-8000-000000000003";
const USER_A_CLIENT2 = "33333333-0000-4000-8000-000000000002"; // client viewer of SITE_A2 only
const RUN_A2 = "a2a20000-0000-4000-8000-0000000000a2";
const DRAFT_BAR = "a1d20000-0000-4000-8000-0000000000a1";
const DRAFT_KITCHEN = "a2d20000-0000-4000-8000-0000000000a2";
const DRAFT_PENDING = "a1d30000-0000-4000-8000-0000000000a1";
const UPDATE_BAR = "a1e10000-0000-4000-8000-0000000000a1";
const UPDATE_KITCHEN = "a2e10000-0000-4000-8000-0000000000a2";
const UPDATE_PENDING = "a1e20000-0000-4000-8000-0000000000a1";
const MONDAY = "2026-11-09";
const BAR_TEXT = { subject: "Your site this week", body: "All checked, nothing found." };
const KITCHEN_TEXT = { subject: "Your site this week", body: "One broken link was fixed." };

const sha = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
// Built at run time, so nothing token-shaped sits in the source.
const token = (n: number): string => `glinv_${String(n).repeat(40)}`;

const ownerA = { role: "authenticated" as const, userId: USER_A_OWNER };
const adminA = { role: "authenticated" as const, userId: USER_A_ADMIN };
const memberA = { role: "authenticated" as const, userId: USER_A_MEMBER };
const viewerBar = { role: "authenticated" as const, userId: USER_A_CLIENT };
const viewerKitchen = { role: "authenticated" as const, userId: USER_A_CLIENT2 };
const ownerB = { role: "authenticated" as const, userId: USER_B_OWNER };
const service = { role: "service_role" as const };

async function seedAgency(sql: Sql): Promise<void> {
  await seed(sql);
  const draft = (text: object) => JSON.stringify(text);
  await sql.unsafe(`
    insert into public.members (org_id, user_id, role, site_id) values
      ('${ORG_A}', '${USER_A_ADMIN}', 'admin', null),
      ('${ORG_A}', '${USER_A_CLIENT2}', 'client', '${SITE_A2}');
    insert into public.clients (id, org_id, name) values
      ('${CLIENT_BAR}', '${ORG_A}', 'Tidewater Hospitality'),
      ('${CLIENT_KITCHEN}', '${ORG_A}', 'Juniper Kitchens'),
      ('${CLIENT_CLINIC}', '${ORG_B}', 'Maple Street Health');
    update public.sites set client_id = '${CLIENT_BAR}' where id = '${SITE_A1}';
    update public.sites set client_id = '${CLIENT_KITCHEN}' where id = '${SITE_A2}';
    update public.sites set client_id = '${CLIENT_CLINIC}' where id = '${SITE_B1}';
    insert into public.runs (id, org_id, site_id, started_at, finished_at, summary) values
      ('${RUN_A2}', '${ORG_A}', '${SITE_A2}', '2026-11-10T03:00:00Z', '2026-11-10T03:00:50Z', '{"high":0,"medium":0,"low":1}');
    insert into public.findings (org_id, site_id, run_id, check_id, severity, title, url, fingerprint) values
      ('${ORG_A}', '${SITE_A2}', '${RUN_A2}', 'image-alt', 'low', 'An image has no description', 'https://juniper-popup.test/', '1111111111111111');
    insert into public.drafts (id, org_id, site_id, kind, payload) values
      ('${DRAFT_BAR}', '${ORG_A}', '${SITE_A1}', 'email', '${draft(BAR_TEXT)}'),
      ('${DRAFT_KITCHEN}', '${ORG_A}', '${SITE_A2}', 'email', '${draft(KITCHEN_TEXT)}'),
      ('${DRAFT_PENDING}', '${ORG_A}', '${SITE_A1}', 'email', '${draft(BAR_TEXT)}');
    insert into public.weekly_updates (id, org_id, client_id, week_start, site_ids, subject, body, draft_id) values
      ('${UPDATE_BAR}', '${ORG_A}', '${CLIENT_BAR}', '${MONDAY}', '{${SITE_A1}}', '${BAR_TEXT.subject}', '${BAR_TEXT.body}', '${DRAFT_BAR}'),
      ('${UPDATE_KITCHEN}', '${ORG_A}', '${CLIENT_KITCHEN}', '${MONDAY}', '{${SITE_A2}}', '${KITCHEN_TEXT.subject}', '${KITCHEN_TEXT.body}', '${DRAFT_KITCHEN}'),
      ('${UPDATE_PENDING}', '${ORG_A}', '${CLIENT_BAR}', '2026-11-16', '{${SITE_A1}}', '${BAR_TEXT.subject}', '${BAR_TEXT.body}', '${DRAFT_PENDING}');
    insert into public.decisions (org_id, draft_id, decision, decided_by) values
      ('${ORG_A}', '${DRAFT_BAR}', 'approved', '${USER_A_OWNER}');
    insert into public.decisions (org_id, draft_id, decision, edited_payload, decided_by) values
      ('${ORG_A}', '${DRAFT_KITCHEN}', 'edited', '{"subject":"Your site this week","body":"Fixed: one broken link."}', '${USER_A_MEMBER}');
    insert into public.weekly_update_sends (org_id, update_id, decision_id)
      select '${ORG_A}', u.id, x.id from public.weekly_updates u join public.decisions x on x.draft_id = u.draft_id
      where u.id in ('${UPDATE_BAR}', '${UPDATE_KITCHEN}');
  `);
}

describe.skipIf(!HAS_DATABASE)(
  "hosted database: agencies, client viewers and the weekly update",
  () => {
    let db: TestDatabase;
    let sql: Sql;

    beforeAll(async () => {
      db = await freshDatabase();
      sql = db.sql;
      await seedAgency(sql);
    });
    afterAll(async () => {
      await db?.drop();
    });

    describe("two client viewers each see only their own site", () => {
      for (const [who, own, other] of [
        [viewerBar, SITE_A1, SITE_A2],
        [viewerKitchen, SITE_A2, SITE_A1],
      ] as const) {
        it(`the viewer of ${own} cannot read ${other}'s site, runs, findings, changes or update`, async () => {
          const rows = await as(sql, who, async (tx) => ({
            sites: await tx`select id from public.sites`,
            runs: await tx`select site_id from public.runs`,
            findings: await tx`select site_id from public.findings`,
            changes: await tx`select site_id from public.run_changes`,
            sends: await tx`select site_ids from public.weekly_update_sends`,
          }));
          expect(rows.sites.map((r) => r.id)).toEqual([own]);
          for (const r of [...rows.runs, ...rows.findings, ...rows.changes])
            expect(r.site_id).toBe(own);
          expect(rows.findings.length).toBeGreaterThan(0);
          expect(rows.sends.map((r) => r.site_ids)).toEqual([[own]]);
        });
      }

      it("the viewer reads the text that was approved, never the draft, the inbox or the client list", async () => {
        const rows = await as(sql, viewerKitchen, async (tx) => ({
          sends: await tx`select subject, body from public.weekly_update_sends`,
          updates: await tx`select id from public.weekly_updates`,
          drafts: await tx`select id from public.drafts`,
          decisions: await tx`select id from public.decisions`,
          clients: await tx`select id from public.clients`,
          members: await tx`select user_id from public.members`,
        }));
        expect(rows.sends).toEqual([
          { subject: KITCHEN_TEXT.subject, body: "Fixed: one broken link." },
        ]);
        for (const k of ["updates", "drafts", "decisions", "clients"] as const)
          expect(rows[k], k).toEqual([]);
        expect(rows.members.map((r) => r.user_id)).toEqual([USER_A_CLIENT2]);
      });

      it("a viewer cannot approve or decline a draft, nor record a send", async () => {
        for (const decision of ["approved", "declined"]) {
          const msg = await errorOf(
            as(
              sql,
              viewerBar,
              (tx) => tx`insert into public.decisions (org_id, draft_id, decision, decided_by)
              values (${ORG_A}, ${DRAFT_PENDING}, ${decision}, ${USER_A_CLIENT})`,
            ),
          );
          expect(msg).toMatch(/row-level security/);
        }
        const send = await errorOf(
          as(
            sql,
            viewerBar,
            (tx) => tx`insert into public.weekly_update_sends (org_id, update_id, decision_id)
            values (${ORG_A}, ${UPDATE_PENDING}, 1)`,
          ),
        );
        expect(send).toMatch(/permission denied/);
      });

      it("a viewer cannot raise their own role, move to another site or add themselves elsewhere", async () => {
        const changed = await as(sql, viewerBar, async (tx) => {
          const a =
            await tx`update public.members set role = 'admin', site_id = null where user_id = ${USER_A_CLIENT} returning 1`;
          const b =
            await tx`update public.members set site_id = ${SITE_A2} where user_id = ${USER_A_CLIENT} returning 1`;
          return a.length + b.length;
        });
        expect(changed).toBe(0);
        for (const org of [ORG_A, ORG_B]) {
          const msg = await errorOf(
            as(
              sql,
              viewerBar,
              (tx) =>
                tx`insert into public.members (org_id, user_id, role) values (${org}, ${USER_A_CLIENT}, 'owner')`,
            ),
          );
          expect(msg).toMatch(/row-level security|duplicate key/);
        }
      });

      it("an update is visible to a viewer only when every site it covers is theirs", async () => {
        await rolledBack(sql, async (tx) => {
          await tx`update public.sites set client_id = ${CLIENT_BAR} where id = ${SITE_A2}`;
          const both = { subject: "Your sites this week", body: "Both sites checked." };
          const draft = await tx`insert into public.drafts (org_id, site_id, kind, payload)
          values (${ORG_A}, ${SITE_A1}, 'email', ${tx.json(both)}) returning id`;
          const update = await tx`insert into public.weekly_updates
          (org_id, client_id, week_start, site_ids, subject, body, draft_id)
          values (${ORG_A}, ${CLIENT_BAR}, '2026-11-23', ${[SITE_A1, SITE_A2]}::uuid[], ${both.subject},
            ${both.body}, ${draft[0]!.id}) returning id`;
          const decision =
            await tx`insert into public.decisions (org_id, draft_id, decision, decided_by)
          values (${ORG_A}, ${draft[0]!.id}, 'approved', ${USER_A_OWNER}) returning id`;
          await tx`insert into public.weekly_update_sends (org_id, update_id, decision_id)
          values (${ORG_A}, ${update[0]!.id}, ${decision[0]!.id})`;
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A_CLIENT })}, true)`;
          await tx.unsafe("set local role authenticated");
          const seen = await tx`select subject from public.weekly_update_sends`;
          expect(seen.map((r) => r.subject)).toEqual([BAR_TEXT.subject]);
        });
      });
    });

    describe("an agency sees only its own organisation", () => {
      it("org B's owner sees none of org A's clients, invites, updates or sends", async () => {
        const rows = await as(sql, ownerB, async (tx) => ({
          clients: await tx`select org_id from public.clients`,
          invites: await tx`select org_id from public.invites`,
          updates: await tx`select org_id from public.weekly_updates`,
          sends: await tx`select org_id from public.weekly_update_sends`,
        }));
        expect(rows.clients.map((r) => r.org_id)).toEqual([ORG_B]);
        for (const k of ["invites", "updates", "sends"] as const) expect(rows[k], k).toEqual([]);
      });

      it("org A's staff see their clients, updates and sends (the policies are not simply empty)", async () => {
        const rows = await as(sql, memberA, async (tx) => ({
          clients: await tx`select name from public.clients order by name`,
          updates: await tx`select id from public.weekly_updates`,
          sends: await tx`select update_id from public.weekly_update_sends`,
        }));
        expect(rows.clients.map((r) => r.name)).toEqual([
          "Juniper Kitchens",
          "Tidewater Hospitality",
        ]);
        expect(rows.updates).toHaveLength(3);
        expect(rows.sends).toHaveLength(2);
      });

      it("a site cannot be grouped under another organisation's client, and a member cannot group at all", async () => {
        const cross = await errorOf(
          as(
            sql,
            ownerA,
            (tx) => tx`update public.sites set client_id = ${CLIENT_CLINIC} where id = ${SITE_A1}`,
          ),
        );
        expect(cross).toMatch(/sites_client_fk/);
        const moved = await as(
          sql,
          memberA,
          (tx) =>
            tx`update public.sites set client_id = ${CLIENT_BAR} where id = ${SITE_A2} returning id`,
        );
        expect(moved).toHaveLength(0);
        const theirs = await errorOf(
          as(
            sql,
            ownerA,
            (tx) => tx`insert into public.clients (org_id, name) values (${ORG_B}, 'Stray')`,
          ),
        );
        expect(theirs).toMatch(/row-level security/);
      });
    });

    describe("a site moved from one client to another", () => {
      it("keeps its old updates where they were and joins the new client's next update", async () => {
        await rolledBack(sql, async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A_ADMIN })}, true)`;
          await tx.unsafe("set local role authenticated");
          const moved =
            await tx`update public.sites set client_id = ${CLIENT_BAR} where id = ${SITE_A2} returning id`;
          expect(moved).toHaveLength(1);
          const old =
            await tx`select client_id, site_ids from public.weekly_updates where id = ${UPDATE_KITCHEN}`;
          expect(old[0]).toEqual({ client_id: CLIENT_KITCHEN, site_ids: [SITE_A2] });
          await tx.unsafe("reset role");
          // The kitchen client no longer has that site: an update naming it under the old client is refused.
          const draft = await tx`insert into public.drafts (org_id, site_id, kind, payload)
          values (${ORG_A}, ${SITE_A2}, 'email', ${tx.json(KITCHEN_TEXT)}) returning id`;
          const msg = await errorOf(
            tx.savepoint(
              (
                sp,
              ) => sp`insert into public.weekly_updates (org_id, client_id, week_start, site_ids, subject, body, draft_id)
              values (${ORG_A}, ${CLIENT_KITCHEN}, '2026-11-16', ${[SITE_A2]}::uuid[], ${KITCHEN_TEXT.subject},
                ${KITCHEN_TEXT.body}, ${draft[0]!.id})`,
            ),
          );
          expect(msg).toMatch(/must belong to its client/);
        });
        // The viewer of the moved site still sees the update that was sent for it.
        const seen = await as(
          sql,
          viewerKitchen,
          (tx) => tx`select update_id from public.weekly_update_sends`,
        );
        expect(seen.map((r) => r.update_id)).toEqual([UPDATE_KITCHEN]);
      });
    });

    describe("nothing is sent that a person has not approved", () => {
      it("a pending or declined draft cannot be recorded as sent; an approved one can, once", async () => {
        const pending = await errorOf(
          as(
            sql,
            service,
            (tx) => tx`insert into public.weekly_update_sends (org_id, update_id, decision_id)
            select ${ORG_A}, ${UPDATE_PENDING}, max(id) from public.decisions`,
          ),
        );
        expect(pending).toMatch(/only after a person approves/);
        const declined = await errorOf(
          as(sql, service, async (tx) => {
            const d = await tx`insert into public.decisions (org_id, draft_id, decision, decided_by)
            values (${ORG_A}, ${DRAFT_PENDING}, 'declined', ${USER_A_OWNER}) returning id`;
            await tx`insert into public.weekly_update_sends (org_id, update_id, decision_id)
            values (${ORG_A}, ${UPDATE_PENDING}, ${d[0]!.id})`;
          }),
        );
        expect(declined).toMatch(/only after a person approves/);
        const twice = await errorOf(
          as(
            sql,
            service,
            (tx) => tx`insert into public.weekly_update_sends (org_id, update_id, decision_id)
            select ${ORG_A}, ${UPDATE_BAR}, id from public.decisions where draft_id = ${DRAFT_BAR}`,
          ),
        );
        expect(twice).toMatch(/duplicate key/);
      });

      it("the server cannot choose the sent text, nor reuse another draft's approval", async () => {
        const text = await errorOf(
          as(
            sql,
            service,
            (tx) => tx`insert into public.weekly_update_sends (org_id, update_id, decision_id, body)
            select ${ORG_A}, ${UPDATE_PENDING}, id, 'other words' from public.decisions where draft_id = ${DRAFT_BAR}`,
          ),
        );
        expect(text).toMatch(/permission denied/);
        const borrowed = await errorOf(
          as(
            sql,
            service,
            (tx) => tx`insert into public.weekly_update_sends (org_id, update_id, decision_id)
            select ${ORG_A}, ${UPDATE_PENDING}, id from public.decisions where draft_id = ${DRAFT_BAR}`,
          ),
        );
        expect(borrowed).toMatch(/only after a person approves/);
      });

      it("an update must carry its own draft's text and only its client's sites, never none", async () => {
        const insert = (siteIds: string[], body: string) =>
          errorOf(
            as(
              sql,
              service,
              (
                tx,
              ) => tx`insert into public.weekly_updates (org_id, client_id, week_start, site_ids, subject, body, draft_id)
              values (${ORG_A}, ${CLIENT_BAR}, '2026-11-30', ${siteIds}::uuid[], ${BAR_TEXT.subject}, ${body}, ${DRAFT_PENDING})`,
            ),
          );
        expect(await insert([], BAR_TEXT.body)).toMatch(/at least one site/);
        expect(await insert([SITE_A1, SITE_A2], BAR_TEXT.body)).toMatch(
          /must belong to its client/,
        );
        expect(await insert([SITE_A1, SITE_B1], BAR_TEXT.body)).toMatch(
          /must belong to its client/,
        );
        expect(await insert([SITE_A1], "different words")).toMatch(/its own email draft/);
      });

      it("updates and sends are append-only, for the server and the table owner alike", async () => {
        for (const table of ["weekly_updates", "weekly_update_sends"]) {
          for (const stmt of [
            `update public.${table} set org_id = org_id`,
            `delete from public.${table}`,
          ]) {
            expect(await errorOf(as(sql, service, (tx) => tx.unsafe(stmt)))).toMatch(
              /permission denied/,
            );
            expect(
              await errorOf(rolledBack(sql, async (tx) => void (await tx.unsafe(stmt)))),
            ).toMatch(/append-only/);
          }
        }
      });
    });

    describe("invites, as data", () => {
      const invite = (
        who: typeof ownerA,
        role: string,
        siteId: string | null,
        n: number,
        by = who.userId,
      ) =>
        as(
          sql,
          who,
          (
            tx,
          ) => tx`insert into public.invites (org_id, email, role, site_id, invited_by, token_sha256)
          values (${ORG_A}, 'bar-manager@tidewater-bar.test', ${role}, ${siteId}, ${by}, ${sha(token(n))}) returning id`,
        );

      it("an admin invites a client viewer to one site; nobody invites above their own role", async () => {
        expect(await errorOf(invite(adminA, "client", SITE_A1, 1))).toBe("");
        expect(await errorOf(invite(adminA, "admin", null, 1))).toBe("");
        expect(await errorOf(invite(adminA, "owner", null, 1))).toMatch(/row-level security/);
        expect(await errorOf(invite(memberA, "client", SITE_A1, 1))).toMatch(/row-level security/);
        expect(await errorOf(invite(viewerBar, "client", SITE_A1, 1))).toMatch(
          /row-level security/,
        );
        expect(await errorOf(invite(adminA, "client", SITE_A1, 1, USER_A_OWNER))).toMatch(
          /row-level security/,
        );
        expect(await errorOf(invite(adminA, "client", SITE_B1, 1))).toMatch(/foreign key/);
        expect(await errorOf(invite(adminA, "client", null, 1))).toMatch(/invites_check/);
        expect(await errorOf(invite(ownerB, "client", SITE_A1, 1))).toMatch(/row-level security/);
      });

      it("the token hash, the expiry and the acceptance are never written or read by a signed-in person", async () => {
        expect(
          await errorOf(as(sql, ownerA, (tx) => tx`select token_sha256 from public.invites`)),
        ).toMatch(/permission denied/);
        for (const col of ["expires_at", "accepted_by", "created_at", "id"]) {
          const msg = await errorOf(
            as(sql, ownerA, (tx) => tx.unsafe(`update public.invites set ${col} = ${col}`)),
          );
          expect(msg, col).toMatch(/permission denied/);
        }
        const privileges = await sql`select table_name, column_name, privilege_type, grantee
        from information_schema.column_privileges
        where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
          and privilege_type in ('INSERT', 'UPDATE')
          and table_name in ('clients', 'invites', 'weekly_updates', 'weekly_update_sends')
          and column_name in ('id', 'created_at', 'sent_at', 'expires_at', 'accepted_by', 'accepted_at',
            'subject', 'body', 'site_ids', 'client_id')`;
        expect(
          privileges.filter(
            (p) => !(p.table_name === "weekly_updates" && p.grantee === "service_role"),
          ),
        ).toEqual([]);
      });

      it("accepting: the invited email only, once, before it expires, while the inviter may still grant it", async () => {
        await rolledBack(sql, async (tx) => {
          await tx`insert into public.invites (org_id, email, role, site_id, invited_by, token_sha256)
          values (${ORG_A}, 'bar-manager@tidewater-bar.test', 'client', ${SITE_A1}, ${USER_A_ADMIN}, ${sha(token(2))}),
                 (${ORG_A}, 'bar-manager@tidewater-bar.test', 'client', ${SITE_A1}, ${USER_A_ADMIN}, ${sha(token(3))}),
                 (${ORG_A}, 'bar-manager@tidewater-bar.test', 'admin', null, ${USER_A_ADMIN}, ${sha(token(4))}),
                 (${ORG_A}, 'bar-manager@tidewater-bar.test', 'client', ${SITE_A1}, ${USER_A_ADMIN}, ${sha(token(5))})`;
          await tx`update public.invites set expires_at = now() - interval '1 minute' where token_sha256 = ${sha(token(3))}`;
          await tx`update public.invites set revoked_at = now() where token_sha256 = ${sha(token(5))}`;
          const newcomer = "55555555-0000-4000-8000-000000000001";
          const accept = async (t: string, email: string) =>
            errorOf(
              tx.savepoint(async (sp) => {
                await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: newcomer, email })}, true)`;
                await sp.unsafe("set local role authenticated");
                await sp`select private.accept_invite(${t})`;
                await sp.unsafe("reset role");
              }),
            );
          expect(await accept(token(2), "someone-else@tidewater-bar.test")).toMatch(
            /no longer valid/,
          );
          expect(await accept(token(3), "bar-manager@tidewater-bar.test")).toMatch(
            /no longer valid/,
          );
          expect(await accept(token(5), "bar-manager@tidewater-bar.test")).toMatch(
            /no longer valid/,
          );
          expect(await accept(token(9), "bar-manager@tidewater-bar.test")).toMatch(
            /no longer valid/,
          );
          // The admin who sent the admin invite is now a member: they can no longer grant it.
          await tx`update public.members set role = 'member' where user_id = ${USER_A_ADMIN}`;
          expect(await accept(token(4), "bar-manager@tidewater-bar.test")).toMatch(
            /can no longer grant/,
          );
          await tx`update public.members set role = 'admin' where user_id = ${USER_A_ADMIN}`;
          expect(await accept(token(2), "Bar-Manager@tidewater-bar.test")).toBe("");
          const m = await tx`select role, site_id from public.members where user_id = ${newcomer}`;
          expect(m).toEqual([{ role: "client", site_id: SITE_A1 }]);
          expect(await accept(token(2), "bar-manager@tidewater-bar.test")).toMatch(
            /no longer valid/,
          );
          // A revoked or accepted invite cannot be brought back.
          expect(
            await errorOf(
              tx.savepoint(
                (sp) =>
                  sp`update public.invites set revoked_at = null where token_sha256 = ${sha(token(5))}`,
              ),
            ),
          ).toMatch(/cannot change/);
        });
      });
    });
  },
);
