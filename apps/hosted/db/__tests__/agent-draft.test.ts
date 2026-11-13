/**
 * The hosted agent's draft path in TypeScript (AG-03 part 2c): the global environment kill switch before any
 * database call, then private.agent_insert_draft (which runs private.agent_authorize first), with the SQL's
 * refusal mapped to the same closed reason and logged through the sink. The database parts run against a real
 * Postgres through a real agent login (skipped without GAUGELINE_TEST_DATABASE_URL, like the db tests).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_DENY_REASONS, AGENTS_OFF_ENV, type AgentDenyLog } from "@gaugeline/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_DATABASE,
  ORG_A,
  SITE_A1,
  TEST_DATABASE_URL,
  USER_A_OWNER,
  freshDatabase,
  seed,
  type Sql,
  type TestDatabase,
} from "./harness.js";
import { createAgentDrafts, denyReasonOf } from "../../agents/draft.js";

const EMAIL = { subject: "Your menu link is fixed", body: "The drinks page is back." };
const NOW = new Date(Date.UTC(2026, 10, 13, 9, 0, 0));

describe("the SQL and the TypeScript agree", () => {
  it("the deny log's closed list in 0013 is the core list", () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../migrations/0013_agent_policy.sql", import.meta.url)),
      "utf8",
    );
    const m = /agent_denies_reason_known check \(reason in \(([^)]*)\)\)/.exec(sql);
    const listed = [...(m?.[1] ?? "").matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
    expect(listed.sort()).toEqual([...AGENT_DENY_REASONS].sort());
  });

  it("reads a refusal only from the policy's own warning, and only a reason on the list", () => {
    const w = (message: string, severity = "WARNING") => ({ severity, message });
    expect(denyReasonOf([w("agent call denied: rate-limit")])).toBe("rate-limit");
    expect(denyReasonOf([w("agent call denied: rate-limit", "NOTICE")])).toBeNull();
    expect(denyReasonOf([w("agent call denied: allowed")])).toBeNull();
    expect(denyReasonOf([w("agent call denied: scope; drop table x")])).toBeNull();
    expect(denyReasonOf([w("something else")])).toBeNull();
    expect(denyReasonOf([])).toBeNull();
  });
});

describe("the global kill switch, before the database", () => {
  it("failing fixture: GAUGELINE_AGENTS_OFF=1 refuses with no database call and logs the deny", async () => {
    let connects = 0;
    const log: AgentDenyLog[] = [];
    const drafts = createAgentDrafts({
      connect: () => {
        connects++;
        throw new Error("must not connect");
      },
      env: { [AGENTS_OFF_ENV]: "1" },
      now: () => NOW,
      onDeny: (e) => log.push(e),
    });
    const r = await drafts.draft({
      token: "gla_x",
      siteId: SITE_A1,
      kind: "email",
      payload: EMAIL,
    });
    expect(r).toEqual({ inserted: false, reason: "kill-switch-global" });
    expect(connects).toBe(0);
    expect(log).toEqual([
      { at: NOW.toISOString(), agentId: null, tool: "draft:email", reason: "kill-switch-global" },
    ]);
    // docs/hosted/agent-policy.md prints this entry.
    const page = readFileSync(
      fileURLToPath(new URL("../../../../docs/hosted/agent-policy.md", import.meta.url)),
      "utf8",
    );
    const block = /```json title=Log entry[^\n]*\n([\s\S]*?)```/.exec(page)?.[1] ?? "null";
    expect(JSON.parse(block)).toEqual(log[0]);
    // A made-up kind is not logged as a tool name.
    await drafts.draft({ token: "gla_x", siteId: SITE_A1, kind: "publish_now", payload: {} });
    expect(log[1]?.tool).toBeNull();
    await drafts.end();
  });
});

describe("a null with no policy warning", () => {
  it("is an error, never a guessed reason (fail closed: nothing was inserted)", async () => {
    const log: AgentDenyLog[] = [];
    const fake = { begin: async () => null, end: async () => undefined };
    const drafts = createAgentDrafts({
      connect: () => fake as never,
      env: {},
      onDeny: (e) => log.push(e),
    });
    await expect(
      drafts.draft({ token: "gla_x", siteId: SITE_A1, kind: "email", payload: EMAIL }),
    ).rejects.toThrow(/without a policy reason/);
    expect(log).toEqual([]);
    await drafts.end();
  });
});

describe.skipIf(!HAS_DATABASE)("the agent's draft path against Postgres", () => {
  const tag = randomBytes(4).toString("hex");
  const PERSON = `gl_ad_person_${tag}`;
  const AGENT = `gl_ad_agent_${tag}`;
  const PASSWORD = "agent-draft-test-login";
  let db: TestDatabase;
  let owner: Sql;
  let person: Sql;
  const env: Record<string, string | undefined> = {};
  const log: AgentDenyLog[] = [];
  let drafts: ReturnType<typeof createAgentDrafts>;

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
    person = postgres(loginUrl(PERSON), { max: 2, onnotice: () => {} });
    drafts = createAgentDrafts({
      connect: (onnotice) => postgres(loginUrl(AGENT), { max: 1, onnotice }),
      env,
      now: () => NOW,
      onDeny: (e) => log.push(e),
    });
  });
  afterAll(async () => {
    await drafts?.end();
    await person?.end();
    await db?.drop();
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop role if exists ${PERSON}; drop role if exists ${AGENT}`);
    await admin.end();
  });

  /** A committed agent of ORG_A, registered by its owner through the one door. */
  async function register(scopes: string[]): Promise<{ id: string; token: string }> {
    let out: { id: string; token: string } | undefined;
    await person.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A_OWNER })}, true)`;
      await tx.unsafe("set local role authenticated");
      const [r] =
        await tx`select * from private.register_agent(${ORG_A}, ${`Draft agent ${randomBytes(4).toString("hex")}`}, ${USER_A_OWNER}, ${scopes})`;
      out = { id: r!.agent_id as string, token: r!.token as string };
    });
    return out!;
  }
  const count = async () => Number((await owner`select count(*) as n from public.drafts`)[0]!.n);
  const denyRows = async () =>
    Number((await owner`select count(*) as n from public.agent_denies`)[0]!.n);
  const draft = (token: string, kind = "email") =>
    drafts.draft({ token, siteId: SITE_A1, kind, payload: EMAIL });

  it("passing fixture: a scoped agent's draft is inserted and nothing is logged", async () => {
    const a = await register(["draft:email"]);
    const before = log.length;
    const r = await draft(a.token);
    expect(r.inserted).toBe(true);
    expect(r.inserted && r.draftId).toMatch(/^[0-9a-f-]{36}$/);
    expect(log.length).toBe(before);
  });

  it("one authorization per call: each draft counts once in the rate window, a refusal counts none", async () => {
    const a = await register(["draft:email"]);
    const counted = async () =>
      Number(
        (await owner`select window_calls from public.agent_limits where agent_id = ${a.id}`)[0]!
          .window_calls,
      );
    expect(await counted()).toBe(0);
    for (let i = 1; i <= 3; i++) {
      expect((await draft(a.token)).inserted).toBe(true);
      expect(await counted()).toBe(i);
    }
    expect(await draft(a.token, "pull_request")).toEqual({ inserted: false, reason: "scope" });
    expect(await counted()).toBe(3);
    // The TypeScript never names the authorize function: the draft function calls it, once.
    const source = readFileSync(
      fileURLToPath(new URL("../../agents/draft.ts", import.meta.url)),
      "utf8",
    );
    expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/agent_authorize/);
  });

  it("failing fixture: an agent with no scope is refused (scope), logged once, nothing inserted", async () => {
    const a = await register([]);
    const [before, rows] = [await count(), await denyRows()];
    log.length = 0;
    expect(await draft(a.token)).toEqual({ inserted: false, reason: "scope" });
    expect(await count()).toBe(before);
    expect(await denyRows()).toBe(rows + 1);
    expect(log).toEqual([
      { at: NOW.toISOString(), agentId: null, tool: "draft:email", reason: "scope" },
    ]);
    expect(JSON.stringify(log)).not.toContain(a.token);
  });

  it("maps the SQL's reasons: unknown-agent, tool-not-allowed, revoked, disabled, rate-limit, both switches", async () => {
    const a = await register(["draft:email"]);
    expect(await draft(`gla_${"0".repeat(8)}_${"A".repeat(43)}`)).toEqual({
      inserted: false,
      reason: "unknown-agent",
    });
    expect(await draft(a.token, "publish_now")).toEqual({
      inserted: false,
      reason: "tool-not-allowed",
    });
    await owner`insert into private.agent_switches (agent_id) values (null)`;
    expect(await draft(a.token)).toEqual({ inserted: false, reason: "kill-switch-global" });
    await owner`delete from private.agent_switches where agent_id is null`;
    await owner`insert into private.agent_switches (agent_id) values (${a.id})`;
    expect(await draft(a.token)).toEqual({ inserted: false, reason: "kill-switch-agent" });
    await owner`delete from private.agent_switches where agent_id = ${a.id}`;
    await owner`update public.agent_limits set calls_per_window = 0 where agent_id = ${a.id}`;
    expect(await draft(a.token)).toEqual({ inserted: false, reason: "rate-limit" });
    await owner`update public.agents set status = 'disabled' where id = ${a.id}`;
    expect(await draft(a.token)).toEqual({ inserted: false, reason: "disabled" });
    await owner`update public.agents set status = 'revoked' where id = ${a.id}`;
    expect(await draft(a.token)).toEqual({ inserted: false, reason: "revoked" });
  });

  it("the environment switch refuses before the database: no draft, no deny row, read at every call", async () => {
    const a = await register(["draft:email"]);
    const [before, rows] = [await count(), await denyRows()];
    env[AGENTS_OFF_ENV] = "yes";
    expect(await draft(a.token)).toEqual({ inserted: false, reason: "kill-switch-global" });
    expect([await count(), await denyRows()]).toEqual([before, rows]);
    delete env[AGENTS_OFF_ENV];
    expect((await draft(a.token)).inserted).toBe(true);
  });

  it("calls started together are each mapped to their own result (5 calls, a limit of 2)", async () => {
    const a = await register(["draft:email"]);
    await owner`update public.agent_limits set calls_per_window = 2 where agent_id = ${a.id}`;
    const out = await Promise.all(Array.from({ length: 5 }, () => draft(a.token)));
    expect(out.filter((r) => r.inserted)).toHaveLength(2);
    expect(out.filter((r) => !r.inserted && r.reason === "rate-limit")).toHaveLength(3);
  });

  it("calls of different outcomes started together each get their own reason", async () => {
    const a = await register(["draft:email"]);
    const out = await Promise.all(
      ["publish_now", "email", "pull_request", "email"].map((k) => draft(a.token, k)),
    );
    expect(out.map((r) => (r.inserted ? "ok" : r.reason))).toEqual([
      "tool-not-allowed",
      "ok",
      "scope",
      "ok",
    ]);
  });

  it("a login that hides warnings still has its refusal read (the path shows warnings for its own call)", async () => {
    const quiet = createAgentDrafts({
      connect: (onnotice) =>
        postgres(loginUrl(AGENT), {
          max: 1,
          onnotice,
          connection: { client_min_messages: "error" },
        }),
      env: {},
      onDeny: () => {},
    });
    try {
      const a = await register([]);
      expect(
        await quiet.draft({ token: a.token, siteId: SITE_A1, kind: "email", payload: EMAIL }),
      ).toEqual({
        inserted: false,
        reason: "scope",
      });
    } finally {
      await quiet.end();
    }
  });

  it("an error that is not a policy refusal stays an error (another organisation's site)", async () => {
    const a = await register(["draft:email"]);
    await expect(
      drafts.draft({
        token: a.token,
        siteId: "b1000000-0000-4000-8000-0000000000b1",
        kind: "email",
        payload: EMAIL,
      }),
    ).rejects.toThrow(/site not found for this agent/);
  });
});
