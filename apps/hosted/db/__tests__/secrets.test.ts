/**
 * Secrets in Vault (V-01): only the worker's role (gaugeline_worker) reads a value, through
 * private.get_secret; service_role may put and delete (write-only). Run against the Vault stand-in (stand-in/supabase-vault.sql).
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  definerFunctionsWithoutEmptySearchPath,
  privateFunctionsExecutableBy,
  tablesWithoutRls,
} from "../audit.js";
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
const worker = { role: "gaugeline_worker" as const };

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
    as(sql, worker, async (tx) => {
      const r = await tx`select private.get_secret(${org}, ${name}) as v`;
      return r[0]!.v as string | null;
    });

  describe("who can reach a value", () => {
    const outsiders: { role: DbRole; userId?: string }[] = [
      { role: "anon" },
      { role: "authenticated", userId: USER_A_OWNER },
      { role: "gaugeline_agent" },
      { role: "service_role" },
      { role: "gaugeline_worker" },
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
          ...(who.role === "gaugeline_worker"
            ? []
            : [`select private.get_secret('${ORG_A}', 'slack')`]),
          ...(who.role === "service_role"
            ? []
            : [
                `select private.put_secret('${ORG_A}', 'slack', 'webhook_url', 'https://x.test')`,
                `select private.delete_secret('${ORG_A}', 'slack')`,
              ]),
          `select vault.create_secret('x')`,
          `select vault.update_secret(gen_random_uuid(), 'x')`,
        ];
        for (const c of calls) {
          expect(await errorOf(as(sql, who, (tx) => tx.unsafe(c)))).toMatch(/permission denied/);
        }
      });
    }

    it("service_role (also the runs API's role) cannot read a value; the worker's role can read and nothing else", async () => {
      expect(
        await errorOf(as(sql, service, (tx) => tx`select private.get_secret(${ORG_A}, 'slack')`)),
      ).toMatch(/permission denied for function get_secret/);
      expect(await get(ORG_A, "slack")).toBe(HOOK_A);
      expect(
        await errorOf(as(sql, worker, (tx) => tx`select org_id from private.secret_refs`)),
      ).toMatch(/permission denied/);
      expect(await errorOf(as(sql, worker, (tx) => tx`select id from public.sites`))).toMatch(
        /permission denied/,
      );
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
        await tx.unsafe("set local role gaugeline_worker");
        expect((await tx`select private.get_secret(${ORG_A}, 'teams') as v`)[0]!.v).toBe(
          "sig-teams-2",
        );
        await tx.unsafe("set local role service_role");
        const del = await tx`select private.delete_secret(${ORG_A}, 'teams') as r`;
        expect(del[0]!.r).toBe(true);
        await tx.unsafe("set local role gaugeline_worker");
        expect((await tx`select private.get_secret(${ORG_A}, 'teams') as v`)[0]!.v).toBeNull();
        await tx.unsafe("set local role service_role");
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
        "put_secret",
      ]);
      expect(await privateFunctionsExecutableBy(sql, "gaugeline_worker")).toEqual(["get_secret"]);
      expect(await privateFunctionsExecutableBy(sql, "anon")).toEqual([]);
      expect(await privateFunctionsExecutableBy(sql, "gaugeline_agent")).toEqual([
        "agent_insert_draft",
      ]);
      expect(await privateFunctionsExecutableBy(sql, "authenticated")).toEqual([
        // X66 (the agencies migration): a signed-in person accepts an invite sent to their email.
        "accept_invite",
        "admin_org_ids",
        "client_site_ids",
        "member_org_ids",
        "owner_org_ids",
        "staff_org_ids",
      ]);
    });

    it("every SECURITY DEFINER function in private pins search_path to empty", async () => {
      expect(await definerFunctionsWithoutEmptySearchPath(sql, "private")).toEqual([]);
      const mine = await sql`select p.proname, p.prosecdef, p.proconfig from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in
          ('put_secret', 'get_secret', 'delete_secret', 'secret_refs_drop_vault') order by 1`;
      expect(mine.map((r) => [r.proname, r.prosecdef, r.proconfig])).toEqual(
        ["delete_secret", "get_secret", "put_secret", "secret_refs_drop_vault"].map((n) => [
          n,
          true,
          ['search_path=""'],
        ]),
      );
      // The audit itself catches a definer function without it.
      await rolledBack(sql, async (tx) => {
        await tx.unsafe(
          "create function private.loose() returns int language sql security definer as 'select 1'",
        );
        expect(await definerFunctionsWithoutEmptySearchPath(tx, "private")).toEqual(["loose"]);
      });
    });
  });

  describe("concurrency", () => {
    it("two first puts of one name at once give created then rotated, never a duplicate", async () => {
      const other = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let firstDone!: () => void;
        const firstPut = new Promise<void>((r) => (firstDone = r));
        const a = sql.begin(async (tx) => {
          await tx.unsafe("set local role service_role");
          const r =
            await tx`select private.put_secret(${ORG_A}, 'race', 'webhook_url', 'https://hooks.slack.test/1') as r`;
          firstDone();
          await held;
          return r[0]!.r as string;
        });
        await firstPut;
        const b = other.begin(async (tx) => {
          await tx.unsafe("set local role service_role");
          const r =
            await tx`select private.put_secret(${ORG_A}, 'race', 'webhook_url', 'https://hooks.slack.test/2') as r`;
          return r[0]!.r as string;
        });
        // b is now waiting on a's lock; let a commit.
        await new Promise((r) => setTimeout(r, 200));
        release();
        expect([await a, await b]).toEqual(["created", "rotated"]);
      } finally {
        await sql.begin(async (tx) => {
          await tx.unsafe("set local role service_role");
          await tx`select private.delete_secret(${ORG_A}, 'race')`;
        });
        await other.end();
      }
    });

    it("put refuses REPEATABLE READ, where the lock could not prevent a duplicate", async () => {
      const msg = await errorOf(
        sql.begin("isolation level repeatable read", async (tx) => {
          await tx.unsafe("set local role service_role");
          await tx`select private.put_secret(${ORG_A}, 'rr', 'webhook_url', 'https://hooks.slack.test/rr')`;
        }),
      );
      expect(msg).toMatch(/READ COMMITTED/);
    });
  });

  it("a Vault grant the migration cannot take back fails the deploy", async () => {
    const grantor = `gl_platform_${randomBytes(4).toString("hex")}`;
    const bare = await freshDatabase({ to: 5 });
    try {
      // Like a platform-owned grant: made by another role, so the migration owner's REVOKE leaves it.
      await bare.sql.unsafe(`
        create role ${grantor} nologin;
        grant usage on schema vault to ${grantor} with grant option;
        grant select on vault.decrypted_secrets to ${grantor} with grant option;
        set role ${grantor};
        grant usage on schema vault to authenticated;
        grant select on vault.decrypted_secrets to authenticated;
        reset role;
      `);
      expect(await errorOf(migrate(bare.sql, MIGRATIONS_DIR))).toMatch(
        /Vault is reachable outside private.get_secret: .*authenticated on decrypted_secrets/,
      );
      const t = await bare.sql`select to_regclass('private.secret_refs') as t`;
      expect(t[0]!.t).toBeNull();
    } finally {
      await bare.drop();
      const a = postgres(db.url, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop role if exists ${grantor}`);
      await a.end();
    }
  });
});
