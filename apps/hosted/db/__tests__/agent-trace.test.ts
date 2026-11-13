/**
 * The agent trace (AG-05, 0015) against a real Postgres, through REAL login roles: a person's login (a member
 * of `authenticated` only) and an agent's login (a member of `gaugeline_agent` only). The migration owner sets
 * things up and calls the private writer directly (no login may). Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentLoginsWithOtherRoles,
  definerFunctionsWithoutEmptySearchPath,
  privateFunctionsExecutableBy,
  tablesWithoutRls,
} from "../audit.js";
import { withAgent } from "../../lib/api/db.js";
import {
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  SITE_A1,
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
const PERSON = `gl_trace_person_${tag}`;
const AGENT = `gl_trace_agent_${tag}`;
const PASSWORD = "trace-test-login";
const EMAIL = { subject: "Your menu link is fixed", body: "The drinks page is back." };
// Invented secrets, built at run time so no scanner mistakes the file for a leak.
const FAKE_KEY = ["sk", "live", "TRACEFAKE0000000000000000"].join("_");
const FAKE_MAIL = ["guest.list", "tidewater-bar.test"].join("@");
const HEX64 = /^[0-9a-f]{64}$/;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

class Rollback extends Error {}

describe.skipIf(!HAS_DATABASE)("agent trace", () => {
  let db: TestDatabase;
  let owner: Sql;
  let person: Sql;
  let agent: Sql;
  const notices: string[] = [];

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
    person = postgres(loginUrl(PERSON), {
      max: 4,
      onnotice: (n) => notices.push(String(n.message)),
    });
    agent = postgres(loginUrl(AGENT), { max: 8, onnotice: (n) => notices.push(String(n.message)) });
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

  async function register(
    scopes: string[] = ["draft:email"],
  ): Promise<{ id: string; token: string }> {
    const [r] = await asPerson(
      USER_A_OWNER,
      (tx) =>
        tx`select * from private.register_agent(${ORG_A}, ${`Trace agent ${randomBytes(4).toString("hex")}`}, ${USER_A_OWNER}, ${scopes})`,
      true,
    );
    return { id: r!.agent_id as string, token: r!.token as string };
  }

  /** The agent's login drafts and commits: the draft id, null when refused, or the error message. */
  async function call(token: string, payload: object = EMAIL): Promise<string | null> {
    let id: string | null = null;
    const e = await errorOf(
      agent.begin(async (tx) => {
        await tx.unsafe("set local role gaugeline_agent");
        const [r] =
          await tx`select private.agent_insert_draft(${token}, ${SITE_A1}, 'email', ${tx.json(payload as never)}) as id`;
        id = (r!.id as string | null) ?? null;
      }),
    );
    return e !== "" ? `error: ${e}` : id;
  }
  const traceOf = (agentId: string) =>
    owner`select org_id, agent_id, tool, input_sha256, output_sha256, latency_ms, tokens, cost_micros,
      decision, reason, approver_id, draft_id from public.agent_trace where agent_id = ${agentId} order by id`;
  const unknownCalls = async () =>
    Number(
      (
        await owner`select coalesce(sum(calls), 0)::bigint as n from public.agent_trace_overflow
        where agent_id is null`
      )[0]!.n,
    );
  const everything = async () =>
    JSON.stringify([
      ...(await owner`select * from public.agent_trace`),
      ...(await owner`select * from public.agent_trace_overflow`),
    ]);

  describe("one row per call (passing and failing fixtures)", () => {
    it("an allowed call leaves exactly one row: ids, hashes, whole-ms latency, zero tokens and cost", async () => {
      const a = await register();
      const id = await call(a.token);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const rows = await traceOf(a.id);
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      // The input hash is SHA-256 over Postgres's jsonb text of the arguments but the token (keys shortest
      // first), worked out here independently of the SQL.
      const canonical = `{"kind": "email", "payload": {"body": "${EMAIL.body}", "subject": "${EMAIL.subject}"}, "site_id": "${SITE_A1}", "finding_ids": []}`;
      expect({ ...r, latency_ms: undefined }).toEqual({
        org_id: ORG_A,
        agent_id: a.id,
        tool: "draft:email",
        input_sha256: sha(canonical),
        output_sha256: sha(id!),
        latency_ms: undefined,
        tokens: "0",
        cost_micros: "0",
        decision: "allowed",
        reason: null,
        approver_id: null,
        draft_id: id,
      });
      expect(Number.isSafeInteger(Number(r.latency_ms)) && Number(r.latency_ms) >= 0).toBe(true);
    });

    it("a denied call leaves exactly one row with the reason, and still inserts no draft", async () => {
      const a = await register([]);
      const [before] = await owner`select count(*)::int as n from public.drafts`;
      expect(await call(a.token)).toBeNull();
      const [after] = await owner`select count(*)::int as n from public.drafts`;
      expect(after!.n).toBe(before!.n);
      const rows = await traceOf(a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        decision: "denied",
        reason: "scope",
        tool: "draft:email",
        output_sha256: null,
        draft_id: null,
        approver_id: null,
      });
      expect(rows[0]!.input_sha256).toMatch(HEX64);
    });

    it("the same input gives the same hash; NFC and NFD spellings of one text hash the same", async () => {
      const a = await register();
      const nfc = { subject: "Café menu", body: "Fixed." };
      const nfd = { subject: "Café menu", body: "Fixed." };
      await call(a.token, nfc);
      await call(a.token, nfd);
      await call(a.token, { ...nfc, body: "Fixed!" });
      const h = (await traceOf(a.id)).map((r) => r.input_sha256);
      expect(h[0]).toBe(h[1]);
      expect(h[2]).not.toBe(h[0]);
    });

    it("two concurrent calls leave two rows; an allowed and a denied one at once leave one of each", async () => {
      const a = await register();
      const b = await register([]);
      const ids = await Promise.all([call(a.token), call(a.token), call(b.token)]);
      expect(ids.filter((x) => x !== null && !x.startsWith("error"))).toHaveLength(2);
      expect((await traceOf(a.id)).map((r) => r.decision)).toEqual(["allowed", "allowed"]);
      expect((await traceOf(b.id)).map((r) => r.decision)).toEqual(["denied"]);
    });
  });

  describe("the agent reads (AG-08)", () => {
    /** The agent's login runs one read and commits; returns the jsonb answer as Postgres's own text. */
    async function read(token: string, sql: string, args: unknown[]): Promise<string> {
      let text = "";
      await agent.begin(async (tx) => {
        await tx.unsafe("set local role gaugeline_agent");
        const [r] = await tx.unsafe(`select ${sql}::text as t`, args as never[]);
        text = String(r!.t);
      });
      return text;
    }

    it("an allowed read of pending drafts and of runs each leave one row with the answer's hash", async () => {
      const a = await register(["read:pending", "read:runs"]);
      const p = await read(a.token, "private.agent_list_pending($1)", [a.token]);
      const r = await read(a.token, "private.agent_list_runs($1, $2)", [a.token, SITE_A1]);
      const rows = await traceOf(a.id);
      expect(rows.map((x) => [x.tool, x.decision, x.reason, x.draft_id])).toEqual([
        ["read:pending", "allowed", null, null],
        ["read:runs", "allowed", null, null],
      ]);
      expect(rows[0]!.output_sha256).toBe(sha(p));
      expect(rows[1]!.output_sha256).toBe(sha(r));
      expect(rows[0]!.input_sha256).toMatch(HEX64);
    });

    it("accepted risk: a read rolled back by the agent's login leaves no trace and no counted call; the app's committed path leaves one", async () => {
      const a = await register(["read:pending"]);
      const calls = async () =>
        Number(
          (await owner`select window_calls from public.agent_limits where agent_id = ${a.id}`)[0]!
            .window_calls,
        );
      // The login rolls its own transaction back: the trace row and the policy's count go with it.
      const e = await errorOf(
        agent.begin(async (tx) => {
          await tx.unsafe("set local role gaugeline_agent");
          await tx`select private.agent_list_pending(${a.token})`;
          throw new Rollback();
        }),
      );
      expect(e).toBe("");
      expect(await traceOf(a.id)).toHaveLength(0);
      expect(await calls()).toBe(0);
      // The app's own path (lib/api/db.ts withAgent) commits: exactly one row.
      await withAgent(agent as never, (tx) => tx`select private.agent_list_pending(${a.token})`);
      expect((await traceOf(a.id)).map((x) => [x.tool, x.decision])).toEqual([
        ["read:pending", "allowed"],
      ]);
      expect(await calls()).toBe(1);
    });

    it("a refused read leaves one denied row with the reason and no output hash", async () => {
      const a = await register(["draft:email"]);
      expect(JSON.parse(await read(a.token, "private.agent_list_pending($1)", [a.token]))).toEqual({
        allowed: false,
        reason: "scope",
      });
      expect(
        (await traceOf(a.id)).map((x) => [x.tool, x.decision, x.reason, x.output_sha256]),
      ).toEqual([["read:pending", "denied", "scope", null]]);
    });
  });

  describe("bounded", () => {
    it("a flood of unknown tokens adds no trace row and at most one counter row a minute", async () => {
      const [rows0] = await owner`select count(*)::int as n from public.agent_trace`;
      const [over0] = await owner`select count(*)::int as n from public.agent_trace_overflow`;
      const calls0 = await unknownCalls();
      const fake = `gla_00000000_${"A".repeat(43)}`;
      for (let i = 0; i < 40; i++) expect(await call(fake)).toBeNull();
      const [rows1] = await owner`select count(*)::int as n from public.agent_trace`;
      const [over1] = await owner`select count(*)::int as n from public.agent_trace_overflow`;
      expect(rows1!.n).toBe(rows0!.n);
      // At most two minutes were touched while the loop ran.
      expect(over1!.n - over0!.n).toBeLessThanOrEqual(2);
      expect((await unknownCalls()) - calls0).toBe(40);
    });

    it("an agent's denies past 60 in one minute are counted per reason, not traced one by one", async () => {
      const a = await register([]);
      await owner.begin(async (tx) => {
        // One transaction, so one minute (now() is the transaction's start).
        for (let i = 0; i < 65; i++)
          await tx`select private.agent_trace_record(${ORG_A}, ${a.id}, 'draft:email', null, null, 0, 0, 0, 'denied', 'scope', null, null)`;
      });
      expect(await traceOf(a.id)).toHaveLength(60);
      const over =
        await owner`select reason, calls::int from public.agent_trace_overflow where agent_id = ${a.id}`;
      expect([...over]).toEqual([{ reason: "scope", calls: 5 }]);
    });
  });

  describe("approvals and declines (inbox and chat)", () => {
    it("an owner's approval in the inbox is traced with the approver and the approved payload's hash", async () => {
      const a = await register();
      const id = (await call(a.token))!;
      await asPerson(
        USER_A_OWNER,
        (tx) =>
          tx`insert into public.decisions (org_id, draft_id, decision, decided_by) values (${ORG_A}, ${id}, 'approved', ${USER_A_OWNER})`,
        true,
      );
      const rows = await traceOf(a.id);
      expect(rows.map((r) => r.decision)).toEqual(["allowed", "approved"]);
      const [d] = await owner`select payload_sha256 from public.decisions where draft_id = ${id}`;
      expect(rows[1]).toMatchObject({
        approver_id: USER_A_OWNER,
        draft_id: id,
        tool: "draft:email",
        input_sha256: d!.payload_sha256,
        reason: null,
      });
    });

    it("a decline through chat is traced with the member who pressed it", async () => {
      const a = await register();
      const id = (await call(a.token))!;
      const conn = "c0000000-0000-4000-8000-0000000000c1";
      await owner.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        await tx`select private.put_secret(${ORG_A}, 'trace-chat', 'signing_secret', ${`invented-${tag}`})`;
      });
      await owner`insert into public.chat_connections (id, org_id, provider, label, secret_name)
        values (${conn}, ${ORG_A}, 'slack', 'Trace Slack', 'trace-chat')`;
      await owner`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id, confirmed_at)
        values (${ORG_A}, ${conn}, 'U0TRACE', ${USER_A_MEMBER}, now())`;
      const [r] =
        await owner`select r_status from private.chat_decide(${conn}, 'U0TRACE', ${id}, 'decline')`;
      expect(r!.r_status).toBe("recorded");
      expect((await traceOf(a.id)).at(-1)).toMatchObject({
        decision: "declined",
        approver_id: USER_A_MEMBER,
        input_sha256: null,
      });
    });

    it("a decision on a person's own draft (no agent) writes no trace row", async () => {
      const [before] = await owner`select count(*)::int as n from public.agent_trace`;
      const [d] = await owner`insert into public.drafts (org_id, site_id, kind, payload, created_by)
        values (${ORG_A}, ${SITE_A1}, 'email', ${owner.json(EMAIL)}, ${USER_A_OWNER}) returning id`;
      await asPerson(
        USER_A_OWNER,
        (tx) =>
          tx`insert into public.decisions (org_id, draft_id, decision, decided_by) values (${ORG_A}, ${d!.id}, 'declined', ${USER_A_OWNER})`,
        true,
      );
      const [after] = await owner`select count(*)::int as n from public.agent_trace`;
      expect(after!.n).toBe(before!.n);
    });
  });

  describe("tenancy", () => {
    it("owners and admins of the organisation read its trace; members, client viewers and others read nothing", async () => {
      const a = await register();
      await call(a.token);
      const read = (userId: string) =>
        asPerson(userId, async (tx) => ({
          trace: (await tx`select agent_id from public.agent_trace where agent_id = ${a.id}`)
            .length,
          unknown: (await tx`select 1 from public.agent_trace_overflow where agent_id is null`)
            .length,
        }));
      expect(await read(USER_A_OWNER)).toEqual({ trace: 1, unknown: 0 });
      expect(await read(USER_A_MEMBER)).toEqual({ trace: 0, unknown: 0 });
      expect(await read(USER_A_CLIENT)).toEqual({ trace: 0, unknown: 0 });
      expect(await read(USER_B_OWNER)).toEqual({ trace: 0, unknown: 0 });
      const anon = await errorOf(
        owner.begin(async (tx) => {
          await tx.unsafe("set local role anon");
          await tx`select 1 from public.agent_trace`;
        }),
      );
      expect(anon).toMatch(/permission denied/);
    });

    it("the writer scopes the agent, approver and draft to the organisation", async () => {
      const a = await register();
      const id = (await call(a.token))!;
      const rec = (
        org: string,
        approver: string | null,
        draft: string | null,
        decision = "approved",
      ) =>
        errorOf(
          owner`select private.agent_trace_record(${org}, ${a.id}, 'draft:email', null, null, 0, 0, 0, ${decision}, null, ${approver}, ${draft})`,
        );
      expect(await rec(ORG_B, USER_B_OWNER, null)).toMatch(/agent not found in this organisation/);
      expect(await rec(ORG_A, USER_B_OWNER, id)).toMatch(/approver is not staff/);
      expect(await rec(ORG_A, USER_A_CLIENT, id)).toMatch(/approver is not staff/);
      expect(await rec(ORG_A, USER_A_OWNER, "b1d10000-0000-4000-8000-0000000000b1")).toMatch(
        /draft not found in this organisation/,
      );
    });
  });

  describe("append-only and closed", () => {
    it("nobody changes or removes a trace row, the owner included; nobody signed in inserts one", async () => {
      const a = await register();
      await call(a.token);
      expect(await errorOf(owner`update public.agent_trace set tokens = 1`)).toMatch(/append-only/);
      expect(await errorOf(owner`delete from public.agent_trace`)).toMatch(/append-only/);
      expect(await errorOf(owner`truncate public.agent_trace`)).toMatch(/append-only/);
      for (const t of ["agent_trace", "agent_trace_overflow"])
        expect(
          await errorOf(
            asPerson(USER_A_OWNER, (tx) =>
              tx.unsafe(`insert into public.${t} (org_id) values ('${ORG_A}')`),
            ),
          ),
        ).toMatch(/permission denied/);
      expect(
        await errorOf(
          asPerson(USER_A_OWNER, (tx) => tx`update public.agent_trace_overflow set calls = 1`),
        ),
      ).toMatch(/permission denied/);
    });

    it("refuses a negative or out-of-range cost, tokens or latency, an unknown decision, and a reason without a deny", async () => {
      const a = await register();
      const rec = (
        latency: number,
        tokens: number,
        cost: number,
        decision: string,
        reason: string | null,
      ) =>
        errorOf(
          owner`select private.agent_trace_record(${ORG_A}, ${a.id}, 'draft:email', null, null, ${latency}, ${tokens}, ${cost}, ${decision}, ${reason}, null, null)`,
        );
      expect(await rec(0, 0, -1, "denied", "scope")).toMatch(/whole numbers in range/);
      expect(await rec(0, -1, 0, "denied", "scope")).toMatch(/whole numbers in range/);
      expect(await rec(-1, 0, 0, "denied", "scope")).toMatch(/whole numbers in range/);
      expect(await rec(0, 0, 1e12 + 1, "denied", "scope")).toMatch(/whole numbers in range/);
      expect(await rec(0, 0, 0, "maybe", null)).toMatch(/unknown decision/);
      expect(await rec(0, 0, 0, "denied", null)).toMatch(/reason goes with a deny/);
      expect(await rec(0, 0, 0, "allowed", "scope")).toMatch(/reason goes with a deny/);
      expect(await rec(0, 0, 0, "denied", "made-up")).toMatch(/agent_trace_reason_known/);
      expect(await rec(0, 0, 0, "approved", null)).toMatch(/agent_trace_approver_iff_decided/);
      const badHash = await errorOf(
        owner`select private.agent_trace_record(${ORG_A}, ${a.id}, 'draft:email', ${FAKE_KEY}, null, 0, 0, 0, 'denied', 'scope', null, null)`,
      );
      expect(badHash).toMatch(/breaks the rule agent_trace_input_sha256_check/);
      expect(badHash).not.toContain(FAKE_KEY);
    });

    it("a payload with a key-shaped string and an email leaves neither in any row, notice or error", async () => {
      const a = await register(["draft:email"]);
      const payload = { subject: `Key ${FAKE_KEY}`, body: `Write to ${FAKE_MAIL}` };
      notices.length = 0;
      await call(a.token, payload);
      const b = await register([]);
      await call(b.token, payload);
      await call(`gla_00000000_${FAKE_KEY.padEnd(43, "x").slice(0, 43)}`, payload);
      const stored = await everything();
      for (const s of [FAKE_KEY, FAKE_MAIL, "guest.list", a.token, b.token])
        expect(stored).not.toContain(s);
      expect(notices.join("\n")).not.toContain(FAKE_KEY);
      expect(notices.join("\n")).not.toContain(a.token);
      const cols = await owner`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'agent_trace' order by column_name`;
      expect(cols.map((c) => c.column_name)).toEqual([
        "agent_id",
        "approver_id",
        "at",
        "cost_micros",
        "decision",
        "draft_id",
        "id",
        "input_sha256",
        "latency_ms",
        "org_id",
        "output_sha256",
        "reason",
        "tokens",
        "tool",
      ]);
    });
  });

  describe("audit", () => {
    it("the agent role still holds no table and runs its three functions; nobody runs the writer directly", async () => {
      expect(await privateFunctionsExecutableBy(owner, "gaugeline_agent")).toEqual([
        "agent_insert_draft",
        // AG-08 (0014): the two reads, each traced here too.
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
        for (const fn of [
          "agent_trace_record",
          "agent_trace_input",
          "agent_trace_ms",
          "agent_trace_decision",
          "agent_trace_read",
        ])
          expect(fns, `${role} ${fn}`).not.toContain(fn);
      }
      const [g] = await owner`select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'gaugeline_agent'`;
      expect(g!.n).toBe(0);
      const grants =
        await owner`select grantee, privilege_type from information_schema.role_table_grants
        where table_name in ('agent_trace', 'agent_trace_overflow') and grantee <> 'postgres'
        order by 1, 2`;
      expect([...new Set(grants.map((r) => `${r.grantee}:${r.privilege_type}`))]).toEqual([
        "authenticated:SELECT",
      ]);
      expect(await agentLoginsWithOtherRoles(owner)).toEqual([]);
      expect(await tablesWithoutRls(owner)).toEqual([]);
      expect(await tablesWithoutRls(owner, "private")).toEqual(["schema_migrations"]);
      expect(await definerFunctionsWithoutEmptySearchPath(owner)).toEqual([]);
    });

    it("the closed lists match 0013's: the reasons and the tools", async () => {
      const defs = await owner`select conname, pg_get_constraintdef(oid) as d from pg_constraint
        where conname in ('agent_trace_reason_known', 'agent_denies_reason_known', 'agent_denies_tool_check', 'agent_trace_tool_check')
        order by conname`;
      const words = (d: string) => [...d.matchAll(/'([a-z:_-]+)'/g)].map((m) => m[1]).sort();
      const by = Object.fromEntries(defs.map((r) => [r.conname, words(String(r.d))]));
      expect(by.agent_trace_reason_known).toEqual(by.agent_denies_reason_known);
      expect(by.agent_trace_tool_check).toEqual(by.agent_denies_tool_check);
    });
  });
});
