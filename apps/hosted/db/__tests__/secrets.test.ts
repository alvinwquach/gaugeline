/**
 * Secrets in Vault (V-01): only the worker's role (service_role) reaches a value, and only through
 * private.put_secret / get_secret / delete_secret. Run against the Vault stand-in (stand-in/supabase-vault.sql).
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateFunctionsExecutableBy, tablesWithoutRls } from "../audit.js";
import { MIGRATIONS_DIR, migrate } from "../migrate.js";
import {
  as,
  type DbRole,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  rolledBack,
  seed,
  type Sql,
  type TestDatabase,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
} from "./harness.js";

// Invented values (rule 12), built at run time so no key-shaped string sits in the source.
const HOOK_A = ["https://hooks.slack.test/services", "T0NORTHGATE", "B0TIDEWATER", "marker-a"].join(
  "/",
);
const SIGNING_B = ["sig", "maple", "physio", "marker-b"].join("-");
const service = { role: "service_role" as const };

describe.skipIf(!HAS_DATABASE)("hosted database: secrets in Vault", () => {
  let db: TestDatabase;
  let sql: Sql;
  const notices: string[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    // A connection that keeps every notice and warning, to show a value never reaches one.
    sql = postgres(db.url, { max: 4, onnotice: (n) => notices.push(JSON.stringify(n)) });
    await seed(sql);
    // Committed, as the worker would: as() rolls back, so the two secrets every test reads go in here.
    await sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`select private.put_secret(${ORG_A}, 'slack', 'webhook_url', ${HOOK_A})`;
      await tx`select private.put_secret(${ORG_B}, 'discord', 'signing_secret', ${SIGNING_B})`;
    });
  });
  afterAll(async () => {
    await sql?.end();
    await db?.drop();
  });

  const get = (org: string, name: string) =>
    as(sql, service, async (tx) => {
      const r = await tx`select private.get_secret(${org}, ${name}) as v`;
      return r[0]!.v as string | null;
    });

  describe("who can reach a value", () => {
    const outsiders: { role: DbRole; userId?: string }[] = [
      { role: "anon" },
      { role: "authenticated", userId: USER_A_OWNER },
      { role: "gaugeline_agent" },
    ];
    for (const who of outsiders) {
      it(`${who.role} cannot select from vault.secrets, vault.decrypted_secrets or private.secret_events`, async () => {
        for (const rel of ["vault.secrets", "vault.decrypted_secrets", "private.secret_events"]) {
          expect(await errorOf(as(sql, who, (tx) => tx.unsafe(`select * from ${rel}`)))).toMatch(
            /permission denied/,
          );
        }
      });

      it(`${who.role} cannot execute put_secret, get_secret, delete_secret or the Vault functions`, async () => {
        const calls = [
          `select private.get_secret('${ORG_A}', 'slack')`,
          `select private.put_secret('${ORG_A}', 'slack', 'webhook_url', 'https://x.test')`,
          `select private.delete_secret('${ORG_A}', 'slack')`,
          `select vault.create_secret('x')`,
          `select vault.update_secret(gen_random_uuid(), 'x')`,
        ];
        for (const c of calls) {
          expect(await errorOf(as(sql, who, (tx) => tx.unsafe(c)))).toMatch(/permission denied/);
        }
      });
    }

    it("service_role cannot read Vault directly either: only through get_secret", async () => {
      for (const rel of ["vault.secrets", "vault.decrypted_secrets"]) {
        expect(await errorOf(as(sql, service, (tx) => tx.unsafe(`select * from ${rel}`)))).toMatch(
          /permission denied/,
        );
      }
    });

    it("the worker's role puts, gets and deletes for the organisation it passes", async () => {
      expect(await get(ORG_A, "slack")).toBe(HOOK_A);
      expect(await get(ORG_B, "discord")).toBe(SIGNING_B);
      // Org A's name does not find org B's secret.
      expect(await get(ORG_A, "discord")).toBeNull();
      await as(sql, service, async (tx) => {
        const put =
          await tx`select private.put_secret(${ORG_A}, 'teams', 'signing_secret', 'sig-teams-1') as r`;
        expect(put[0]!.r).toBe("created");
        const again =
          await tx`select private.put_secret(${ORG_A}, 'teams', 'signing_secret', 'sig-teams-2') as r`;
        expect(again[0]!.r).toBe("rotated");
        expect((await tx`select private.get_secret(${ORG_A}, 'teams') as v`)[0]!.v).toBe(
          "sig-teams-2",
        );
        const del = await tx`select private.delete_secret(${ORG_A}, 'teams') as r`;
        expect(del[0]!.r).toBe(true);
        expect((await tx`select private.get_secret(${ORG_A}, 'teams') as v`)[0]!.v).toBeNull();
        expect((await tx`select private.delete_secret(${ORG_A}, 'teams') as r`)[0]!.r).toBe(false);
      });
    });

    it("a get for a missing name is a clean not-found (null), not an error", async () => {
      expect(await get(ORG_A, "nothing-here")).toBeNull();
      expect(await get("0c000000-0000-4000-8000-00000000000c", "slack")).toBeNull();
    });
  });

  describe("metadata", () => {
    const meta = (userId: string) =>
      as(sql, { role: "authenticated", userId }, (tx) =>
        tx`select org_id, name, kind from private.secret_refs order by name`.then((r) => [...r]),
      );

    it("an owner or admin sees their own organisation's names and kinds, never another's", async () => {
      expect(await meta(USER_A_OWNER)).toEqual([
        { org_id: ORG_A, name: "slack", kind: "webhook_url" },
      ]);
      expect(await meta(USER_B_OWNER)).toEqual([
        { org_id: ORG_B, name: "discord", kind: "signing_secret" },
      ]);
    });

    it("a member who is not an admin sees none; nobody signed in sees the Vault id", async () => {
      expect(await meta(USER_A_MEMBER)).toEqual([]);
      expect(
        await errorOf(
          as(sql, { role: "authenticated", userId: USER_A_OWNER }, (tx) =>
            tx.unsafe("select vault_secret_id from private.secret_refs"),
          ),
        ),
      ).toMatch(/permission denied/);
    });

    it("the metadata table holds no value; deleting an organisation deletes its Vault rows", async () => {
      const refs = await sql`select * from private.secret_refs`;
      expect(JSON.stringify([...refs])).not.toMatch(/marker-/);
      await rolledBack(sql, async (tx) => {
        const gone = "0c000000-0000-4000-8000-00000000000c";
        await tx`insert into public.organisations (org_id, name) values (${gone}, 'Closing Shop')`;
        await tx`select private.put_secret(${gone}, 'slack', 'webhook_url', 'https://hooks.slack.test/c')`;
        const before = await tx`select count(*)::int as n from vault.secrets`;
        await tx`delete from public.organisations where org_id = ${gone}`;
        const after = await tx`select count(*)::int as n from vault.secrets`;
        expect(after[0]!.n).toBe(before[0]!.n - 1);
      });
    });
  });

  describe("a value never leaves through a side door", () => {
    it("the stand-in's own table holds no plaintext", async () => {
      const rows = await sql`select secret from vault.secrets`;
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify([...rows])).not.toMatch(/marker-|slack\.test/);
    });

    it("the audit rows name the organisation, the name, the kind and the action, never the value", async () => {
      const ev =
        await sql`select org_id, name, kind, action from private.secret_events order by id`;
      expect(ev.map((e) => `${e.name}:${e.action}`)).toEqual(["slack:created", "discord:created"]);
      expect(JSON.stringify([...ev])).not.toMatch(/marker-/);
      expect(await errorOf(sql`update private.secret_events set action = 'x'`)).toMatch(
        /append-only/,
      );
    });

    it("errors and notices never carry the value, whatever goes wrong", async () => {
      const long = `marker-long-${"x".repeat(5000)}`;
      const bad = [
        [ORG_A, "slack", "webhook_url", long],
        [ORG_A, "Bad Name!", "webhook_url", "marker-badname"],
        [ORG_A, "slack", "not_a_kind", "marker-badkind"],
        [ORG_A, "slack", "signing_secret", "marker-kindchange"],
        ["0c000000-0000-4000-8000-00000000000c", "slack", "webhook_url", "marker-noorg"],
        [ORG_A, "empty", "webhook_url", ""],
      ];
      for (const [org, name, kind, value] of bad) {
        const msg = await errorOf(
          as(
            sql,
            service,
            (tx) => tx`select private.put_secret(${org!}, ${name!}, ${kind!}, ${value!})`,
          ),
        );
        expect(msg, `${name}/${kind}`).not.toBe("");
        expect(msg).not.toMatch(/marker-/);
      }
      expect(notices.join("\n")).not.toMatch(/marker-/);
    });

    it("the statement text other sessions can see (pg_stat_activity) carries a placeholder, not the value", async () => {
      const watcher = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        await sql
          .begin(async (tx) => {
            await tx.unsafe("set local role service_role");
            const pid = (await tx`select pg_backend_pid() as p`)[0]!.p as number;
            const value = "https://hooks.slack.test/marker-watched";
            await tx`select private.put_secret(${ORG_A}, ${"watched"}, ${"webhook_url"}, ${value})`;
            const seen = await watcher`select query from pg_stat_activity where pid = ${pid}`;
            expect(seen[0]!.query).toBe("select private.put_secret($1, $2, $3, $4)");
            throw new Error("roll back");
          })
          .catch((e: Error) => {
            if (e.message !== "roll back") throw e;
          });
      } finally {
        await watcher.end();
      }
    });
  });

  describe("names, kinds and values", () => {
    it("refuses a bad name, an unknown kind, an empty or oversize value, and a kind change", async () => {
      const put = (name: string, kind: string, value: string) =>
        errorOf(
          as(
            sql,
            service,
            (tx) => tx`select private.put_secret(${ORG_A}, ${name}, ${kind}, ${value})`,
          ),
        );
      expect(await put("Slack", "webhook_url", "v")).toMatch(/name/);
      expect(await put("a".repeat(64), "webhook_url", "v")).toMatch(/name/);
      expect(await put("../slack", "webhook_url", "v")).toMatch(/name/);
      expect(await put("slack", "password", "v")).toMatch(/kind/);
      expect(await put("fresh", "webhook_url", "")).toMatch(/value/);
      expect(await put("fresh", "webhook_url", "é".repeat(2049))).toMatch(/value/);
      expect(await put("slack", "signing_secret", "v")).toMatch(/kind/);
      expect(await put("a".repeat(63), "webhook_url", "é".repeat(2048))).toBe("");
    });
  });

  it("without Vault the migration stops with a clear message and applies nothing", async () => {
    const bare = await freshDatabase({ to: 5 });
    try {
      await bare.sql.unsafe("drop schema vault cascade");
      expect(await errorOf(migrate(bare.sql, MIGRATIONS_DIR))).toMatch(
        /Supabase Vault is not enabled/,
      );
      const t = await bare.sql`select to_regclass('private.secret_refs') as t`;
      expect(t[0]!.t).toBeNull();
    } finally {
      await bare.drop();
    }
  });

  describe("audit", () => {
    it("every table in private has row-level security, and only the expected functions are callable", async () => {
      expect(await tablesWithoutRls(sql, "private")).toEqual(["schema_migrations"]);
      expect(await privateFunctionsExecutableBy(sql, "service_role")).toEqual([
        "delete_secret",
        "get_secret",
        "put_secret",
      ]);
      expect(await privateFunctionsExecutableBy(sql, "anon")).toEqual([]);
      expect(await privateFunctionsExecutableBy(sql, "gaugeline_agent")).toEqual([
        "agent_insert_draft",
      ]);
      expect(await privateFunctionsExecutableBy(sql, "authenticated")).toEqual([
        "admin_org_ids",
        "client_site_ids",
        "member_org_ids",
        "owner_org_ids",
        "staff_org_ids",
      ]);
    });
  });
});
