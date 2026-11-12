/**
 * The morning email's two tables (migration 0006): a person reads and changes only their own setting, the
 * send log is the server's alone, the address shape is checked by the database, and removing a member
 * removes their rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
  USER_BOTH,
} from "./harness.js";

describe.skipIf(!HAS_DATABASE)(
  "email settings and the send log: who can read and change what",
  () => {
    let db: TestDatabase;
    let sql: Sql;
    beforeAll(async () => {
      db = await freshDatabase();
      sql = db.sql;
      await seed(sql);
      await sql`insert into public.email_preferences (org_id, user_id, email, email_confirmed_at)
      values (${ORG_A}, ${USER_A_OWNER}, 'owner@mail.example.test', now()),
             (${ORG_A}, ${USER_A_MEMBER}, 'dev@mail.example.test', now())`;
    });
    afterAll(async () => {
      await db?.drop();
    });
    const me = (userId: string) => ({ role: "authenticated" as const, userId });

    it("a person reads only their own row, and can change their setting and time zone but not the address", async () => {
      const own = await as(
        sql,
        me(USER_A_MEMBER),
        (tx) => tx`select user_id, email from public.email_preferences`,
      );
      expect(own).toEqual([{ user_id: USER_A_MEMBER, email: "dev@mail.example.test" }]);
      expect(
        await as(sql, me(USER_A_MEMBER), async (tx) => {
          await tx`update public.email_preferences set frequency = 'fix_first', timezone = 'Europe/London' where user_id = ${USER_A_MEMBER}`;
          return tx`select frequency from public.email_preferences`;
        }),
      ).toEqual([{ frequency: "fix_first" }]);
      for (const column of ["email", "email_confirmed_at", "bounced_at"])
        expect(
          await errorOf(
            as(sql, me(USER_A_MEMBER), (tx) =>
              tx.unsafe(`update public.email_preferences set ${column} = null`),
            ),
          ),
          column,
        ).toMatch(/permission denied/);
    });

    it("nobody changes another person's row, or adds or removes rows; the owner of the organisation cannot read others' addresses", async () => {
      const owner = await as(
        sql,
        me(USER_A_OWNER),
        (tx) => tx`select user_id from public.email_preferences`,
      );
      expect(owner).toEqual([{ user_id: USER_A_OWNER }]);
      const changed = await as(
        sql,
        me(USER_A_OWNER),
        (tx) =>
          tx`update public.email_preferences set frequency = 'off' where user_id = ${USER_A_MEMBER} returning 1`,
      );
      expect(changed).toHaveLength(0);
      expect(
        await errorOf(
          as(
            sql,
            me(USER_A_OWNER),
            (tx) =>
              tx`insert into public.email_preferences (org_id, user_id) values (${ORG_A}, ${USER_A_CLIENT})`,
          ),
        ),
      ).toMatch(/permission denied/);
      expect(
        await errorOf(as(sql, me(USER_A_OWNER), (tx) => tx`delete from public.email_preferences`)),
      ).toMatch(/permission denied/);
    });

    it("the send log is not readable or writable by a signed-in person or by anon", async () => {
      for (const who of [me(USER_A_OWNER), { role: "anon" as const }])
        expect(await errorOf(as(sql, who, (tx) => tx`select * from public.email_sends`))).toMatch(
          /permission denied/,
        );
    });

    it("an address with a line break, or without a domain, is refused by the database", async () => {
      for (const bad of ["a@b.test\r\nBcc: x@y.test", "no-at-sign", "a b@c.test", "a@b"])
        expect(
          await errorOf(
            sql`insert into public.email_preferences (org_id, user_id, email) values (${ORG_B}, ${USER_B_OWNER}, ${bad})`,
          ),
          bad,
        ).toMatch(/email_preferences_email_check/);
    });

    it("removing a member removes their settings and send log", async () => {
      await sql`insert into public.email_preferences (org_id, user_id, email) values (${ORG_A}, ${USER_BOTH}, 'both@mail.example.test')`;
      await sql`insert into public.email_sends (org_id, user_id, local_date, covers_from, covers_to) values (${ORG_A}, ${USER_BOTH}, '2026-11-12', now() - interval '1 day', now())`;
      await sql`delete from public.members where org_id = ${ORG_A} and user_id = ${USER_BOTH}`;
      expect(
        await sql`select 1 from public.email_preferences where user_id = ${USER_BOTH} and org_id = ${ORG_A}`,
      ).toHaveLength(0);
      expect(
        await sql`select 1 from public.email_sends where user_id = ${USER_BOTH} and org_id = ${ORG_A}`,
      ).toHaveLength(0);
    });
  },
);
