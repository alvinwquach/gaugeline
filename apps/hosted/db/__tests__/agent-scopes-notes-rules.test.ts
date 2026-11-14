/**
 * The two scopes the hosted registry gained for the field-findings miner (AG-15, `read:notes`) and the
 * house-rules compiler (AG-17, `read:rules-file`), against a real Postgres: the upgrade changes the closed
 * scope list and nothing else, the list still refuses every other name, an agent registered in one
 * organisation with a new scope cannot act in another, the policy still refuses the two tools (deny by
 * default), and a mutation of the constraint (a scope removed, the count left too low) is caught by the
 * checks here. Skipped without GAUGELINE_TEST_DATABASE_URL (see the db harness).
 */
import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_SCOPES, SCOPES_NOT_YET_IN_POLICY } from "../../agents/registry.js";
import {
  agentLoginsWithOtherRoles,
  definerFunctionsWithoutEmptySearchPath,
  privateFunctionsExecutableBy,
  tablesWithoutRls,
  viewsWithoutSecurityInvoker,
} from "../audit.js";
import { listMigrations, migrate, MIGRATIONS_DIR } from "../migrate.js";
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
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_OWNER,
  USER_B_OWNER,
} from "./harness.js";

const NEW_SCOPES = ["read:notes", "read:rules-file"] as const;
const OLD_SCOPES = AGENT_SCOPES.filter((s) => !(NEW_SCOPES as readonly string[]).includes(s));
const THIS_MIGRATION = listMigrations(MIGRATIONS_DIR).find((m) =>
  m.name.endsWith("_agent_scopes_notes_rules"),
);
const EMAIL = { subject: "Your menu link is fixed", body: "The drinks page is back." };
const PENDING_A = "a1d10000-0000-4000-8000-0000000000c1";
const PENDING_B = "b1d10000-0000-4000-8000-0000000000c1";

describe("the migration file", () => {
  it("exists, and is the one this test upgrades across", () => {
    expect(THIS_MIGRATION).toBeDefined();
  });
});

describe.skipIf(!HAS_DATABASE)("the hosted scopes for AG-15 and AG-17", () => {
  let db: TestDatabase;
  let sql: Sql;
  let before: Snapshot;
  let oldAgents: { id: string; token: string; scopes: string[] }[];

  type Snapshot = {
    agents: unknown[];
    limits: unknown[];
    events: unknown[];
    tables: string[];
    functions: string[];
    roles: string[];
    grants: string[];
    policies: string[];
    constraints: string[];
  };
  const snapshot = async (q: Sql): Promise<Snapshot> => ({
    agents: [...(await q`select * from public.agents order by id`)],
    limits: [...(await q`select * from public.agent_limits order by agent_id`)],
    events: [...(await q`select * from public.agent_events order by id`)],
    tables: (
      await q`select tablename as t from pg_tables where schemaname in ('public', 'private') order by 1`
    ).map((r) => r.t as string),
    functions: (
      await q`select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') order by 1`
    ).map((r) => r.f as string),
    roles: (
      await q`select rolname as r from pg_roles where rolname ~ '^(gaugeline_|anon|authenticated|service_role)' order by 1`
    ).map((r) => r.r as string),
    grants: [
      ...(
        await q`select grantee || ' ' || privilege_type || ' ' || table_schema || '.' || table_name as g
          from information_schema.role_table_grants
          where table_schema in ('public', 'private') order by 1`
      ).map((r) => r.g as string),
      ...(
        await q`select grantee || ' ' || privilege_type || ' ' || routine_schema || '.' || routine_name as g
          from information_schema.routine_privileges where routine_schema in ('public', 'private') order by 1`
      ).map((r) => r.g as string),
      ...(
        await q`select grantee || ' ' || privilege_type || ' ' || table_name || '.' || column_name as g
          from information_schema.column_privileges where table_schema = 'public'
          and grantee in ('authenticated', 'gaugeline_agent', 'anon') order by 1`
      ).map((r) => r.g as string),
    ],
    policies: (
      await q`select tablename || ' ' || policyname || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') as p
        from pg_policies where schemaname = 'public' order by 1`
    ).map((r) => r.p as string),
    // Every constraint of the registry's tables except the scope list itself, which is what changes.
    constraints: (
      await q`select conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) as c
        from pg_constraint where conrelid in ('public.agents'::regclass, 'public.agent_limits'::regclass,
        'public.agent_events'::regclass, 'public.agent_denies'::regclass) and conname <> 'agents_scopes_known'
        order by 1`
    ).map((r) => r.c as string),
  });

  /** Register through the one door, as `by`, and commit. */
  async function register(
    scopes: string[],
    o: { org?: string; by?: string; name?: string } = {},
  ): Promise<{ id: string; token: string }> {
    const org = o.org ?? ORG_A;
    const by = o.by ?? (org === ORG_A ? USER_A_OWNER : USER_B_OWNER);
    const name = o.name ?? `Scoped agent ${randomBytes(4).toString("hex")}`;
    return sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: by })}, true)`;
      await tx.unsafe("set local role authenticated");
      const [r] = await tx`select * from private.register_agent(${org}, ${name}, ${by}, ${scopes})`;
      return { id: r!.agent_id as string, token: r!.token as string };
    });
  }
  const registerError = (scopes: string[], o: { org?: string; by?: string } = {}) =>
    errorOf(register(scopes, o));
  const person = (userId: string) => ({ role: "authenticated" as const, userId });

  const scopesIn = async (q: Sql, id: string) =>
    (await q`select scopes from public.agents where id = ${id}`)[0]!.scopes as string[];
  const lastDenyId = async () =>
    Number((await sql`select coalesce(max(id), 0) as n from public.agent_denies`)[0]!.n);
  const deniesSince = async (since: number) => [
    ...(await sql`select org_id, tool, reason from public.agent_denies where id > ${since} order by id`),
  ];
  const draftAs = (token: string, site: string) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role gaugeline_agent");
      const [r] =
        await tx`select private.agent_insert_draft(${token}, ${site}::uuid, 'email', ${tx.json(EMAIL)}) as id`;
      return r!.id as string | null;
    });
  const pendingAs = (token: string) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role gaugeline_agent");
      const [r] =
        await tx`select private.agent_list_pending(${token}, 20, null::timestamptz, null::uuid, null::uuid, null::uuid) as p`;
      return r!.p as { allowed: boolean; drafts?: { id: string }[] };
    });

  beforeAll(async () => {
    const v = THIS_MIGRATION?.version;
    // The version before this one first, with agents that already exist, then this migration on top.
    db = await freshDatabase({ to: v === undefined ? undefined : v - 1 });
    sql = db.sql;
    await seed(sql);
    oldAgents = [];
    for (const scopes of [
      ["draft:email", "draft:pull_request", "draft:sanity_draft", "read:runs", "read:pending"],
      ["read:pending"],
      [],
    ])
      oldAgents.push({ ...(await register(scopes)), scopes });
    const revoked = await register(["draft:email"], { name: "Old revoked agent" });
    await as(sql, person(USER_A_OWNER), async (tx) => {
      await tx`select * from private.revoke_agent(${revoked.id})`;
    });
    before = await snapshot(sql);
    await sql`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids) values
      (${PENDING_A}, ${ORG_A}, ${SITE_A1}, 'email', ${sql.json(EMAIL)}, '{}'),
      (${PENDING_B}, ${ORG_B}, ${SITE_B1}, 'email', ${sql.json(EMAIL)}, '{}')`;
    await migrate(sql, MIGRATIONS_DIR);
  });
  afterAll(async () => {
    await db?.drop();
  });

  describe("the upgrade changes the closed scope list and nothing else", () => {
    it("the agents, limits and history that were there are unchanged", async () => {
      const after = await snapshot(sql);
      expect(after.agents).toEqual(before.agents);
      expect(after.limits).toEqual(before.limits);
      expect(after.events).toEqual(before.events);
      expect(before.agents).toHaveLength(4);
    });

    it("adds no table, function, role, grant or policy, and no other constraint changes", async () => {
      const after = await snapshot(sql);
      expect(after.tables).toEqual(before.tables);
      expect(after.functions).toEqual(before.functions);
      expect(after.roles).toEqual(before.roles);
      expect(after.grants).toEqual(before.grants);
      expect(after.policies).toEqual(before.policies);
      expect(after.constraints).toEqual(before.constraints);
    });

    it("an old agent keeps working: its token drafts, and its scopes are what they were", async () => {
      const full = oldAgents[0]!;
      expect(await scopesIn(sql, full.id)).toEqual(full.scopes);
      expect(await draftAs(full.token, SITE_A1)).not.toBeNull();
    });

    it("the audit lists are the ones before: no private function opens to a login, the agent holds no table", async () => {
      expect(await privateFunctionsExecutableBy(sql, "gaugeline_agent")).toEqual([
        "agent_insert_draft",
        "agent_list_pending",
        "agent_list_runs",
      ]);
      expect(await privateFunctionsExecutableBy(sql, "anon")).toEqual([]);
      expect(await agentLoginsWithOtherRoles(sql)).toEqual([]);
      const [g] = await sql`select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'gaugeline_agent'`;
      expect(g!.n).toBe(0);
      expect(await tablesWithoutRls(sql)).toEqual([]);
      expect(await viewsWithoutSecurityInvoker(sql)).toEqual([]);
      expect(await definerFunctionsWithoutEmptySearchPath(sql)).toEqual([]);
    });
  });

  describe("registering with the new scopes (passing fixtures)", () => {
    for (const scope of NEW_SCOPES)
      it(`${scope} alone: the agent is registered, active, unused and owned`, async () => {
        const a = await register([scope]);
        const [r] = await sql`select scopes, status, origin, owner_id, last_used_at
          from public.agents where id = ${a.id}`;
        expect(r).toMatchObject({
          scopes: [scope],
          status: "active",
          origin: "registered",
          owner_id: USER_A_OWNER,
          last_used_at: null,
        });
        const [l] =
          await sql`select count(*)::int as n from public.agent_limits where agent_id = ${a.id}`;
        expect(l!.n).toBe(1);
      });

    it("both together, beside the draft and read scopes: every scope on the list at once", async () => {
      const both = await register([...NEW_SCOPES]);
      expect(await scopesIn(sql, both.id)).toEqual([...NEW_SCOPES]);
      const all = await register([...AGENT_SCOPES]);
      expect(await scopesIn(sql, all.id)).toEqual([...AGENT_SCOPES]);
      expect(AGENT_SCOPES).toHaveLength(7);
    });

    it("each scope on the list, one at a time, is accepted (the list in the app is the list in the database)", async () => {
      for (const s of AGENT_SCOPES) expect(await registerError([s]), s).toBe("");
    });

    it("the owner of the organisation grants one to an existing agent, and takes it away", async () => {
      const a = await register(["draft:email"]);
      await as(sql, person(USER_A_OWNER), async (tx) => {
        const up = await tx`update public.agents set scopes = '{draft:email,read:notes}'
          where id = ${a.id} returning scopes`;
        expect(up[0]!.scopes).toEqual(["draft:email", "read:notes"]);
        const down =
          await tx`update public.agents set scopes = '{}' where id = ${a.id} returning scopes`;
        expect(down[0]!.scopes).toEqual([]);
      });
    });
  });

  describe("an unknown scope is still refused (failing fixtures)", () => {
    const BAD = [
      "read:note",
      "read:notes ",
      " read:notes",
      "READ:NOTES",
      "read:Notes",
      "read:rules_file",
      "read:rules-files",
      "read:rules",
      "read:rulesfile",
      "read:notes,read:rules-file",
      "read:*",
      "draft:notes",
      "write:notes",
      "write:rules-file",
      "notes",
      "",
      "read:",
      "read:secrets",
      "write:publish",
      "admin",
    ];
    for (const bad of BAD)
      it(`refuses ${JSON.stringify(bad)}, alone or beside a good scope, naming the rule and not the row`, async () => {
        for (const scopes of [[bad], ["read:notes", bad]]) {
          const e = await registerError(scopes);
          expect(e, JSON.stringify(scopes)).toMatch(/agents_scopes_known/);
          expect(e).not.toMatch(/[0-9a-f]{64}|Failing row/);
        }
      });

    it("a scope cannot be set by hand to one that is not on the list, or named twice", async () => {
      const a = await register(["read:notes"]);
      await as(sql, person(USER_A_OWNER), async (tx) => {
        expect(
          await errorOf(
            tx`update public.agents set scopes = '{read:notes,read:note}' where id = ${a.id}`,
          ),
        ).toMatch(/agents_scopes_known/);
      });
      for (const scopes of [
        ["read:notes", "read:notes"],
        ["read:rules-file", "read:rules-file"],
      ])
        expect(await registerError(scopes), scopes.join()).toMatch(/each scope once/);
      expect(
        await errorOf(
          sql`update public.agents set scopes = '{read:rules-file,read:rules-file}' where id = ${a.id}`,
        ),
      ).toMatch(/each scope once/);
    });

    it("more than the seven on the list is refused (the count is the list's, not a loose number)", async () => {
      const e = await errorOf(
        sql`insert into public.agents (org_id, name, owner_id, scopes, token_sha256, token_prefix)
          values (${ORG_A}, 'Eight', ${USER_A_OWNER}, ${[...AGENT_SCOPES, "read:notes"]},
          repeat('b', 64), 'bbbbbbbb')`,
      );
      expect(e).toMatch(/each scope once|agents_scopes_known/);
    });
  });

  describe("tenancy: an agent registered in organisation A with a new scope cannot act in B", () => {
    let a: { id: string; token: string };
    beforeAll(async () => {
      a = await register([...NEW_SCOPES, "draft:email", "read:pending"], { name: "Notes agent A" });
    });

    it("organisation B's owner cannot see it, change its scopes or revoke it", async () => {
      await as(sql, person(USER_B_OWNER), async (tx) => {
        expect(await tx`select id from public.agents where id = ${a.id}`).toHaveLength(0);
        expect(
          await tx`update public.agents set scopes = '{}' where id = ${a.id} returning id`,
        ).toHaveLength(0);
        expect(await errorOf(tx`select * from private.revoke_agent(${a.id})`)).toMatch(
          /agent not found/,
        );
      });
      expect(await scopesIn(sql, a.id)).toEqual([...NEW_SCOPES, "draft:email", "read:pending"]);
      const [s] = await sql`select status from public.agents where id = ${a.id}`;
      expect(s!.status).toBe("active");
    });

    it("organisation B's owner cannot register an agent into A with a new scope, and A's cannot into B", async () => {
      for (const s of NEW_SCOPES) {
        expect(await registerError([s], { org: ORG_A, by: USER_B_OWNER }), s).toMatch(
          /organisation not found/,
        );
        expect(await registerError([s], { org: ORG_B, by: USER_A_OWNER }), s).toMatch(
          /organisation not found/,
        );
      }
    });

    it("the agent drafts into A's site and is refused B's, with nothing inserted there", async () => {
      expect(await draftAs(a.token, SITE_A1)).not.toBeNull();
      const [{ n: before }] =
        (await sql`select count(*)::int as n from public.drafts where site_id = ${SITE_B1}`) as unknown as [
          { n: number },
        ];
      const e = await errorOf(draftAs(a.token, SITE_B1));
      expect(e).toMatch(/site not found for this agent/);
      const [{ n: after }] =
        (await sql`select count(*)::int as n from public.drafts where site_id = ${SITE_B1}`) as unknown as [
          { n: number },
        ];
      expect(after).toBe(before);
    });

    it("its read of pending drafts lists A's and never B's", async () => {
      const p = await pendingAs(a.token);
      expect(p.allowed).toBe(true);
      const ids = (p.drafts ?? []).map((d) => d.id);
      expect(ids).toContain(PENDING_A);
      expect(ids).not.toContain(PENDING_B);
    });

    it("an agent of B with a new scope reads and drafts only in B", async () => {
      const b = await register([...NEW_SCOPES, "draft:email", "read:pending"], {
        org: ORG_B,
        name: "Notes agent B",
      });
      expect(await errorOf(draftAs(b.token, SITE_A1))).toMatch(/site not found for this agent/);
      const ids = ((await pendingAs(b.token)).drafts ?? []).map((d) => d.id);
      expect(ids).toContain(PENDING_B);
      expect(ids).not.toContain(PENDING_A);
    });

    it("the new scope alone lets an agent do nothing: no draft, no read of pending or runs", async () => {
      const only = await register([...NEW_SCOPES], { name: "Notes only" });
      const since = await lastDenyId();
      expect(await draftAs(only.token, SITE_A1)).toBeNull();
      expect((await pendingAs(only.token)).allowed).toBe(false);
      expect((await deniesSince(since)).map((d) => [d.org_id, d.tool, d.reason])).toEqual([
        [ORG_A, "draft:email", "scope"],
        [ORG_A, "read:pending", "scope"],
      ]);
    });
  });

  describe("the policy's tool list is unchanged: deny by default (AG-03)", () => {
    for (const tool of NEW_SCOPES)
      it(`${tool} is refused as tool-not-allowed even for an agent that holds the scope, and logged without the name`, async () => {
        const a = await register([tool]);
        const since = await lastDenyId();
        const [r] =
          await sql`select allowed, reason from private.agent_authorize(${a.token}, ${tool}, 0)`;
        expect(r).toEqual({ allowed: false, reason: "tool-not-allowed" });
        expect(await deniesSince(since)).toEqual([
          { org_id: ORG_A, tool: null, reason: "tool-not-allowed" },
        ]);
        const [c] =
          await sql`select window_calls from public.agent_limits where agent_id = ${a.id}`;
        expect(c!.window_calls).toBe(0);
      });

    it("the tools the policy lists are the old scopes, exactly; the deny log and trace lists did not grow", async () => {
      const [fn] = await sql`select prosrc from pg_proc where proname = 'agent_authorize'`;
      const m = /c_tools constant text\[\] := array\[([^\]]+)\]/.exec(String(fn!.prosrc));
      const listed = [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]);
      expect(listed).toEqual(OLD_SCOPES);
      expect([...SCOPES_NOT_YET_IN_POLICY]).toEqual([...NEW_SCOPES]);
      for (const table of ["agent_denies", "agent_trace"]) {
        const defs = await sql`select pg_get_constraintdef(c.oid) as d from pg_constraint c
          where c.conrelid = ${`public.${table}`}::regclass and c.contype = 'c'`;
        const text = defs.map((d) => String(d.d)).join("\n");
        for (const s of NEW_SCOPES) expect(text, `${table} ${s}`).not.toContain(s);
      }
    });
  });

  describe("mutations of the constraint are caught (the checks above fail if the constraint is weakened)", () => {
    const listOf = (def: string) => [...def.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const constraintDef = async (q: Sql | postgres.TransactionSql) =>
      String(
        (
          await q`select pg_get_constraintdef(oid) as d from pg_constraint
        where conname = 'agents_scopes_known' and conrelid = 'public.agents'::regclass`
        )[0]!.d,
      );
    /**
     * The constraint as the migration writes it, with `scopes` as its list and `max` as its count. Not
     * validated against the rows already there (a mutation would break them); every new row is checked.
     */
    const rebuild = async (
      tx: Sql | postgres.TransactionSql,
      scopes: readonly string[],
      max: number,
    ) => {
      await tx.unsafe(`alter table public.agents drop constraint agents_scopes_known`);
      await tx.unsafe(`alter table public.agents add constraint agents_scopes_known check (
        scopes <@ array[${scopes.map((s) => `'${s}'`).join(", ")}]
        and coalesce(array_ndims(scopes), 1) = 1 and coalesce(array_lower(scopes, 1), 1) = 1
        and cardinality(scopes) <= ${max}) not valid`);
    };

    it("the constraint as migrated lists the app's scopes in order, with a count that fits them", async () => {
      const def = await constraintDef(sql);
      expect(listOf(def)).toEqual([...AGENT_SCOPES]);
      expect(def).toMatch(/cardinality\(scopes\) <= 7\b/);
    });

    for (const gone of NEW_SCOPES)
      it(`with ${gone} removed from the constraint, the list no longer matches and registering it fails`, async () => {
        await rolledBack(sql, async (tx) => {
          await rebuild(
            tx,
            AGENT_SCOPES.filter((s) => s !== gone),
            7,
          );
          const def = await constraintDef(tx);
          expect(listOf(def)).not.toEqual([...AGENT_SCOPES]);
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: USER_A_OWNER })}, true)`;
          await tx.unsafe("set local role authenticated");
          const e = await errorOf(
            tx`select * from private.register_agent(${ORG_A}, 'Mutant', ${USER_A_OWNER}, ${[gone]})`,
          );
          expect(e).toMatch(/agents_scopes_known/);
        });
      });

    it("with the count left at 5, an agent holding all seven scopes is refused", async () => {
      await rolledBack(sql, async (tx) => {
        await rebuild(tx, AGENT_SCOPES, 5);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: USER_A_OWNER })}, true)`;
        await tx.unsafe("set local role authenticated");
        const e = await errorOf(
          tx`select * from private.register_agent(${ORG_A}, 'Mutant', ${USER_A_OWNER}, ${[...AGENT_SCOPES]})`,
        );
        expect(e).toMatch(/agents_scopes_known/);
      });
    });

    it("with an extra scope added to the constraint, the list in the app no longer matches it", async () => {
      await rolledBack(sql, async (tx) => {
        await rebuild(tx, [...AGENT_SCOPES, "read:secrets"], 8);
        expect(listOf(await constraintDef(tx))).not.toEqual([...AGENT_SCOPES]);
      });
    });

    it("the mutations rolled back: the constraint is as migrated", async () => {
      expect(listOf(await constraintDef(sql))).toEqual([...AGENT_SCOPES]);
    });
  });
});
