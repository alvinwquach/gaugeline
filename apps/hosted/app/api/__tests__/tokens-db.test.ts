/** The tables 0003 adds (site tokens, idempotency keys) and the rule for the API's database access. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tablesWithoutOrgId, tablesWithoutRls } from "../../../db/audit.js";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  RUN_A1,
  rolledBack,
  seed,
  SITE_A1,
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_OWNER,
} from "../../../db/__tests__/harness.js";
import { assertServiceRole, withService } from "../../../lib/api/db.js";

const HASH = "a".repeat(64);

describe.skipIf(!HAS_DATABASE)("tokens and idempotency keys: database", () => {
  let db: TestDatabase;
  let sql: Sql;
  const service = { role: "service_role" as const };
  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("both tables have row-level security on (forced) and an org_id", async () => {
    expect(await tablesWithoutRls(sql)).toEqual([]);
    expect(await tablesWithoutOrgId(sql)).toEqual([]);
    const rows = await sql`select relname, relforcerowsecurity from pg_class
      where relname in ('tokens', 'idempotency_keys') order by 1`;
    expect(rows.map((r) => [r.relname, r.relforcerowsecurity])).toEqual([
      ["idempotency_keys", true],
      ["tokens", true],
    ]);
  });

  it("anon and signed-in people cannot read or write either table, so a token hash never reaches a browser", async () => {
    for (const who of [
      { role: "anon" as const },
      { role: "authenticated" as const, userId: USER_A_OWNER },
    ]) {
      for (const table of ["tokens", "idempotency_keys"]) {
        expect(
          await errorOf(as(sql, who, (tx) => tx.unsafe(`select * from public.${table}`))),
          table,
        ).toMatch(/permission denied/);
        expect(
          await errorOf(as(sql, who, (tx) => tx.unsafe(`delete from public.${table}`))),
          table,
        ).toMatch(/permission denied/);
      }
    }
  });

  it("the service role can add a token and revoke it, but not change its hash", async () => {
    await as(sql, service, async (tx) => {
      await tx`insert into public.tokens (org_id, site_id, prefix, token_hash) values (${ORG_A}, ${SITE_A1}, 'deadbeef', ${HASH})`;
      await tx`update public.tokens set revoked_at = now() where prefix = 'deadbeef'`;
    });
    const msg = await errorOf(
      as(sql, service, async (tx) => {
        await tx`insert into public.tokens (org_id, site_id, prefix, token_hash) values (${ORG_A}, ${SITE_A1}, 'deadbee0', ${HASH})`;
        await tx`update public.tokens set token_hash = ${"b".repeat(64)} where prefix = 'deadbee0'`;
      }),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it("refuses a hash that is not 64 hex characters, a repeated prefix, and a site of another organisation", async () => {
    expect(
      await errorOf(
        as(
          sql,
          service,
          (tx) =>
            tx`insert into public.tokens (org_id, site_id, prefix, token_hash) values (${ORG_A}, ${SITE_A1}, 'cafe0001', 'plaintext-token')`,
        ),
      ),
    ).toMatch(/tokens_token_hash_check/);
    expect(
      await errorOf(
        as(
          sql,
          service,
          (tx) =>
            tx`insert into public.tokens (org_id, site_id, prefix, token_hash) values (${ORG_B}, ${SITE_A1}, 'cafe0002', ${HASH})`,
        ),
      ),
    ).toMatch(/foreign key/);
    expect(
      await errorOf(
        as(sql, service, async (tx) => {
          await tx`insert into public.tokens (org_id, site_id, prefix, token_hash) values (${ORG_A}, ${SITE_A1}, 'cafe0003', ${HASH})`;
          await tx`insert into public.tokens (org_id, site_id, prefix, token_hash) values (${ORG_B}, ${SITE_B1}, 'cafe0003', ${HASH})`;
        }),
      ),
    ).toMatch(/duplicate key|tokens_prefix/);
  });

  it("an idempotency key is unique per site, and goes with its run", async () => {
    const msg = await errorOf(
      as(sql, service, async (tx) => {
        await tx`insert into public.idempotency_keys (org_id, site_id, key, request_hash, run_id) values (${ORG_A}, ${SITE_A1}, 'k1', ${HASH}, ${RUN_A1})`;
        await tx`insert into public.idempotency_keys (org_id, site_id, key, request_hash, run_id) values (${ORG_A}, ${SITE_A1}, 'k1', ${HASH}, ${RUN_A1})`;
      }),
    );
    expect(msg).toMatch(/duplicate key/);
  });

  it("deleting a site removes its tokens", async () => {
    await rolledBack(sql, async (tx) => {
      const site =
        await tx`insert into public.sites (org_id, name, url) values (${ORG_B}, 'Pop-up', 'https://popup.test') returning id`;
      const id = site[0]!.id as string;
      await tx`insert into public.tokens (org_id, site_id, prefix, token_hash) values (${ORG_B}, ${id}, 'abcd0123', ${HASH})`;
      await tx`delete from public.sites where id = ${id}`;
      expect((await tx`select 1 from public.tokens where prefix = 'abcd0123'`).length).toBe(0);
    });
  });

  describe("the API's database access is the service role, never the table owner", () => {
    it("withService runs its queries as service_role", async () => {
      const who = await withService(sql, async (tx) => (await tx`select current_user as u`)[0]!.u);
      expect(who).toBe("service_role");
      expect((await sql`select current_user as u`)[0]!.u).not.toBe("service_role");
    });

    it("assertServiceRole refuses any other role, the connecting owner and a signed-in user included", async () => {
      expect(await errorOf(sql.begin((tx) => assertServiceRole(tx)))).toMatch(/service_role/);
      expect(
        await errorOf(
          as(sql, { role: "authenticated", userId: USER_A_OWNER }, (tx) => assertServiceRole(tx)),
        ),
      ).toMatch(/service_role/);
      expect(await errorOf(as(sql, service, (tx) => assertServiceRole(tx)))).toBe("");
    });

    it("the service role is fenced: it still cannot change or remove a decision", async () => {
      const msg = await errorOf(withService(sql, (tx) => tx`delete from public.decisions`));
      expect(msg).toMatch(/permission denied|append-only/);
    });
  });
});
