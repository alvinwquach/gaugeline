/**
 * Agent token expiry (AG-02b, migration 0018) against a real Postgres. An agent row has a nullable
 * `expires_at`: null never expires (every agent that exists before the migration), and an agent whose
 * `expires_at` has passed is refused exactly like a disabled one, on every path that authenticates a token.
 *
 * Every claim goes through REAL login roles (a person's, an agent's). No test depends on the day it runs:
 * each expiry is a number of minutes from the database's own now(), or one the test stamps itself.
 * Skipped without GAUGELINE_TEST_DATABASE_URL (see the db harness).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashAgentToken } from "../../agents/registry.js";
import { definerFunctionsWithoutEmptySearchPath, privateFunctionsExecutableBy } from "../audit.js";
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
const PERSON = `gl_exp_person_${tag}`;
const AGENT = `gl_exp_agent_${tag}`;
const PASSWORD = "expiry-test-login";
const EMAIL = { subject: "Your menu link is fixed", body: "The drinks page is back." };
/** The eleven reasons of the AG-03 deny list: expiry adds none (an expired agent reads as `disabled`). */
const REASONS = [
  "unknown-agent",
  "revoked",
  "disabled",
  "scope",
  "tool-not-allowed",
  "rate-limit",
  "cost-ceiling",
  "timeout",
  "kill-switch-agent",
  "kill-switch-global",
  "bad-input",
];

class Rollback extends Error {}

describe.skipIf(!HAS_DATABASE)("agent token expiry", () => {
  let db: TestDatabase;
  let owner: Sql;
  let person: Sql;
  let agent: Sql;

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
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop role if exists ${PERSON}; drop role if exists ${AGENT}`);
    await admin.end();
  });

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

  const register = async (
    over: { org?: string; by?: string; scopes?: string[] } = {},
  ): Promise<{ id: string; token: string }> => {
    const by = over.by ?? USER_A_OWNER;
    const [r] = await asPerson(
      by,
      (tx) =>
        tx`select * from private.register_agent(${over.org ?? ORG_A},
          ${`Expiry agent ${randomBytes(4).toString("hex")}`}, ${by},
          ${over.scopes ?? ["draft:email", "read:pending", "read:runs"]})`,
      true,
    );
    return { id: r!.agent_id as string, token: r!.token as string };
  };
  const row = async (id: string) => (await owner`select * from public.agents where id = ${id}`)[0]!;

  /**
   * Set the expiry as `by` through the one door, committed. `at` is SQL evaluated on the database clock
   * ("now() + interval '1 minute'"), `null` clears it. Returns the rows, or throws the database's error.
   */
  const setExpiry = (
    by: string | null,
    id: string,
    at: string | null,
    allowPast: boolean | null = false,
  ) =>
    asPerson(
      by,
      (tx) =>
        tx.unsafe(
          `select * from private.set_agent_expiry($1::uuid, (${at ?? "null"})::timestamptz, $2::boolean)`,
          [id, allowPast],
        ),
      true,
    );
  /** Stamp the expiry as the migration owner (the test's own clock: no token, no person). */
  const stamp = (id: string, at: string | null) =>
    owner.unsafe(`update public.agents set expires_at = ${at ?? "null"} where id = $1`, [id]);

  const draftCount = async () =>
    Number((await owner`select count(*) as n from public.drafts`)[0]!.n);
  const denyCount = async () =>
    Number((await owner`select count(*) as n from public.agent_denies`)[0]!.n);
  const lastDeny = async () =>
    (
      await owner`select reason, org_id, agent_id from public.agent_denies order by id desc limit 1`
    )[0];
  const lastTrace = async () =>
    (
      await owner`select decision, reason, agent_id from public.agent_trace order by id desc limit 1`
    )[0];

  /** The agent's draft call, committed: "" inserted, the error, or "denied: <reason>". */
  const agentDraft = async (token: string, kind = "email") => {
    let id: unknown;
    const e = await errorOf(
      agent.begin(async (tx) => {
        await tx.unsafe("set local role gaugeline_agent");
        const [r] =
          await tx`select private.agent_insert_draft(${token}, ${SITE_A1}, ${kind}, ${tx.json(EMAIL as never)}) as id`;
        id = r!.id;
      }),
    );
    if (e !== "" || id !== null) return e;
    return `denied: ${(await lastDeny())!.reason as string}`;
  };
  /** The two reads, committed, as the agent's login: the jsonb each returns. */
  const agentReads = async (token: string) =>
    agent.begin(async (tx) => {
      await tx.unsafe("set local role gaugeline_agent");
      const [p] =
        await tx`select private.agent_list_pending(${token}, 50, null, null, null, null) as r`;
      const [h] =
        await tx`select private.agent_list_runs(${token}, ${SITE_A1}::uuid, 20, null, null) as r`;
      return { pending: p!.r as { allowed?: boolean; reason?: string }, runs: h!.r as typeof p };
    });
  const authorize = async (token: string, tool = "draft:email") => {
    const [z] = await owner`select * from private.agent_authorize(${token}, ${tool}, 0)`;
    return z as { allowed: boolean; reason: string | null };
  };

  describe("the column (passing fixture: no expiry means never)", () => {
    it("is a nullable timestamptz, null for a new agent, which works", async () => {
      const [c] =
        await owner`select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'agents' and column_name = 'expires_at'`;
      expect(c).toEqual({
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      });
      const a = await register();
      expect((await row(a.id)).expires_at).toBeNull();
      expect(await agentDraft(a.token)).toBe("");
    });

    it("an owner or admin reads it; nobody signed in writes it directly, and the agent's role cannot read it", async () => {
      const a = await register();
      await setExpiry(USER_A_OWNER, a.id, "now() + interval '1 hour'");
      const seen = await asPerson(USER_A_OWNER, (tx) => tx`select expires_at from public.agents`);
      expect(seen.some((r) => r.expires_at instanceof Date)).toBe(true);
      expect(
        await personError(
          USER_A_OWNER,
          (tx) => tx`update public.agents set expires_at = null where id = ${a.id}`,
        ),
      ).toMatch(/permission denied/);
      expect(
        await personError(
          USER_A_OWNER,
          (tx) =>
            tx`update public.agents set expires_at = now() - interval '1 day' where id = ${a.id}`,
        ),
      ).toMatch(/permission denied/);
      expect(
        await errorOf(
          agent.begin(async (tx) => {
            await tx.unsafe("set local role gaugeline_agent");
            await tx.unsafe("select expires_at from public.agents");
          }),
        ),
      ).toMatch(/permission denied/);
    });

    it("an agent that existed before the migration has a null expiry and keeps working", async () => {
      const old = await freshDatabase({ to: 17 });
      const token = ["gla", randomBytes(24).toString("hex")].join("_");
      try {
        await seed(old.sql);
        await old.sql`insert into public.agents (org_id, name, owner_id, scopes, token_sha256, token_prefix)
          values (${ORG_A}, 'Old agent', ${USER_A_OWNER}, '{draft:email}', ${hashAgentToken(token)},
                  ${token.slice(4, 12)})`;
        expect(await migrate(old.sql, MIGRATIONS_DIR)).toEqual(["0018_agent_token_expiry"]);
        const [a] = await old.sql`select expires_at from public.agents where name = 'Old agent'`;
        expect(a!.expires_at).toBeNull();
        let id: unknown;
        await old.sql.begin(async (tx) => {
          await tx.unsafe("set local role gaugeline_agent");
          [{ id }] =
            await tx`select private.agent_insert_draft(${token}, ${SITE_A1}, 'email', ${tx.json(EMAIL as never)}) as id`;
        });
        expect(id).not.toBeNull();
      } finally {
        await old.drop();
      }
    });
  });

  describe("setting and clearing it (private.set_agent_expiry)", () => {
    it("an owner sets a future expiry and clears it; the token works before it passes and after it is cleared", async () => {
      const a = await register();
      const [r] = await setExpiry(USER_A_OWNER, a.id, "now() + interval '1 minute'");
      expect(r!.agent_id).toBe(a.id);
      expect(r!.agent_expires_at).toBeInstanceOf(Date);
      expect(((await row(a.id)).expires_at as Date).getTime()).toBe(
        (r!.agent_expires_at as Date).getTime(),
      );
      expect(await agentDraft(a.token)).toBe("");
      const [c] = await setExpiry(USER_A_OWNER, a.id, null);
      expect(c!.agent_expires_at).toBeNull();
      expect((await row(a.id)).expires_at).toBeNull();
      expect(await agentDraft(a.token)).toBe("");
    });

    it("an admin of the organisation can too (no new role)", async () => {
      const b = await register({ org: ORG_B, by: USER_B_OWNER });
      const [r] = await setExpiry(USER_BOTH, b.id, "now() + interval '1 day'"); // an admin of B
      expect(r!.agent_expires_at).toBeInstanceOf(Date);
    });

    it("a time in the past is refused unless the caller says so on purpose, and nothing changes", async () => {
      const a = await register();
      for (const allow of [false, null])
        expect(
          await errorOf(setExpiry(USER_A_OWNER, a.id, "now() - interval '1 minute'", allow)),
          String(allow),
        ).toMatch(/in the past/);
      expect(await errorOf(setExpiry(USER_A_OWNER, a.id, "now()", false))).toMatch(/in the past/);
      expect((await row(a.id)).expires_at).toBeNull();
      expect(await agentDraft(a.token)).toBe("");
      const [r] = await setExpiry(USER_A_OWNER, a.id, "now() - interval '1 minute'", true);
      expect(r!.agent_expires_at).toBeInstanceOf(Date);
      expect(await agentDraft(a.token)).toBe("denied: disabled");
    });

    it("a time that is not a date and time (infinity) is refused: clear it to never expire", async () => {
      const a = await register();
      for (const at of ["'infinity'", "'-infinity'"])
        expect(await errorOf(setExpiry(USER_A_OWNER, a.id, at, true)), at).toMatch(/clear it/);
      expect((await row(a.id)).expires_at).toBeNull();
    });

    it("a member, a client viewer, a signed-out caller and another organisation's owner cannot, and change nothing", async () => {
      const a = await register();
      for (const who of [USER_A_MEMBER, USER_A_CLIENT, USER_B_OWNER])
        expect(await errorOf(setExpiry(who, a.id, "now() + interval '1 hour'")), who).toMatch(
          /agent not found/,
        );
      expect(await errorOf(setExpiry(null, a.id, "now() + interval '1 hour'"))).toMatch(
        /permission denied|sign in/,
      );
      // A member of one agency who is admin of another cannot set the first agency's agent either.
      expect(await errorOf(setExpiry(USER_BOTH, a.id, "now() + interval '1 hour'"))).toMatch(
        /agent not found/,
      );
      // An agent id that does not exist reads the same as another organisation's.
      expect(
        await errorOf(
          setExpiry(
            USER_A_OWNER,
            "00000000-0000-4000-8000-000000000000",
            "now() + interval '1 hour'",
          ),
        ),
      ).toMatch(/agent not found/);
      expect((await row(a.id)).expires_at).toBeNull();
    });

    it("the agent cannot set or clear its own expiry: its role may not call the function", async () => {
      const a = await register();
      await setExpiry(USER_A_OWNER, a.id, "now() + interval '1 hour'");
      const before = (await row(a.id)).expires_at as Date;
      for (const call of [
        `select private.set_agent_expiry('${a.id}', null, false)`,
        `select private.set_agent_expiry('${a.id}', now() + interval '1 year', false)`,
      ])
        expect(
          await errorOf(
            agent.begin(async (tx) => {
              await tx.unsafe("set local role gaugeline_agent");
              await tx.unsafe(call);
            }),
          ),
        ).toMatch(/permission denied/);
      expect(((await row(a.id)).expires_at as Date).getTime()).toBe(before.getTime());
    });

    it("a revoked agent's expiry cannot change: revoking is final", async () => {
      const a = await register();
      await setExpiry(USER_A_OWNER, a.id, "now() + interval '1 hour'");
      await asPerson(USER_A_OWNER, (tx) => tx`select private.revoke_agent(${a.id})`, true);
      expect(await errorOf(setExpiry(USER_A_OWNER, a.id, null))).toMatch(
        /revoked agent cannot change/,
      );
      expect((await row(a.id)).expires_at).toBeInstanceOf(Date);
    });
  });

  describe("an expired token is refused on every path (failing fixture: past expiry)", () => {
    it("a draft is refused as `disabled`, logged and traced, inserts nothing and uses no slot or time of use", async () => {
      const a = await register();
      expect(await agentDraft(a.token)).toBe("");
      const [used] = await owner`select last_used_at from public.agents where id = ${a.id}`;
      const [lim] = await owner`select window_calls, cost_day_micros from public.agent_limits
        where agent_id = ${a.id}`;
      await stamp(a.id, "now() - interval '1 minute'");
      const [drafts, denies] = [await draftCount(), await denyCount()];
      expect(await agentDraft(a.token)).toBe("denied: disabled");
      expect(await draftCount()).toBe(drafts);
      expect(await denyCount()).toBe(denies + 1);
      expect(await lastDeny()).toMatchObject({ reason: "disabled", org_id: ORG_A, agent_id: a.id });
      expect(await lastTrace()).toMatchObject({
        decision: "denied",
        reason: "disabled",
        agent_id: a.id,
      });
      expect((await owner`select last_used_at from public.agents where id = ${a.id}`)[0]).toEqual(
        used,
      );
      expect(
        (
          await owner`select window_calls, cost_day_micros from public.agent_limits where agent_id = ${a.id}`
        )[0],
      ).toEqual(lim);
    });

    it("both reads are refused as `disabled`, and nothing of the organisation is returned", async () => {
      const a = await register();
      expect((await agentReads(a.token)).pending.allowed).toBe(true);
      await stamp(a.id, "now() - interval '1 minute'");
      const r = await agentReads(a.token);
      expect(r.pending).toEqual({ allowed: false, reason: "disabled" });
      expect(r.runs).toEqual({ allowed: false, reason: "disabled" });
      expect(await lastDeny()).toMatchObject({ reason: "disabled", agent_id: a.id });
      expect(await lastTrace()).toMatchObject({ decision: "denied", reason: "disabled" });
    });

    it("the policy's own entry point says no, for every tool", async () => {
      const a = await register();
      await stamp(a.id, "now() - interval '1 minute'");
      for (const tool of ["draft:email", "read:pending", "read:runs", "draft:pull_request"])
        expect(await authorize(a.token, tool), tool).toMatchObject({
          allowed: false,
          reason: "disabled",
        });
    });

    it("the refusal is the one a disabled agent gets: same reason, same answer, nothing new says why", async () => {
      const gone = await register();
      const off = await register();
      await stamp(gone.id, "now() - interval '1 minute'");
      await owner`update public.agents set status = 'disabled' where id = ${off.id}`;
      expect(await agentDraft(gone.token)).toBe(await agentDraft(off.token));
      expect(await agentReads(gone.token)).toEqual(await agentReads(off.token));
      expect(await authorize(gone.token)).toEqual(
        expect.objectContaining({ allowed: false, reason: "disabled" }),
      );
      // The deny rows differ in the agent's id only: no expiry time, no word `expired`.
      const rows = await owner`select * from public.agent_denies order by id desc limit 2`;
      expect(JSON.stringify(rows)).not.toMatch(/expir/i);
    });

    it("the eleven reason codes are unchanged in the deny log, the trace and its counters", async () => {
      const listed = async (conname: string) => {
        const [c] = await owner`select pg_get_constraintdef(oid) as d from pg_constraint
          where conname = ${conname}`;
        return [...String(c!.d).matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]).sort();
      };
      expect(await listed("agent_denies_reason_known")).toEqual([...REASONS].sort());
      expect(await listed("agent_trace_reason_known")).toEqual([...REASONS].sort());
      const [o] =
        await owner`select string_agg(pg_get_constraintdef(oid), ' ') as d from pg_constraint
        where conrelid = 'public.agent_trace_overflow'::regclass and contype = 'c'`;
      for (const r of REASONS) expect(String(o!.d)).toContain(`'${r}'`);
      expect((String(o!.d).match(/'[a-z]+(-[a-z]+)*'::text/g) ?? []).length).toBeGreaterThanOrEqual(
        REASONS.length,
      );
    });

    it("order of reasons: revoked beats expired, the operator's global switch beats expired", async () => {
      const a = await register();
      await stamp(a.id, "now() - interval '1 minute'");
      await owner`update public.agents set status = 'revoked' where id = ${a.id}`;
      expect(await agentDraft(a.token)).toBe("denied: revoked");
      const b = await register();
      await stamp(b.id, "now() - interval '1 minute'");
      await owner`insert into private.agent_switches (agent_id) values (null)`;
      try {
        expect(await agentDraft(b.token)).toBe("denied: kill-switch-global");
      } finally {
        await owner`delete from private.agent_switches where agent_id is null`;
      }
    });

    it("an unknown token still reads as unknown, never as expired", async () => {
      expect(await agentDraft(["gla", randomBytes(24).toString("hex")].join("_"))).toBe(
        "denied: unknown-agent",
      );
    });

    it("the instant it passes: an expiry of now() is already refused, one a minute ahead is not", async () => {
      const a = await register();
      await stamp(a.id, "now()");
      expect(await authorize(a.token)).toMatchObject({ allowed: false, reason: "disabled" });
      await stamp(a.id, "now() + interval '1 minute'");
      expect(await authorize(a.token)).toMatchObject({ allowed: true });
      await stamp(a.id, "now() - interval '1 second'"); // time passing, as far as the database can tell
      expect(await authorize(a.token)).toMatchObject({ allowed: false, reason: "disabled" });
    });

    it("an expiry that falls inside a long transaction is honoured by the call's own clock", async () => {
      const a = await register();
      await stamp(a.id, "now() + interval '1 minute'");
      await rolledBack(owner, async (tx) => {
        // The transaction's now() stays where it started: the call must not use it.
        await tx`select pg_catalog.pg_sleep(0)`;
        await tx`update public.agents set expires_at = pg_catalog.clock_timestamp() - interval '1 millisecond' where id = ${a.id}`;
        const [z] = await tx`select * from private.agent_authorize(${a.token}, 'draft:email', 0)`;
        expect(z).toMatchObject({ allowed: false, reason: "disabled" });
      });
    });

    it("an owner can bring an expired agent back by setting a later time or clearing it: explicit, and the token is the same", async () => {
      const a = await register();
      await setExpiry(USER_A_OWNER, a.id, "now() - interval '1 minute'", true);
      expect(await agentDraft(a.token)).toBe("denied: disabled");
      await setExpiry(USER_A_OWNER, a.id, "now() + interval '1 hour'");
      expect(await agentDraft(a.token)).toBe("");
      await setExpiry(USER_A_OWNER, a.id, "now() - interval '1 minute'", true);
      expect(await agentDraft(a.token)).toBe("denied: disabled");
      await setExpiry(USER_A_OWNER, a.id, null);
      expect(await agentDraft(a.token)).toBe("");
    });
  });

  describe("tenancy", () => {
    it("org A's owner cannot set, read or clear org B's agent expiry; org B's owner sees only its own", async () => {
      const b = await register({ org: ORG_B, by: USER_B_OWNER });
      await setExpiry(USER_B_OWNER, b.id, "now() + interval '1 hour'");
      const before = (await row(b.id)).expires_at as Date;
      expect(await errorOf(setExpiry(USER_A_OWNER, b.id, null))).toMatch(/agent not found/);
      expect(
        await errorOf(setExpiry(USER_A_OWNER, b.id, "now() - interval '1 day'", true)),
      ).toMatch(/agent not found/);
      expect(((await row(b.id)).expires_at as Date).getTime()).toBe(before.getTime());
      const seenByA = await asPerson(USER_A_OWNER, (tx) => tx`select id from public.agents`);
      expect(seenByA.some((r) => r.id === b.id)).toBe(false);
    });

    it("expiring org A's agent leaves org B's agents alone", async () => {
      const a = await register();
      const b = await register({ org: ORG_B, by: USER_B_OWNER });
      await setExpiry(USER_A_OWNER, a.id, "now() - interval '1 minute'", true);
      expect((await row(b.id)).expires_at).toBeNull();
      expect(await authorize(b.token)).toMatchObject({ allowed: true });
    });
  });

  describe("the function's rules (audit)", () => {
    it("only a signed-in person's role can run it, it pins an empty search_path, and the agent's list is unchanged", async () => {
      expect(await privateFunctionsExecutableBy(owner, "authenticated")).toContain(
        "set_agent_expiry",
      );
      for (const role of ["anon", "service_role", "gaugeline_worker", "gaugeline_agent"])
        expect(await privateFunctionsExecutableBy(owner, role), role).not.toContain(
          "set_agent_expiry",
        );
      const [p] = await owner`select p.prosecdef, p.proconfig from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = 'set_agent_expiry'`;
      expect([p!.prosecdef, p!.proconfig]).toEqual([true, ['search_path=""']]);
      expect(await definerFunctionsWithoutEmptySearchPath(owner)).toEqual([]);
      const [pub] = await owner`select has_function_privilege('public',
        'private.set_agent_expiry(uuid, timestamptz, boolean)', 'execute') as x`;
      expect(pub!.x).toBe(false);
      expect(await privateFunctionsExecutableBy(owner, "gaugeline_agent")).toEqual([
        "agent_insert_draft",
        "agent_list_pending",
        "agent_list_runs",
      ]);
    });
  });

  describe("the docs page", () => {
    it("shows the refusal and the messages the database gives (agent-registry.md, token expiry)", async () => {
      const docs = readFileSync(
        fileURLToPath(new URL("../../../../docs/hosted/agent-registry.md", import.meta.url)),
        "utf8",
      );
      expect(docs).toContain("WARNING:  agent call denied: disabled\n inserted\n----------\n f\n");
      const [fn] = await owner`select prosrc from pg_proc where proname = 'set_agent_expiry'`;
      const shown = docs
        .split("\n")
        .filter((l) => l.startsWith("ERROR:  ") && /in the past|not found/.test(l));
      expect(shown.length).toBeGreaterThan(0);
      for (const line of shown)
        expect(String(fn!.prosrc), line).toContain(line.slice("ERROR:  ".length));
      expect(docs).toContain("ERROR:  permission denied for function set_agent_expiry");
    });
  });

  // Mutation-style: take the real function, remove one rule, and show the scenario above would now fail.
  // Each runs in a transaction that is rolled back, so the real functions are never touched.
  describe("each rule is what stops the call (mutations)", () => {
    const defOf = async (tx: Sql, sig: string) =>
      String((await tx`select pg_get_functiondef(${sig}::regprocedure) as d`)[0]!.d);

    it("without the expiry clause in agent_authorize an expired token is allowed", async () => {
      const a = await register();
      await stamp(a.id, "now() - interval '1 minute'");
      expect(await authorize(a.token)).toMatchObject({ allowed: false });
      await rolledBack(owner, async (tx) => {
        const def = await defOf(tx as unknown as Sql, "private.agent_authorize(text,text,bigint)");
        const mutated = def.replace(" or v_expired", "");
        expect(mutated).not.toBe(def);
        await tx.unsafe(mutated);
        const [z] = await tx`select * from private.agent_authorize(${a.token}, 'draft:email', 0)`;
        expect(z!.allowed).toBe(true);
      });
      expect(await authorize(a.token)).toMatchObject({ allowed: false });
    });

    it("without the past-time guard, a mistyped past date silently ends the token", async () => {
      const a = await register();
      await rolledBack(owner, async (tx) => {
        const def = await defOf(
          tx as unknown as Sql,
          "private.set_agent_expiry(uuid,timestamptz,boolean)",
        );
        const mutated = def.replace("and not coalesce(p_allow_past, false)", "and false");
        expect(mutated).not.toBe(def);
        await tx.unsafe(mutated);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A_OWNER })}, true)`;
        await tx.unsafe("set local role authenticated");
        const [r] = await tx.unsafe(
          `select * from private.set_agent_expiry('${a.id}', now() - interval '1 day', false)`,
        );
        expect(r!.agent_expires_at).toBeInstanceOf(Date);
      });
      expect((await row(a.id)).expires_at).toBeNull();
    });

    it("without the organisation check, another organisation's owner could set the expiry", async () => {
      const a = await register();
      await rolledBack(owner, async (tx) => {
        const def = await defOf(
          tx as unknown as Sql,
          "private.set_agent_expiry(uuid,timestamptz,boolean)",
        );
        const mutated = def.replace("m.org_id = a.org_id and ", "");
        expect(mutated).not.toBe(def);
        await tx.unsafe(mutated);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_B_OWNER })}, true)`;
        await tx.unsafe("set local role authenticated");
        const rows = await tx.unsafe(
          `select * from private.set_agent_expiry('${a.id}', now() + interval '1 day', false)`,
        );
        expect(rows).toHaveLength(1);
      });
      expect((await row(a.id)).expires_at).toBeNull();
    });
  });
});
