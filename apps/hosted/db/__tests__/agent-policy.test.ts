/**
 * Agent policy and limits (AG-03) against a real Postgres, through REAL login roles: a person's login (a
 * member of `authenticated` only) and an agent's login (a member of `gaugeline_agent` only). The migration
 * owner sets things up, throws the operator's kill switches and calls private.agent_authorize directly
 * (no login may). Skipped without GAUGELINE_TEST_DATABASE_URL (see the db harness).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_SCOPES } from "../../agents/registry.js";
import {
  agentLoginsWithOtherRoles,
  definerFunctionsWithoutEmptySearchPath,
  privateFunctionsExecutableBy,
  tablesWithoutRls,
} from "../audit.js";
import {
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  SITE_A1,
  SITE_B1,
  seed,
  type Sql,
  TEST_DATABASE_URL,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
} from "./harness.js";

const tag = randomBytes(4).toString("hex");
const PERSON = `gl_pol_person_${tag}`;
const AGENT = `gl_pol_agent_${tag}`;
const PASSWORD = "policy-test-login";
const EMAIL = { subject: "Your menu link is fixed", body: "The drinks page is back." };
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
const LIMIT_DEFAULTS = {
  calls_per_window: 10,
  window_seconds: 60,
  cost_ceiling_micros: "1000000",
  timeout_ms: 5000,
};

class Rollback extends Error {}

describe.skipIf(!HAS_DATABASE)("agent policy and limits", () => {
  let db: TestDatabase;
  let owner: Sql;
  let person: Sql;
  let agent: Sql;
  const warnings: string[] = [];

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
    agent = postgres(loginUrl(AGENT), {
      max: 16,
      onnotice: (n) => warnings.push(`${n.severity}: ${n.message}`),
    });
  });
  afterAll(async () => {
    await person?.end();
    await agent?.end();
    await db?.drop();
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop role if exists ${PERSON}; drop role if exists ${AGENT}`);
    await admin.end();
  });

  /** Run `fn` on the person's login as `userId`; roll back unless `commit`. */
  async function asPerson<T>(
    userId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    commit = false,
  ): Promise<T> {
    let out: T | undefined;
    try {
      await person.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`;
        await tx.unsafe("set local role authenticated");
        out = await fn(tx);
        if (!commit) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return out as T;
  }
  const personError = (userId: string, fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    errorOf(asPerson(userId, fn));

  /** A committed agent of `org`, registered through the one door by that organisation's owner. */
  async function register(
    scopes: string[] = ["draft:email"],
    org = ORG_A,
  ): Promise<{ id: string; token: string }> {
    const by = org === ORG_A ? USER_A_OWNER : USER_B_OWNER;
    const [r] = await asPerson(
      by,
      (tx) =>
        tx`select * from private.register_agent(${org}, ${`Policy agent ${randomBytes(4).toString("hex")}`}, ${by}, ${scopes})`,
      true,
    );
    return { id: r!.agent_id as string, token: r!.token as string };
  }
  /** Set an agent's limits as the owner of its organisation (the person's login, committed). */
  const setLimits = (id: string, set: Record<string, number>, by = USER_A_OWNER) =>
    asPerson(
      by,
      (tx) =>
        tx`update public.agent_limits set ${tx(set)} where agent_id = ${id} returning agent_id`,
      true,
    );

  /**
   * The agent's own login drafts with `token` and commits. "ok" when a draft was inserted, "denied" when
   * the policy refused it (null, no exception), or the error.
   */
  async function call(
    token: string | null,
    kind: string | null = "email",
    site = SITE_A1,
    payload: object = EMAIL,
  ): Promise<string> {
    let id: unknown;
    const e = await errorOf(
      agent.begin(async (tx) => {
        await tx.unsafe("set local role gaugeline_agent");
        const [r] =
          await tx`select private.agent_insert_draft(${token}, ${site}, ${kind}, ${tx.json(payload as never)}) as id`;
        id = r!.id;
      }),
    );
    if (e !== "") return e;
    return id === null ? "denied" : "ok";
  }
  const lastDenyId = async () =>
    Number((await owner`select coalesce(max(id), 0) as n from public.agent_denies`)[0]!.n);
  const deniesSince = (since: number) =>
    owner`select org_id, agent_id, tool, reason from public.agent_denies where id > ${since} order by id`;
  const drafts = async () => Number((await owner`select count(*) as n from public.drafts`)[0]!.n);
  const globalSwitch = (on: boolean) =>
    on
      ? owner`insert into private.agent_switches (agent_id) values (null)`
      : owner`delete from private.agent_switches where agent_id is null`;

  describe("deny by default (failing fixture: a new agent with no tools)", () => {
    it("a new agent has no tool, the default limits, and its call is refused, logged and inserts nothing", async () => {
      const a = await register([]);
      const [l] =
        await owner`select calls_per_window, window_seconds, cost_ceiling_micros, timeout_ms
        from public.agent_limits where agent_id = ${a.id}`;
      expect({ ...l }).toEqual(LIMIT_DEFAULTS);
      const since = await lastDenyId();
      const before = await drafts();
      expect(await call(a.token)).toBe("denied");
      expect(await drafts()).toBe(before);
      expect([...(await deniesSince(since))]).toEqual([
        { org_id: ORG_A, agent_id: a.id, tool: "draft:email", reason: "scope" },
      ]);
    });

    it("passing fixture: an agent with the scope drafts, and nothing is logged as a deny", async () => {
      const a = await register(["draft:email"]);
      const since = await lastDenyId();
      expect(await call(a.token)).toBe("ok");
      expect(await deniesSince(since)).toHaveLength(0);
      const [l] =
        await owner`select window_calls, cost_day_micros from public.agent_limits where agent_id = ${a.id}`;
      // A draft calls no model: its declared cost is 0 units.
      expect({ ...l }).toEqual({ window_calls: 1, cost_day_micros: "0" });
    });
  });

  describe("every reason code produces exactly one logged deny, and the call inserts nothing", () => {
    /** `setUpDrafts`: drafts the set-up itself makes (the allowed call before a rate-limit deny). */
    type Case = {
      reason: string;
      setUpDrafts?: number;
      run: () => Promise<{ result: string; agentId: string | null }>;
    };
    const cases: Case[] = [
      {
        reason: "unknown-agent",
        run: async () => ({
          result: await call(`gla_${randomBytes(32).toString("hex")}`),
          agentId: null,
        }),
      },
      {
        reason: "revoked",
        run: async () => {
          const a = await register();
          await asPerson(USER_A_OWNER, (tx) => tx`select private.revoke_agent(${a.id})`, true);
          return { result: await call(a.token), agentId: a.id };
        },
      },
      {
        reason: "disabled",
        run: async () => {
          const a = await register();
          await asPerson(
            USER_A_OWNER,
            (tx) => tx`update public.agents set status = 'disabled' where id = ${a.id}`,
            true,
          );
          return { result: await call(a.token), agentId: a.id };
        },
      },
      {
        reason: "kill-switch-agent",
        run: async () => {
          const a = await register();
          await owner`insert into private.agent_switches (agent_id) values (${a.id})`;
          return { result: await call(a.token), agentId: a.id };
        },
      },
      {
        reason: "kill-switch-global",
        run: async () => {
          const a = await register();
          await globalSwitch(true);
          try {
            return { result: await call(a.token), agentId: a.id };
          } finally {
            await globalSwitch(false);
          }
        },
      },
      {
        reason: "bad-input",
        run: async () => {
          const a = await register();
          return { result: await call(a.token, null), agentId: a.id };
        },
      },
      {
        reason: "tool-not-allowed",
        run: async () => {
          const a = await register();
          return { result: await call(a.token, "shell_exec"), agentId: a.id };
        },
      },
      {
        reason: "scope",
        run: async () => {
          const a = await register(["draft:email"]);
          return { result: await call(a.token, "pull_request"), agentId: a.id };
        },
      },
      {
        reason: "rate-limit",
        setUpDrafts: 1,
        run: async () => {
          const a = await register();
          await setLimits(a.id, { calls_per_window: 1 });
          expect(await call(a.token)).toBe("ok");
          return { result: await call(a.token), agentId: a.id };
        },
      },
      {
        reason: "timeout",
        run: async () => {
          const a = await register();
          await setLimits(a.id, { timeout_ms: 100 });
          // Another caller holds the site's draft lock longer than the agent's deadline.
          let release!: () => void;
          const held = new Promise<void>((r) => (release = r));
          let locked!: () => void;
          const isLocked = new Promise<void>((r) => (locked = r));
          const holder = owner.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtextextended(${SITE_A1}::text, 0))`;
            locked();
            await held;
          });
          await isLocked;
          try {
            return { result: await call(a.token), agentId: a.id };
          } finally {
            release();
            await holder;
          }
        },
      },
    ];

    for (const c of cases)
      it(c.reason, async () => {
        const since = await lastDenyId();
        const before = await drafts();
        const { result, agentId } = await c.run();
        expect(result).toBe("denied");
        expect(await drafts()).toBe(before + (c.setUpDrafts ?? 0));
        const rows = await deniesSince(since);
        expect(rows.map((r) => [r.reason, r.agent_id])).toEqual([[c.reason, agentId]]);
        if (agentId === null) expect(rows[0]!.org_id).toBeNull();
        else expect(rows[0]!.org_id).toBe(ORG_A);
      });

    it("cost-ceiling: the units a call declares are counted per day against the ceiling", async () => {
      const a = await register(["read:pending"]);
      await setLimits(a.id, { cost_ceiling_micros: 5 });
      const authorize = async (cost: number | null) =>
        (
          await owner`select allowed, reason from private.agent_authorize(${a.token}, 'read:pending', ${cost})`
        )[0]!;
      const since = await lastDenyId();
      expect(await authorize(3)).toEqual({ allowed: true, reason: null });
      expect(await authorize(2)).toEqual({ allowed: true, reason: null });
      expect(await authorize(1)).toEqual({ allowed: false, reason: "cost-ceiling" });
      expect(await authorize(0)).toEqual({ allowed: true, reason: null });
      // A cost that is missing, negative or absurd is bad input, never "free".
      for (const cost of [null, -1, 2e12])
        expect(await authorize(cost), String(cost)).toEqual({
          allowed: false,
          reason: "bad-input",
        });
      const rows = await owner`select reason, cost_micros, cost_day_micros, tool
        from public.agent_denies where id > ${since} order by id`;
      expect(rows.map((r) => [r.reason, r.cost_micros, r.cost_day_micros, r.tool])).toEqual([
        ["cost-ceiling", "1", "5", "read:pending"],
        ["bad-input", null, "5", "read:pending"],
        ["bad-input", null, "5", "read:pending"],
        ["bad-input", null, "5", "read:pending"],
      ]);
    });

    it("bad-input: a tool name over 64 characters is bad input, not an unknown tool", async () => {
      const a = await register(["read:pending"]);
      const authorize = async (tool: string) =>
        (
          await owner`select allowed, reason from private.agent_authorize(${a.token}, ${tool}, 0)`
        )[0]!;
      expect(await authorize("x".repeat(65))).toEqual({ allowed: false, reason: "bad-input" });
      expect(await authorize("x".repeat(64))).toEqual({
        allowed: false,
        reason: "tool-not-allowed",
      });
    });

    it("timeout: a call that reaches the policy after its deadline is refused and not counted", async () => {
      const a = await register(["read:pending"]);
      await setLimits(a.id, { timeout_ms: 100 });
      const since = await lastDenyId();
      // The deadline runs from the start of the statement: this one sleeps past it before asking.
      await owner.unsafe(`do $$ begin
        perform pg_catalog.pg_sleep(0.3);
        perform private.agent_authorize('${a.token}', 'read:pending', 0);
      end $$`);
      const rows = await owner`select reason, agent_id, window_calls, cost_day_micros
        from public.agent_denies where id > ${since} order by id`;
      expect(rows.map((r) => ({ ...r }))).toEqual([
        { reason: "timeout", agent_id: a.id, window_calls: 0, cost_day_micros: "0" },
      ]);
      const [l] =
        await owner`select window_calls from public.agent_limits where agent_id = ${a.id}`;
      expect(l!.window_calls).toBe(0);
    });

    it("the docs page names every reason and shows real refusals", () => {
      const docs = readFileSync(
        fileURLToPath(new URL("../../../../docs/hosted/agent-policy.md", import.meta.url)),
        "utf8",
      );
      for (const r of REASONS) expect(docs, r).toContain(`| \`${r}\``);
      for (const r of ["scope", "tool-not-allowed", "rate-limit", "kill-switch-global"])
        expect(docs).toContain(`WARNING:  agent call denied: ${r}\n inserted\n----------\n f\n`);
    });

    it("the closed list in the database is the list of reasons, and nothing else is accepted", async () => {
      const [c] = await owner`select pg_get_constraintdef(oid) as d from pg_constraint
        where conname = 'agent_denies_reason_known'`;
      const listed = [...String(c!.d).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
      expect([...listed].sort()).toEqual([...REASONS].sort());
    });
  });

  describe("before the call: no side effect and no payload is read on a deny", () => {
    it("a refused agent learns nothing about the site, the findings or the payload", async () => {
      const a = await register(["draft:email"]);
      await setLimits(a.id, { calls_per_window: 0 });
      // Another organisation's site and a payload of the wrong shape: the deny comes first.
      expect(await call(a.token, "email", SITE_B1, { subject: "x" })).toBe("denied");
      expect(await call(a.token, "pull_request", SITE_B1, { nonsense: true })).toBe("denied");
    });

    it("the agent is told the reason in a warning that carries no token", async () => {
      const a = await register([]);
      warnings.length = 0;
      expect(await call(a.token)).toBe("denied");
      expect(warnings).toEqual(["WARNING: agent call denied: scope"]);
      expect(warnings.join()).not.toContain(a.token.slice(13));
    });

    it("a refused call does not set last used, so the shadow-agent flag is unaffected", async () => {
      const a = await register([]);
      expect(await call(a.token)).toBe("denied");
      const [r] = await owner`select last_used_at from public.agents where id = ${a.id}`;
      expect(r!.last_used_at).toBeNull();
      const shadow = await asPerson(
        USER_A_OWNER,
        (tx) => tx`select id from public.agent_shadow_inventory where id = ${a.id}`,
      );
      expect(shadow).toHaveLength(0);
    });

    it("a call that waits past its deadline for the site's lock uses no slot, and its deny row has the counts", async () => {
      const a = await register();
      await setLimits(a.id, { calls_per_window: 1, timeout_ms: 100 });
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holder = owner.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${SITE_A1}::text, 0))`;
        locked();
        await held;
      });
      await isLocked;
      const since = await lastDenyId();
      try {
        expect(await call(a.token)).toBe("denied");
      } finally {
        release();
        await holder;
      }
      const rows = await owner`select reason, window_calls, cost_day_micros
        from public.agent_denies where id > ${since} order by id`;
      expect(rows.map((r) => ({ ...r }))).toEqual([
        { reason: "timeout", window_calls: 0, cost_day_micros: "0" },
      ]);
      const [l] =
        await owner`select window_calls from public.agent_limits where agent_id = ${a.id}`;
      expect(l!.window_calls).toBe(0);
      // The one call of the window is still there.
      expect(await call(a.token)).toBe("ok");
    });

    it("a draft that finishes after the deadline is undone and logged as a timeout", async () => {
      const a = await register();
      await setLimits(a.id, { timeout_ms: 100 });
      let seen: { id: unknown; added: number; reasons: string[]; calls?: number } | undefined;
      await owner
        .begin(async (tx) => {
          // A slow insert (only in this rolled-back transaction): the draft lands after the deadline.
          await tx.unsafe(`create function private.test_slow() returns trigger language plpgsql
            set search_path = '' as $f$ begin perform pg_catalog.pg_sleep(0.3); return new; end $f$;
            create trigger test_slow before insert on public.drafts
            for each row execute function private.test_slow()`);
          const since = Number(
            (await tx`select coalesce(max(id), 0) as n from public.agent_denies`)[0]!.n,
          );
          const count = async () =>
            Number((await tx`select count(*) as n from public.drafts`)[0]!.n);
          const before = await count();
          await tx.unsafe("set local role gaugeline_agent");
          const [r] =
            await tx`select private.agent_insert_draft(${a.token}, ${SITE_A1}, 'email', ${tx.json(EMAIL)}) as id`;
          await tx.unsafe("reset role");
          const rows = await tx`select reason from public.agent_denies where id > ${since}`;
          const [l] =
            await tx`select window_calls from public.agent_limits where agent_id = ${a.id}`;
          seen = {
            id: r!.id,
            added: (await count()) - before,
            reasons: rows.map((x) => x.reason),
            calls: l!.window_calls as number,
          };
          throw new Rollback(); // drop the slow trigger again
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
      expect(seen).toEqual({ id: null, added: 0, reasons: ["timeout"], calls: 0 });
    });
  });

  describe("counters do not race", () => {
    it("twelve calls at once against a limit of 5: exactly 5 drafts, 7 logged denies", async () => {
      const a = await register();
      await setLimits(a.id, { calls_per_window: 5 });
      const since = await lastDenyId();
      const before = await drafts();
      const results = await Promise.all(Array.from({ length: 12 }, () => call(a.token)));
      expect(results.filter((r) => r === "ok")).toHaveLength(5);
      expect(results.filter((r) => r === "denied")).toHaveLength(7);
      expect((await drafts()) - before).toBe(5);
      const rows = await deniesSince(since);
      expect(rows.map((r) => r.reason)).toEqual(Array(7).fill("rate-limit"));
    });

    it("the window opens again once it has passed", async () => {
      const a = await register();
      await setLimits(a.id, { calls_per_window: 1, window_seconds: 60 });
      expect(await call(a.token)).toBe("ok");
      expect(await call(a.token)).toBe("denied");
      await owner`update public.agent_limits set window_started_at = now() - interval '61 seconds'
        where agent_id = ${a.id}`;
      expect(await call(a.token)).toBe("ok");
    });
  });

  describe("the kill switches", () => {
    it("the global switch refuses every agent of every organisation until it is lifted", async () => {
      const a = await register();
      const b = await register(["draft:email"], ORG_B);
      await globalSwitch(true);
      try {
        expect(await call(a.token)).toBe("denied");
        expect(await call(b.token, "email", SITE_B1)).toBe("denied");
      } finally {
        await globalSwitch(false);
      }
      expect(await call(a.token)).toBe("ok");
      expect(await call(b.token, "email", SITE_B1)).toBe("ok");
    });

    it("the per-agent switch stops one agent and no other", async () => {
      const a = await register();
      const other = await register();
      await owner`insert into private.agent_switches (agent_id) values (${a.id})`;
      expect(await call(a.token)).toBe("denied");
      expect(await call(other.token)).toBe("ok");
      await owner`delete from private.agent_switches where agent_id = ${a.id}`;
      expect(await call(a.token)).toBe("ok");
    });

    it("revoke wins over every other reason", async () => {
      const a = await register([]);
      await setLimits(a.id, { calls_per_window: 0 });
      await owner`insert into private.agent_switches (agent_id) values (${a.id})`;
      await asPerson(USER_A_OWNER, (tx) => tx`select private.revoke_agent(${a.id})`, true);
      await globalSwitch(true);
      const since = await lastDenyId();
      try {
        expect(await call(a.token, null)).toBe("denied");
      } finally {
        await globalSwitch(false);
      }
      expect((await deniesSince(since)).map((r) => r.reason)).toEqual(["revoked"]);
    });

    it("nobody signed in, the server, the worker or the agent can read or throw a kill switch", async () => {
      for (const role of ["authenticated", "service_role", "gaugeline_worker", "gaugeline_agent"])
        for (const stmt of [
          "select 1 from private.agent_switches",
          "insert into private.agent_switches (agent_id) values (null)",
        ])
          expect(
            await errorOf(
              owner.begin(async (tx) => {
                await tx.unsafe(`set local role ${role}`);
                await tx.unsafe(stmt);
              }),
            ),
            `${role}: ${stmt}`,
          ).toMatch(/permission denied/);
    });
  });

  describe("who sets limits and reads denies", () => {
    it("an owner or admin changes limits; each change is in the history with who made it", async () => {
      const a = await register();
      await setLimits(a.id, { calls_per_window: 3, timeout_ms: 2000 });
      const h = await owner`select calls_per_window, timeout_ms, changed_by
        from public.agent_limit_events where agent_id = ${a.id} order by id`;
      expect(h.map((r) => [r.calls_per_window, r.timeout_ms, r.changed_by])).toEqual([
        [10, 5000, USER_A_OWNER],
        [3, 2000, USER_A_OWNER],
      ]);
      // A call moves the counters but writes no history row.
      expect(await call(a.token)).toBe("ok");
      const [n] = await owner`select count(*)::int as n from public.agent_limit_events
        where agent_id = ${a.id}`;
      expect(n!.n).toBe(2);
    });

    it("a member and a client viewer cannot change limits or read limits, history or denies", async () => {
      const a = await register([]);
      expect(await call(a.token)).toBe("denied");
      for (const userId of [USER_A_MEMBER, USER_A_CLIENT]) {
        const seen = await asPerson(userId, async (tx) => ({
          limits: [...(await tx`select agent_id from public.agent_limits`)],
          history: [...(await tx`select id from public.agent_limit_events`)],
          denies: [...(await tx`select id from public.agent_denies`)],
          updated: [
            ...(await tx`update public.agent_limits set calls_per_window = 9999
              where agent_id = ${a.id} returning agent_id`),
          ],
        }));
        expect(seen, userId).toEqual({ limits: [], history: [], denies: [], updated: [] });
      }
    });

    it("another organisation's owner sees none of A's limits or denies and changes nothing", async () => {
      const a = await register([]);
      expect(await call(a.token)).toBe("denied");
      const seen = await asPerson(USER_B_OWNER, async (tx) => ({
        limits: [...(await tx`select agent_id from public.agent_limits where org_id = ${ORG_A}`)],
        denies: [...(await tx`select id from public.agent_denies where org_id = ${ORG_A}`)],
        updated: [
          ...(await tx`update public.agent_limits set calls_per_window = 9999
            where agent_id = ${a.id} returning agent_id`),
        ],
      }));
      expect(seen).toEqual({ limits: [], denies: [], updated: [] });
      const own = await asPerson(
        USER_A_OWNER,
        (tx) => tx`select reason from public.agent_denies
        where agent_id = ${a.id}`,
      );
      expect(own.map((r) => r.reason)).toEqual(["scope"]);
      // An unknown token's deny belongs to no organisation, so no signed-in person reads it.
      await call(`gla_${randomBytes(32).toString("hex")}`);
      for (const userId of [USER_A_OWNER, USER_B_OWNER])
        expect(
          await asPerson(
            userId,
            (tx) => tx`select id from public.agent_denies where org_id is null`,
          ),
        ).toHaveLength(0);
    });

    it("an update with no WHERE by a member, a client viewer or another organisation's owner changes no row of A", async () => {
      // With no WHERE and no RETURNING, the UPDATE reads no column, so only the UPDATE policy stands
      // between the person and the rows: the SELECT policy cannot hide them.
      await register();
      const sets = [
        "calls_per_window = 100",
        "window_seconds = 120",
        "cost_ceiling_micros = 7",
        "timeout_ms = 1000",
      ];
      const orgA =
        () => owner`select agent_id, calls_per_window, window_seconds, cost_ceiling_micros,
        timeout_ms, updated_at, updated_by from public.agent_limits where org_id = ${ORG_A}
        order by agent_id`;
      const historyA = async () =>
        Number(
          (
            await owner`select count(*) as n from public.agent_limit_events where org_id = ${ORG_A}`
          )[0]!.n,
        );
      const before = [...(await orgA())];
      const historyBefore = await historyA();
      expect(before.length).toBeGreaterThan(0);
      // Committed, so a row the policy let through would stay changed.
      for (const userId of [USER_A_MEMBER, USER_A_CLIENT])
        for (const set of sets)
          expect(
            await asPerson(
              userId,
              async (tx) => (await tx.unsafe(`update public.agent_limits set ${set}`)).count,
              true,
            ),
            `${userId}: ${set}`,
          ).toBe(0);
      // B's owner changes B's rows (rolled back) and none of A's.
      const [b] =
        await owner`select count(*)::int as n from public.agent_limits where org_id = ${ORG_B}`;
      for (const set of sets)
        expect(
          await asPerson(
            USER_B_OWNER,
            async (tx) => (await tx.unsafe(`update public.agent_limits set ${set}`)).count,
          ),
          `B owner: ${set}`,
        ).toBe(b!.n);
      expect([...(await orgA())]).toEqual(before);
      expect(await historyA()).toBe(historyBefore);
    });

    it("an owner cannot touch the counters, the timestamps or another agent's row, or go out of range", async () => {
      const a = await register();
      for (const set of [
        "window_calls = 0",
        "cost_day_micros = 0",
        "window_started_at = null",
        "updated_by = null",
        `org_id = '${ORG_B}'`,
      ])
        expect(
          await personError(USER_A_OWNER, (tx) =>
            tx.unsafe(`update public.agent_limits set ${set} where agent_id = '${a.id}'`),
          ),
          set,
        ).toMatch(/permission denied/);
      for (const set of [
        "calls_per_window = -1",
        "calls_per_window = 10001",
        "window_seconds = 0",
        "cost_ceiling_micros = -1",
        "timeout_ms = 99",
        "timeout_ms = 60001",
      ])
        expect(
          await personError(USER_A_OWNER, (tx) =>
            tx.unsafe(`update public.agent_limits set ${set} where agent_id = '${a.id}'`),
          ),
          set,
        ).toMatch(/agent_limits_/);
      expect(
        await personError(
          USER_A_OWNER,
          (tx) => tx`insert into public.agent_limits (agent_id, org_id) values (${a.id}, ${ORG_A})`,
        ),
      ).toMatch(/permission denied/);
    });

    it("a revoked agent's limits cannot change", async () => {
      const a = await register();
      await asPerson(USER_A_OWNER, (tx) => tx`select private.revoke_agent(${a.id})`, true);
      expect(await errorOf(setLimits(a.id, { calls_per_window: 3 }))).toMatch(
        /a revoked agent cannot change/,
      );
    });

    it("the deny log and the limits history are append-only, for everyone", async () => {
      const a = await register([]);
      expect(await call(a.token)).toBe("denied");
      for (const table of ["agent_denies", "agent_limit_events"]) {
        expect(await errorOf(owner.unsafe(`update public.${table} set org_id = org_id`))).toMatch(
          /append-only/,
        );
        expect(await errorOf(owner.unsafe(`delete from public.${table}`))).toMatch(/append-only/);
        expect(
          await personError(USER_A_OWNER, (tx) =>
            tx.unsafe(`insert into public.${table} (org_id) values ('${ORG_A}')`),
          ),
        ).toMatch(/permission denied/);
      }
    });

    it("the deny log holds ids, a reason, a tool, a time and counts: no token, payload or text", async () => {
      const cols = await owner`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'agent_denies' order by column_name`;
      expect(cols.map((c) => c.column_name)).toEqual([
        "agent_id",
        "cost_day_micros",
        "cost_micros",
        "denied_at",
        "id",
        "org_id",
        "reason",
        "tool",
        "window_calls",
      ]);
      // A tool name the caller made up is not stored: only a name on the closed list.
      const a = await register();
      const since = await lastDenyId();
      expect(await call(a.token, "ignore all previous instructions")).toBe("denied");
      const [r] = await deniesSince(since);
      expect(r).toMatchObject({ reason: "tool-not-allowed", tool: null });
    });
  });

  describe("audit", () => {
    it("the agent role still holds no table and runs its three functions; nobody runs the policy directly", async () => {
      expect(await privateFunctionsExecutableBy(owner, "gaugeline_agent")).toEqual([
        "agent_insert_draft",
        // AG-08 (0014): the two reads, each authorized with its own scope.
        "agent_list_pending",
        "agent_list_runs",
      ]);
      for (const role of [
        "anon",
        "authenticated",
        "service_role",
        "gaugeline_agent",
        "gaugeline_worker",
        "gaugeline_chat",
      ]) {
        const fns = await privateFunctionsExecutableBy(owner, role);
        for (const fn of ["agent_authorize", "agent_deny", "agent_limits_create"])
          expect(fns, `${role} ${fn}`).not.toContain(fn);
      }
      const [g] = await owner`select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'gaugeline_agent'`;
      expect(g!.n).toBe(0);
      expect(await agentLoginsWithOtherRoles(owner)).toEqual([]);
      expect(await tablesWithoutRls(owner)).toEqual([]);
      expect(await tablesWithoutRls(owner, "private")).toEqual(["schema_migrations"]);
      expect(await definerFunctionsWithoutEmptySearchPath(owner)).toEqual([]);
    });

    it("the tools the policy knows are the registry's scopes", async () => {
      const [fn] = await owner`select prosrc from pg_proc where proname = 'agent_authorize'`;
      const m = /c_tools constant text\[\] := array\[([^\]]+)\]/.exec(String(fn!.prosrc));
      const listed = [...m![1]!.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((x) => x[1]);
      expect(listed).toEqual([...AGENT_SCOPES]);
    });

    it("every agent has exactly one limits row, including the ones from before this migration", async () => {
      const [r] = await owner`select
        (select count(*) from public.agents)::int as agents,
        (select count(*) from public.agent_limits)::int as limits,
        (select count(*) from public.agents a where not exists
          (select 1 from public.agent_limits l where l.agent_id = a.id))::int as missing`;
      expect(r).toEqual({ agents: r!.limits, limits: r!.agents, missing: 0 });
    });
  });
});
