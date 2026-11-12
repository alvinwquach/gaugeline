/**
 * What only shows up with more than one session or more than one login role: which logins the app may
 * use (connectionSkipsRls), and two people removing the last two owners at the same moment.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertConnectionRespectsRls, connectionSkipsRls } from "../audit.js";
import {
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_B,
  seed,
  type Sql,
  TEST_DATABASE_URL,
  type TestDatabase,
  USER_B_OWNER,
  USER_BOTH,
} from "./harness.js";

describe.skipIf(!HAS_DATABASE)("hosted database: sessions and login roles", () => {
  let db: TestDatabase;
  let sql: Sql;
  const suffix = randomBytes(4).toString("hex");
  const role = (name: string) => `gl_${name}_${suffix}`;
  // Invented test-only password for throwaway roles on a throwaway server.
  const password = `pw-${suffix}`;
  const open: Sql[] = [];

  /** A connection to the test database as `user`. */
  const connectAs = (user: string): Sql => {
    const u = new URL(db.url);
    u.username = user;
    u.password = password;
    const c = postgres(u.href, { max: 1, onnotice: () => {} });
    open.push(c);
    return c;
  };

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
    await sql.unsafe(`
      -- Like Supabase's authenticator: a login that can only switch to the two API roles.
      create role ${role("app")} login noinherit password '${password}';
      grant authenticated, service_role to ${role("app")};
      -- A login that is a member of a role owning a table: "set role" would make it the owner.
      create role ${role("tables_owner")} nologin;
      alter table public.runs owner to ${role("tables_owner")};
      create role ${role("owner_member")} login noinherit password '${password}';
      grant ${role("tables_owner")} to ${role("owner_member")};
      -- A login that is a member of a BYPASSRLS role.
      create role ${role("bypass")} nologin bypassrls;
      create role ${role("bypass_member")} login noinherit password '${password}';
      grant ${role("bypass")} to ${role("bypass_member")};
    `);
  });

  afterAll(async () => {
    for (const c of open) await c.end();
    await db?.drop();
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    for (const r of ["app", "owner_member", "tables_owner", "bypass_member", "bypass"]) {
      await admin.unsafe(`drop role if exists ${role(r)}`);
    }
    await admin.end();
  });

  describe("connectionSkipsRls", () => {
    it("a superuser session is reported, also inside set local role authenticated", async () => {
      expect(await connectionSkipsRls(sql)).toBe(true);
      const inside = await sql.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        return connectionSkipsRls(tx);
      });
      expect(inside).toBe(true);
    });

    it("a NOINHERIT login that can only become authenticated or service_role is safe", async () => {
      const app = connectAs(role("app"));
      expect(await connectionSkipsRls(app)).toBe(false);
      await expect(assertConnectionRespectsRls(app)).resolves.toBeUndefined();
      const inside = await app.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        return connectionSkipsRls(tx);
      });
      expect(inside).toBe(false);
    });

    it("a NOINHERIT login that is a member of a table owner's role is reported", async () => {
      const c = connectAs(role("owner_member"));
      expect(await connectionSkipsRls(c)).toBe(true);
      // ... because it really can read as the owner, around every policy:
      const rows = await c.begin(async (tx) => {
        await tx.unsafe(`set local role ${role("tables_owner")}`);
        return tx`select id from public.runs`;
      });
      expect(rows.length).toBe(2);
      expect(await errorOf(assertConnectionRespectsRls(c))).toMatch(/skips row-level security/);
    });

    it("a login that is a member of a BYPASSRLS role (other than service_role) is reported", async () => {
      expect(await connectionSkipsRls(connectAs(role("bypass_member")))).toBe(true);
    });
  });

  describe("the last owner, under concurrency", () => {
    it("two sessions removing the last two owners at once leave one owner", async () => {
      await sql`update public.members set role = 'owner' where org_id = ${ORG_B} and user_id = ${USER_BOTH}`;
      const s1 = postgres(db.url, { max: 1, onnotice: () => {} });
      const s2 = postgres(db.url, { max: 1, onnotice: () => {} });
      open.push(s1, s2);
      let started!: () => void;
      let release!: () => void;
      const startedP = new Promise<void>((r) => (started = r));
      const releaseP = new Promise<void>((r) => (release = r));
      const first = s1.begin(async (tx) => {
        await tx`delete from public.members where org_id = ${ORG_B} and user_id = ${USER_B_OWNER}`;
        started();
        await releaseP;
      });
      await startedP;
      const second = errorOf(
        s2.begin(async (tx) => {
          await tx.unsafe("set local lock_timeout = '20s'");
          await tx`delete from public.members where org_id = ${ORG_B} and user_id = ${USER_BOTH}`;
        }),
      );
      // Give the second session time to reach the trigger (it waits on the organisation's lock).
      await new Promise((r) => setTimeout(r, 300));
      release();
      await first;
      expect(await second).toMatch(/last owner/);
      const owners =
        await sql`select user_id from public.members where org_id = ${ORG_B} and role = 'owner'`;
      expect(owners.map((r) => r.user_id)).toEqual([USER_BOTH]);
    });
  });
});
