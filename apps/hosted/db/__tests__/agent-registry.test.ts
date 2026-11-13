/**
 * The agent registry (AG-02) against a real Postgres. Every claim is tested through REAL login roles: a
 * person's login (a member of `authenticated` only, like Supabase's authenticator) and an agent's login (a
 * member of `gaugeline_agent` only). The migration owner only sets things up. Skipped without
 * GAUGELINE_TEST_DATABASE_URL (see the db harness).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_SCOPES,
  AGENT_TOKEN_PATTERN,
  hashAgentToken,
  SHADOW_IDLE_DAYS,
} from "../../agents/registry.js";
import { DRAFT_KINDS } from "../../inbox/kinds.js";
import {
  agentLoginsWithOtherRoles,
  definerFunctionsWithoutEmptySearchPath,
  privateFunctionsExecutableBy,
  tablesWithoutRls,
  viewsWithoutSecurityInvoker,
} from "../audit.js";
import { MIGRATIONS_DIR, migrate } from "../migrate.js";
import {
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  rolledBack,
  seed,
  SITE_A1,
  type Sql,
  TEST_DATABASE_URL,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
  USER_BOTH,
} from "./harness.js";

const tag = randomBytes(4).toString("hex");
const PERSON = `gl_reg_person_${tag}`;
const AGENT = `gl_reg_agent_${tag}`;
const PASSWORD = "registry-test-login";
const EMAIL = { subject: "Your menu link is fixed", body: "The drinks page is back." };
const ALL_DRAFTS = ["draft:pull_request", "draft:email", "draft:sanity_draft"];

class Rollback extends Error {}

describe("the scope list (no database)", () => {
  it("the scopes are one draft scope per registered kind plus four reads, and none writes", () => {
    expect(AGENT_SCOPES.filter((s) => s.startsWith("draft:"))).toEqual(
      DRAFT_KINDS.map((k) => `draft:${k}`),
    );
    expect(AGENT_SCOPES.filter((s) => !s.startsWith("draft:"))).toEqual([
      "read:runs",
      "read:pending",
      "read:notes",
      "read:rules-file",
    ]);
    for (const s of AGENT_SCOPES)
      expect(s).not.toMatch(/write|publish|send|merge|apply|delete|admin/);
  });
});

describe.skipIf(!HAS_DATABASE)("agent registry", () => {
  let db: TestDatabase;
  let owner: Sql; // the migration owner: set-up only
  let person: Sql; // a signed-in person's login: member of `authenticated` only
  let agent: Sql; // an agent's login: member of `gaugeline_agent` only

  const loginUrl = (name: string) => {
    const u = new URL(db.url);
    u.username = name;
    u.password = PASSWORD;
    return u.href;
  };

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    await owner.unsafe(`
      create role ${PERSON} login noinherit password '${PASSWORD}' in role authenticated;
      create role ${AGENT} login noinherit password '${PASSWORD}' in role gaugeline_agent;`);
    person = postgres(loginUrl(PERSON), { max: 4, onnotice: () => {} });
    agent = postgres(loginUrl(AGENT), { max: 4, onnotice: () => {} });
  });
  afterAll(async () => {
    await person?.end();
    await agent?.end();
    await db?.drop();
    // A role belongs to the server, not to the database, so it outlives the database dropped above.
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop role if exists ${PERSON}; drop role if exists ${AGENT}`);
    await admin.end();
  });

  /** Run `fn` on the person's login as `userId` (`authenticated`); roll back unless `commit`. */
  async function asPerson<T>(
    userId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    commit = false,
  ): Promise<T> {
    let out: T | undefined;
    try {
      await person.begin(async (tx) => {
        const claims = JSON.stringify(userId ? { role: "authenticated", sub: userId } : {});
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx.unsafe(userId ? "set local role authenticated" : "select 1");
        out = await fn(tx);
        if (!commit) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return out as T;
  }
  const personError = (
    userId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<unknown>,
  ) => errorOf(asPerson(userId, fn));

  /**
   * The agent's own login drafts an email with `token`; commits. "" when a draft was inserted, the error,
   * or "denied: <reason>" when the policy (AG-03, 0013) refused it and logged the reason.
   */
  const agentDraft = async (token: string, kind = "email", payload: object = EMAIL) => {
    let id: unknown;
    const e = await errorOf(
      agent.begin(async (tx) => {
        await tx.unsafe("set local role gaugeline_agent");
        const [r] =
          await tx`select private.agent_insert_draft(${token}, ${SITE_A1}, ${kind}, ${tx.json(payload as never)}) as id`;
        id = r!.id;
      }),
    );
    if (e !== "" || id !== null) return e;
    const [d] = await owner`select reason from public.agent_denies order by id desc limit 1`;
    return `denied: ${d!.reason as string}`;
  };

  /** Register through the one door, as `by` on the person's login; roll back unless `commit`. */
  const registerAs = (
    by: string | null,
    args: { org?: string; name?: string; ownerId?: string | null; scopes?: string[] },
    commit = false,
  ) =>
    asPerson(
      by,
      async (tx) => {
        const [r] = await tx`select * from private.register_agent(${args.org ?? ORG_A},
          ${args.name ?? `Triage agent ${randomBytes(4).toString("hex")}`},
          ${args.ownerId === undefined ? by : args.ownerId}, ${args.scopes ?? ["draft:email"]})`;
        return {
          id: r!.agent_id as string,
          token: r!.token as string,
          prefix: r!.token_prefix as string,
        };
      },
      commit,
    );

  /** A committed agent (org A, by its owner unless said otherwise). Returns its id, token and prefix. */
  const register = (
    over: { org?: string; by?: string; ownerId?: string; scopes?: string[] } = {},
  ): Promise<{ id: string; token: string; prefix: string }> =>
    registerAs(over.by ?? USER_A_OWNER, over, true);
  const row = async (id: string) => (await owner`select * from public.agents where id = ${id}`)[0]!;
  const history = (id: string) =>
    owner`select from_status, to_status, changed_by from public.agent_events where agent_id = ${id} order by id`;

  describe("registering (passing fixture: an owned, scoped, active agent)", () => {
    it("the database mints the token, returns it once, and keeps only its hash and prefix", async () => {
      const a = await register();
      expect(a.token).toMatch(AGENT_TOKEN_PATTERN);
      expect(a.token.slice(4, 12)).toBe(a.prefix);
      const r = await row(a.id);
      expect(r).toMatchObject({
        org_id: ORG_A,
        owner_id: USER_A_OWNER,
        status: "active",
        origin: "registered",
        token_prefix: a.prefix,
      });
      expect(r.scopes).toEqual(["draft:email"]);
      expect(r.token_sha256).toBe(hashAgentToken(a.token));
      const everything = JSON.stringify([
        ...(await owner`select * from public.agents`),
        ...(await owner`select * from public.agent_events`),
      ]);
      expect(everything).not.toContain(a.token.slice(13));
      expect(r.last_used_at).toBeNull();
      expect(await history(a.id)).toEqual([
        { from_status: null, to_status: "active", changed_by: USER_A_OWNER },
      ]);
      expect(await agentDraft(a.token)).toBe("");
      expect((await register()).token).not.toBe(a.token);
    });

    it("every minted token's secret part is new, and none is derived from its prefix", async () => {
      const rows =
        await owner`select private.agent_token_candidate() as t from generate_series(1, 50)`;
      const tokens = rows.map((r) => r.t as string);
      for (const t of tokens) expect(t).toMatch(AGENT_TOKEN_PATTERN);
      const secrets = tokens.map((t) => t.slice(13));
      expect(new Set(secrets).size).toBe(50);
      expect(new Set(tokens.map((t) => t.slice(4, 12))).size).toBe(50);
      // The secret is not a function of the prefix: not the prefix itself, nor its SHA-256 in either form.
      for (const t of tokens) {
        const prefix = t.slice(4, 12);
        const secret = t.slice(13);
        expect(secret).not.toContain(prefix);
        expect(secret).not.toBe(Buffer.from(hashAgentToken(prefix), "hex").toString("base64url"));
        expect(hashAgentToken(prefix)).not.toContain(secret.slice(0, 8));
      }
      // And through the one door: two registrations never share a secret.
      const a = await register();
      const b = await register();
      expect(a.token.slice(13)).not.toBe(b.token.slice(13));
    });

    it("a missing input is refused with a plain message that carries no row, hash or prefix", async () => {
      const calls: [string, string | null, string | null][] = [
        ["no name", null, USER_A_OWNER],
        ["no owner", "Unowned", null],
      ];
      for (const [what, name, ownerId] of calls) {
        const e = await asPerson(
          USER_A_OWNER,
          (tx) =>
            tx`select * from private.register_agent(${ORG_A}, ${name}, ${ownerId}, '{draft:email}')`,
        ).then(
          () => null,
          (x: unknown) => x as { message: string; detail?: string },
        );
        expect(e, what).not.toBeNull();
        expect(JSON.stringify(e), what).not.toMatch(
          /[0-9a-f]{64}|Failing row|[0-9a-f]{8}, registered/,
        );
        expect(e!.detail, what).toBeUndefined();
      }
      const noOrg = await errorOf(
        asPerson(
          USER_A_OWNER,
          (tx) =>
            tx`select * from private.register_agent(${null}, 'Nowhere', ${USER_A_OWNER}, '{draft:email}')`,
        ),
      );
      expect(noOrg).toMatch(/organisation not found/);
    });

    it("an admin of B registers one owned by a member of B, never by a user of another organisation", async () => {
      const reg = (org: string, ownerId: string) =>
        errorOf(registerAs(USER_BOTH, { org, ownerId, name: "Clinic triage" }));
      expect(await reg(ORG_B, USER_B_OWNER)).toBe("");
      expect(await reg(ORG_B, USER_A_OWNER)).toMatch(/owner must be a staff member/);
      // USER_BOTH is only a member of A, not an admin there; a member and a client viewer cannot register.
      expect(await reg(ORG_A, USER_BOTH)).toMatch(/organisation not found/);
      for (const by of [USER_A_MEMBER, USER_A_CLIENT])
        expect(await errorOf(registerAs(by, { ownerId: USER_A_OWNER }))).toMatch(
          /organisation not found/,
        );
      expect(await errorOf(registerAs(null, { ownerId: USER_A_OWNER }))).toMatch(
        /permission denied/,
      );
    });

    it("a new agent has no scope by default and can draft nothing (deny by default)", async () => {
      const a = await register({ scopes: [] });
      expect((await row(a.id)).scopes).toEqual([]);
      for (const kind of DRAFT_KINDS) expect(await agentDraft(a.token, kind)).toBe("denied: scope");
      const emailOnly = await register({ scopes: ["draft:email"] });
      expect(await agentDraft(emailOnly.token, "pull_request")).toBe("denied: scope");
    });
  });

  describe("what an admin cannot do", () => {
    it("cannot insert a row directly, so cannot choose a token, a hash or a prefix", async () => {
      const guessable = "gla_00000000_" + "a".repeat(43);
      for (const cols of [
        `(org_id, name, owner_id, token_sha256, token_prefix) values ('${ORG_A}', 'Forged', '${USER_A_OWNER}', '${hashAgentToken(guessable)}', '00000000')`,
        `(org_id, name, owner_id, token_sha256) values ('${ORG_A}', 'Forged', '${USER_A_OWNER}', '${hashAgentToken(guessable)}')`,
      ])
        expect(
          await personError(USER_A_OWNER, (tx) => tx.unsafe(`insert into public.agents ${cols}`)),
        ).toMatch(/permission denied/);
    });

    it("no answer confirms that another organisation's prefix or hash exists", async () => {
      const a = await register();
      // A direct insert naming A's prefix and hash is refused for want of a grant, not as a duplicate.
      const direct = await personError(USER_B_OWNER, (tx) =>
        tx.unsafe(`insert into public.agents (org_id, name, owner_id, token_sha256, token_prefix)
          values ('${ORG_B}', 'Probe', '${USER_B_OWNER}', '${hashAgentToken(a.token)}', '${a.prefix}')`),
      );
      expect(direct).toMatch(/permission denied/);
      expect(direct).not.toMatch(/duplicate|agents_token/);
      // A minted token that collides with A's is retried inside the function and never reported.
      await rolledBack(owner, async (tx) => {
        await tx`select set_config('test.collide', ${a.token}, true)`;
        await tx.unsafe(`create or replace function private.agent_token_candidate() returns text
          language plpgsql volatile set search_path = '' as $f$
          declare v text := pg_catalog.current_setting('test.collide', true);
          begin
            if v <> '' then perform pg_catalog.set_config('test.collide', '', true); return v; end if;
            return 'gla_' || pg_catalog.left(pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 8) || '_'
              || pg_catalog.left(pg_catalog.md5(pg_catalog.gen_random_uuid()::text)
                 || pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 43);
          end $f$`);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_B_OWNER })}, true)`;
        await tx.unsafe("set local role authenticated");
        const [r] =
          await tx`select * from private.register_agent(${ORG_B}, 'Collider', ${USER_B_OWNER}, '{draft:email}')`;
        expect(r!.token).not.toBe(a.token);
        expect(r!.token_prefix).not.toBe(a.prefix);
      });
      // Three collisions in a row: a refusal that names neither the prefix nor the hash.
      await rolledBack(owner, async (tx) => {
        await tx.unsafe(`create or replace function private.agent_token_candidate() returns text
          language sql volatile set search_path = '' as $f$ select '${a.token}' $f$`);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_B_OWNER })}, true)`;
        await tx.unsafe("set local role authenticated");
        const msg = await errorOf(
          tx`select * from private.register_agent(${ORG_B}, 'Collider', ${USER_B_OWNER}, '{draft:email}')`,
        );
        expect(msg).toMatch(/could not mint a new agent token/);
        expect(msg).not.toMatch(/duplicate|agents_token|prefix|sha256/);
      });
    });

    it("cannot grant a scope outside the closed list, or one scope twice", async () => {
      for (const s of ["write:publish", "draft:shell_exec", "admin", "read:secrets"])
        expect(await errorOf(registerAs(USER_A_OWNER, { scopes: ["draft:email", s] })), s).toMatch(
          /agents_scopes_known/,
        );
      expect(
        await errorOf(registerAs(USER_A_OWNER, { scopes: Array(5).fill("draft:email") })),
      ).toMatch(/each scope once/);
      // The refusal names the rule, never the row (which would carry the minted hash and prefix).
      const e = await registerAs(USER_A_OWNER, { scopes: ["write:publish"] }).catch(
        (x: unknown) => x as { detail?: string; message: string },
      );
      expect(JSON.stringify(e)).not.toMatch(/[0-9a-f]{64}|Failing row/);
      const a = await register();
      expect(
        await personError(
          USER_A_OWNER,
          (tx) =>
            tx`update public.agents set scopes = '{draft:email,draft:email}' where id = ${a.id}`,
        ),
      ).toMatch(/each scope once/);
    });

    it("cannot set created_at, last_used_at, revoked_at, revoked_by, the origin, the organisation or the hash", async () => {
      const a = await register();
      for (const set of [
        "last_used_at = now()",
        "created_at = now()",
        "revoked_at = now()",
        `revoked_by = '${USER_A_OWNER}'`,
        "origin = 'migrated_0005'",
        `org_id = '${ORG_B}'`,
        `token_sha256 = '${"0".repeat(64)}'`,
        "token_prefix = null",
      ])
        expect(
          await personError(USER_A_OWNER, (tx) =>
            tx.unsafe(`update public.agents set ${set} where id = '${a.id}'`),
          ),
          set,
        ).toMatch(/permission denied/);
    });

    it("cannot make a client viewer, nobody, or a member of another organisation the owner", async () => {
      for (const ownerId of [USER_A_CLIENT, USER_B_OWNER, null])
        expect(await errorOf(registerAs(USER_A_OWNER, { ownerId })), String(ownerId)).toMatch(
          /owner must be a staff member/,
        );
      const a = await register();
      for (const ownerId of [USER_A_CLIENT, USER_B_OWNER])
        expect(
          await personError(
            USER_A_OWNER,
            (tx) => tx`update public.agents set owner_id = ${ownerId} where id = ${a.id}`,
          ),
        ).toMatch(/owner must be a staff member/);
      // While the owner is still staff, nobody clears them by hand.
      expect(
        await personError(
          USER_A_OWNER,
          (tx) => tx`update public.agents set owner_id = null where id = ${a.id}`,
        ),
      ).toMatch(/keeps its owner while they are staff/);
    });

    it("a new row is never 'migrated' and always has a prefix, whoever inserts it", async () => {
      const msg = await errorOf(
        owner`insert into public.agents (org_id, name, owner_id, token_sha256, origin)
          values (${ORG_A}, 'Late migrant', ${USER_A_OWNER}, ${"1".repeat(64)}, 'migrated_0005')`,
      );
      expect(msg).toMatch(/agents_prefix_unless_migrated/);
    });
  });

  describe("who sees the registry", () => {
    const seen = (userId: string) =>
      asPerson(userId, async (tx) => ({
        agents: [...(await tx`select id, org_id from public.agents`)],
        events: [...(await tx`select agent_id from public.agent_events`)],
        shadow: [...(await tx`select id from public.agent_shadow_inventory`)],
      }));

    it("an owner sees their organisation's agents only; nobody signed in reads a token hash", async () => {
      await register();
      await register({ org: ORG_B, by: USER_B_OWNER });
      const a = await seen(USER_A_OWNER);
      expect(a.agents.length).toBeGreaterThan(0);
      expect(a.agents.every((r) => r.org_id === ORG_A)).toBe(true);
      const b = await seen(USER_B_OWNER);
      expect(b.agents.every((r) => r.org_id === ORG_B)).toBe(true);
      expect(
        await personError(USER_A_OWNER, (tx) => tx`select token_sha256 from public.agents`),
      ).toMatch(/permission denied/);
    });

    it("a member who is not an admin and a client viewer see nothing and change nothing", async () => {
      const a = await register();
      for (const userId of [USER_A_MEMBER, USER_A_CLIENT]) {
        expect(await seen(userId), userId).toEqual({ agents: [], events: [], shadow: [] });
        const updated = await asPerson(
          userId,
          (tx) => tx`update public.agents set status = 'disabled' where id = ${a.id} returning id`,
        );
        expect(updated).toHaveLength(0);
        expect(await personError(userId, (tx) => tx`select private.revoke_agent(${a.id})`)).toMatch(
          /agent not found/,
        );
      }
      expect((await row(a.id)).status).toBe("active");
    });

    it("anon, the agent's login, the server and the worker read nothing of the registry", async () => {
      for (const role of ["anon", "service_role", "gaugeline_worker"]) {
        for (const rel of [
          "public.agents",
          "public.agent_events",
          "public.agent_shadow_inventory",
        ]) {
          const msg = await errorOf(
            owner.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`select 1 from ${rel}`);
            }),
          );
          expect(msg, `${role} ${rel}`).toMatch(/permission denied/);
        }
      }
      for (const rel of ["public.agents", "public.agent_events", "public.agent_shadow_inventory"]) {
        const msg = await errorOf(
          agent.begin(async (tx) => {
            await tx.unsafe("set local role gaugeline_agent");
            await tx.unsafe(`select 1 from ${rel}`);
          }),
        );
        expect(msg, rel).toMatch(/permission denied/);
      }
    });
  });

  describe("revoke in one action (failing fixture: a revoked agent)", () => {
    it("one call sets the status, the time and who, writes the history, and the token stops working", async () => {
      const a = await register();
      expect(await agentDraft(a.token)).toBe("");
      const [r] = await asPerson(
        USER_A_OWNER,
        (tx) => tx`select * from private.revoke_agent(${a.id})`,
        true,
      );
      expect(r).toMatchObject({
        agent_id: a.id,
        agent_status: "revoked",
        agent_revoked_by: USER_A_OWNER,
      });
      expect(r!.agent_revoked_at).toBeInstanceOf(Date);
      expect(await agentDraft(a.token)).toBe("denied: revoked");
      expect(await history(a.id)).toEqual([
        { from_status: null, to_status: "active", changed_by: USER_A_OWNER },
        { from_status: "active", to_status: "revoked", changed_by: USER_A_OWNER },
      ]);
      // Again: nothing changes.
      const [again] = await asPerson(
        USER_A_OWNER,
        (tx) => tx`select * from private.revoke_agent(${a.id})`,
        true,
      );
      expect(again!.agent_revoked_at).toEqual(r!.agent_revoked_at);
      expect(await history(a.id)).toHaveLength(2);
    });

    it("revoking is final: no status, scope or name change, even for an owner", async () => {
      const a = await register();
      await asPerson(USER_A_OWNER, (tx) => tx`select private.revoke_agent(${a.id})`, true);
      for (const set of [
        "status = 'active'",
        "scopes = '{draft:email,read:runs}'",
        "name = 'Back again'",
      ])
        expect(
          await personError(USER_A_OWNER, (tx) =>
            tx.unsafe(`update public.agents set ${set} where id = '${a.id}'`),
          ),
          set,
        ).toMatch(/a revoked agent cannot change/);
    });

    it("another organisation's admin, a signed-out caller and the agent cannot revoke", async () => {
      const a = await register();
      expect(
        await personError(USER_B_OWNER, (tx) => tx`select private.revoke_agent(${a.id})`),
      ).toMatch(/agent not found/);
      expect(await personError(null, (tx) => tx`select private.revoke_agent(${a.id})`)).toMatch(
        /permission denied/,
      );
      expect(
        await errorOf(
          agent.begin(async (tx) => {
            await tx.unsafe("set local role gaugeline_agent");
            await tx`select private.revoke_agent(${a.id})`;
          }),
        ),
      ).toMatch(/permission denied/);
      expect((await row(a.id)).status).toBe("active");
    });

    it("a draft call that starts while a revoke is in flight is refused once the revoke commits", async () => {
      const a = await register();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const revoke = asPerson(
        USER_A_OWNER,
        async (tx) => {
          await tx`select private.revoke_agent(${a.id})`;
          locked();
          await held;
        },
        true,
      );
      await isLocked;
      const draft = agentDraft(a.token); // waits on the registry row's lock
      await new Promise((r) => setTimeout(r, 200));
      release();
      await revoke;
      expect(await draft).toBe("denied: revoked");
    });

    it("a disabled agent is refused until it is enabled again; both changes are in the history", async () => {
      const a = await register();
      const set = (status: string) =>
        asPerson(
          USER_A_OWNER,
          (tx) => tx`update public.agents set status = ${status} where id = ${a.id}`,
          true,
        );
      await set("disabled");
      expect(await agentDraft(a.token)).toBe("denied: disabled");
      expect((await row(a.id)).revoked_at).toBeNull();
      await set("active");
      expect(await agentDraft(a.token)).toBe("");
      expect((await history(a.id)).map((h) => h.to_status)).toEqual([
        "active",
        "disabled",
        "active",
      ]);
    });

    it("the history is append-only, for everyone", async () => {
      const a = await register();
      expect(
        await errorOf(
          owner`update public.agent_events set to_status = 'active' where agent_id = ${a.id}`,
        ),
      ).toMatch(/append-only/);
      expect(
        await errorOf(owner`delete from public.agent_events where agent_id = ${a.id}`),
      ).toMatch(/append-only/);
      expect(
        await personError(
          USER_A_OWNER,
          (tx) =>
            tx`insert into public.agent_events (org_id, agent_id, to_status) values (${ORG_A}, ${a.id}, 'revoked')`,
        ),
      ).toMatch(/permission denied/);
    });
  });

  describe("last used", () => {
    it("is set by a successful draft, not by a refused call or by reading the registry", async () => {
      const a = await register();
      await asPerson(
        USER_A_OWNER,
        (tx) => tx`select id, name, last_used_at from public.agents`,
        true,
      );
      expect((await row(a.id)).last_used_at).toBeNull();
      expect(await agentDraft(a.token, "pull_request")).toBe("denied: scope");
      expect(await agentDraft(a.token, "email", { subject: "x" })).toMatch(/payload/);
      expect((await row(a.id)).last_used_at).toBeNull();
      expect(await agentDraft(a.token)).toBe("");
      expect((await row(a.id)).last_used_at).toBeInstanceOf(Date);
    });
  });

  describe("the shadow-agent inventory", () => {
    const shadow = (userId = USER_A_OWNER) =>
      asPerson(userId, async (tx) => [
        ...(await tx`select id, reasons from public.agent_shadow_inventory order by id`),
      ]);
    const reasonsOf = async (id: string) => (await shadow()).find((r) => r.id === id)?.reasons;

    it("an owned agent used today is not flagged; one unused for 30 days, or never used since, is", async () => {
      const fresh = await register();
      expect(await agentDraft(fresh.token)).toBe("");
      expect(await reasonsOf(fresh.id)).toBeUndefined();
      const idle = await register();
      const used = await register();
      await owner.begin(async (tx) => {
        // Only the owner can backdate, and only with the registry's own triggers off.
        await tx.unsafe("set local session_replication_role = replica");
        await tx`update public.agents set created_at = now() - interval '40 days' where id in (${idle.id}, ${used.id})`;
        await tx`update public.agents set last_used_at = now() - interval '31 days' where id = ${used.id}`;
      });
      expect(await reasonsOf(idle.id)).toEqual(["unused-30-days"]);
      expect(await reasonsOf(used.id)).toEqual(["unused-30-days"]);
      await asPerson(USER_A_OWNER, (tx) => tx`select private.revoke_agent(${idle.id})`, true);
      expect(await reasonsOf(idle.id)).toBeUndefined();
    });

    it("an owner who leaves, or becomes a client viewer, leaves a flagged agent that still works", async () => {
      const leaver = "55555555-0000-4000-8000-000000000001";
      await owner`insert into public.members (org_id, user_id, role) values (${ORG_A}, ${leaver}, 'member')`;
      const a = await register({ ownerId: leaver });
      const b = await register({ ownerId: USER_A_MEMBER });
      await rolledBack(owner, async (tx) => {
        await tx`update public.members set role = 'client', site_id = ${SITE_A1} where org_id = ${ORG_A} and user_id = ${USER_A_MEMBER}`;
        const [r] = await tx`select reasons from public.agent_shadow_inventory where id = ${b.id}`;
        expect(r!.reasons).toEqual(["owner-not-staff"]);
      });
      await owner`delete from public.members where org_id = ${ORG_A} and user_id = ${leaver}`;
      expect((await row(a.id)).owner_id).toBeNull();
      expect(await reasonsOf(a.id)).toEqual(["no-owner"]);
      expect(await agentDraft(a.token)).toBe("");
      expect(await shadow(USER_A_MEMBER)).toEqual([]);
      expect((await shadow(USER_B_OWNER)).some((r) => r.id === a.id)).toBe(false);
    });

    it("the view's idle interval is SHADOW_IDLE_DAYS", async () => {
      const [v] =
        await owner`select pg_get_viewdef('public.agent_shadow_inventory'::regclass) as d`;
      expect(v!.d).toContain(`'${SHADOW_IDLE_DAYS} days'::interval`);
      expect(v!.d).toContain(`unused-${SHADOW_IDLE_DAYS}-days`);
    });
  });

  describe("migrating 0005's agent tokens", () => {
    it("moves each token in without an owner, flagged, still working; a revoked one stays refused", async () => {
      const old = await freshDatabase({ to: 11 });
      const live = ["gla", randomBytes(24).toString("hex")].join("_");
      const gone = ["gla", randomBytes(24).toString("hex")].join("_");
      try {
        await seed(old.sql);
        await old.sql`insert into private.agent_tokens (org_id, token_sha256, revoked_at) values
          (${ORG_A}, sha256(convert_to(${live}, 'UTF8')), null),
          (${ORG_A}, sha256(convert_to(${gone}, 'UTF8')), now())`;
        expect(await migrate(old.sql, MIGRATIONS_DIR)).toContain("0012_agent_registry");
        const rows =
          await old.sql`select name, owner_id, scopes, status, token_prefix, origin, token_sha256,
          revoked_at is not null as revoked from public.agents order by name`;
        expect(
          rows.map((r) => [
            r.name,
            r.owner_id,
            r.scopes,
            r.status,
            r.token_prefix,
            r.origin,
            r.revoked,
          ]),
        ).toEqual([
          ["Agent token 1", null, ALL_DRAFTS, "active", null, "migrated_0005", false],
          ["Agent token 2", null, ALL_DRAFTS, "revoked", null, "migrated_0005", true],
        ]);
        expect(rows[0]!.token_sha256).toBe(hashAgentToken(live));
        expect((await old.sql`select to_regclass('private.agent_tokens') as t`)[0]!.t).toBeNull();
        const draft = async (t: string) => {
          let id: unknown;
          const e = await errorOf(
            old.sql.begin(async (tx) => {
              await tx.unsafe("set local role gaugeline_agent");
              const [r] =
                await tx`select private.agent_insert_draft(${t}, ${SITE_A1}, 'email', ${tx.json(EMAIL)}) as id`;
              id = r!.id;
            }),
          );
          return e !== "" ? e : id === null ? "denied" : "";
        };
        expect(await draft(live)).toBe("");
        expect(await draft(gone)).toBe("denied");
        const flagged = await old.sql`select name, reasons from public.agent_shadow_inventory`;
        expect([...flagged]).toEqual([{ name: "Agent token 1", reasons: ["no-owner"] }]);
        const ev = await old.sql`select to_status, changed_by from public.agent_events order by id`;
        expect([...ev]).toEqual([
          { to_status: "active", changed_by: null },
          { to_status: "revoked", changed_by: null },
        ]);
      } finally {
        await old.drop();
      }
    });
  });

  describe("audit", () => {
    it("the agent role runs its three functions and reads no table; the login audits stay clean", async () => {
      expect(await privateFunctionsExecutableBy(owner, "gaugeline_agent")).toEqual([
        "agent_insert_draft",
        // AG-08 (0014): the two reads, each authorized with its own scope.
        "agent_list_pending",
        "agent_list_runs",
      ]);
      expect(await privateFunctionsExecutableBy(owner, "anon")).toEqual([]);
      expect(await agentLoginsWithOtherRoles(owner)).toEqual([]);
      const [g] = await owner`select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'gaugeline_agent'`;
      expect(g!.n).toBe(0);
      expect(await tablesWithoutRls(owner)).toEqual([]);
      expect(await viewsWithoutSecurityInvoker(owner)).toEqual([]);
      expect(await definerFunctionsWithoutEmptySearchPath(owner)).toEqual([]);
    });

    it("the docs example shows the refusal the policy gives (0013): a warning and nothing inserted", async () => {
      const docs = readFileSync(
        fileURLToPath(new URL("../../../../docs/hosted/agent-registry.md", import.meta.url)),
        "utf8",
      );
      expect(docs).toContain("WARNING:  agent call denied: revoked\n inserted\n----------\n f\n");
      const [fn] = await owner`select prosrc from pg_proc where proname = 'agent_deny'`;
      expect(String(fn!.prosrc)).toContain("raise warning 'agent call denied: %', p_reason");
    });

    it("the closed scope list in the database is the app's list", async () => {
      const [c] = await owner`select pg_get_constraintdef(oid) as d from pg_constraint
        where conname = 'agents_scopes_known'`;
      const listed = [...String(c!.d).matchAll(/'([a-z_]+:[a-z_-]+)'/g)].map((m) => m[1]);
      expect(listed).toEqual([...AGENT_SCOPES]);
    });
  });
});
