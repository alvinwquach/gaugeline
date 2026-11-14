/**
 * The triage agent on the hosted draft path (AG-12): core plans and traces; this binds each draft to the
 * agent's own entry (private.agent_insert_draft, which authorizes, counts and traces it in the database).
 * The unit parts need no database; the Postgres parts run with GAUGELINE_TEST_DATABASE_URL, like the others.
 */
import { randomBytes } from "node:crypto";
import {
  AGENTS_OFF_ENV,
  TRIAGE_AGENT_ID,
  TRIAGE_REGISTRATION,
  createTriagePolicy,
  runTriage,
  type AgentDenyLog,
  type TriageDraftCall,
  type TriageFinding,
} from "@gaugeline/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentDrafts } from "../../agents/draft.js";
import { triageDraftSink, triagePendingSource } from "../../agents/triage.js";
import {
  HAS_DATABASE,
  ORG_A,
  RUN_A1,
  SITE_A1,
  TEST_DATABASE_URL,
  USER_A_OWNER,
  freshDatabase,
  seed,
  type Sql,
  type TestDatabase,
} from "./harness.js";

const NOW = () => Date.UTC(2026, 10, 13, 12, 0, 0);
const f = (
  id: string,
  checkId: string,
  severity: TriageFinding["severity"] = "medium",
): TriageFinding => ({
  id,
  checkId,
  severity,
  title: `Title ${checkId}`,
  evidence: `Evidence ${checkId}`,
  url: `https://crumb-and-co.example/${checkId}`,
});

describe("the sink", () => {
  it("passes the call to the agent's draft entry with the agent's token and nothing else, and returns its answer", async () => {
    const seen: unknown[] = [];
    const sink = triageDraftSink(
      { draft: async (c) => (seen.push(c), { inserted: true, draftId: "d-1" }) },
      "gla_token",
    );
    const call: TriageDraftCall = {
      siteId: SITE_A1,
      kind: "email",
      payload: { subject: "Fix soon: x", body: "y" },
      findingIds: ["11111111-0000-4000-8000-000000000001"],
    };
    expect(await sink(call)).toEqual({ inserted: true, draftId: "d-1" });
    expect(seen).toEqual([{ token: "gla_token", ...call }]);
  });

  it("failing fixture: the environment kill switch refuses before any database call", async () => {
    let connects = 0;
    const log: AgentDenyLog[] = [];
    const drafts = createAgentDrafts({
      connect: () => {
        connects++;
        throw new Error("must not connect");
      },
      env: { [AGENTS_OFF_ENV]: "1" },
      now: () => new Date(NOW()),
      onDeny: (e) => log.push(e),
    });
    const out = await runTriage(
      { siteId: SITE_A1, findings: [f("f-1", "canonical-missing")] },
      {
        policy: createTriagePolicy({ env: {}, now: NOW }),
        draft: triageDraftSink(drafts, "gla_token"),
        now: NOW,
      },
    );
    expect([out.created, out.stopped, connects]).toEqual([[], "kill-switch-global", 0]);
    expect(log.map((l) => [l.tool, l.reason])).toEqual([["draft:email", "kill-switch-global"]]);
    await drafts.end();
  });
});

describe("the pending source", () => {
  const TOKEN = `gla_${"a".repeat(8)}_${"b".repeat(43)}`;
  const call = { siteId: SITE_A1, cursor: null, limit: 50 };

  it("failing fixture: the environment kill switch is a refusal with its reason, and no login is needed", async () => {
    vi.stubEnv(AGENTS_OFF_ENV, "1");
    try {
      expect(await triagePendingSource({}, TOKEN)(call)).toEqual({
        read: false,
        reason: "kill-switch-global",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("failing fixture: a server with no agent login, or a refused one, is a failure the run treats as unavailable", async () => {
    await expect(triagePendingSource({}, TOKEN)(call)).rejects.toThrow(/status 503/);
    await expect(triagePendingSource({ agentUnavailable: true }, TOKEN)(call)).rejects.toThrow(
      /status 503/,
    );
  });

  it("failing fixture: a token that is not an agent's is refused as unauthorized, not read", async () => {
    await expect(triagePendingSource({}, "not-a-token")(call)).rejects.toThrow(/status 401/);
  });
});

describe.skipIf(!HAS_DATABASE)("the triage agent against Postgres", () => {
  const tag = randomBytes(4).toString("hex");
  const PERSON = `gl_tr_person_${tag}`;
  const AGENT = `gl_tr_agent_${tag}`;
  const PASSWORD = "agent-triage-test-login";
  let db: TestDatabase;
  let owner: Sql;
  let person: Sql;
  let drafts: ReturnType<typeof createAgentDrafts>;
  const log: AgentDenyLog[] = [];
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
      env: {},
      now: () => new Date(NOW()),
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

  /** The documented registration: the owner registers the agent with its one scope, then sets its limits. */
  async function register(): Promise<{ id: string; token: string }> {
    let out: { id: string; token: string } | undefined;
    await person.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A_OWNER })}, true)`;
      await tx.unsafe("set local role authenticated");
      const [r] =
        await tx`select * from private.register_agent(${ORG_A}, ${`Triage agent ${randomBytes(4).toString("hex")}`}, ${USER_A_OWNER}, ${TRIAGE_REGISTRATION.scopes as unknown as string[]})`;
      out = { id: r!.agent_id as string, token: r!.token as string };
      const l = TRIAGE_REGISTRATION.limits;
      await tx`update agent_limits set calls_per_window = ${l.callsPerWindow}, window_seconds = ${l.windowMs / 1000},
        cost_ceiling_micros = ${l.costCeilingMicros}, timeout_ms = ${l.timeoutMs} where agent_id = ${out.id}`;
    });
    return out!;
  }

  /** Findings of the seeded site, as the agent would be given them (their real ids). */
  async function findings(): Promise<TriageFinding[]> {
    await owner`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint) values
      (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'canonical-missing', 'medium', 'No canonical link', '/menu has none', 'https://tidewater-bar.test/menu', 'aaaaaaaaaaaaaaa1'),
      (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'canonical-elsewhere', 'medium', 'Canonical points elsewhere', '/events', 'https://tidewater-bar.test/events', 'aaaaaaaaaaaaaaa2'),
      (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'certificate-expiring', 'high', 'Certificate expires in 9 days', 'valid until 2026-11-22', 'https://tidewater-bar.test/', 'aaaaaaaaaaaaaaa3')
      on conflict do nothing`;
    const rows =
      await owner`select id, check_id, severity, title, evidence, url from public.findings where site_id = ${SITE_A1} order by id`;
    return rows.map((r) => ({
      id: r.id as string,
      checkId: r.check_id as string,
      severity: r.severity as TriageFinding["severity"],
      title: r.title as string,
      evidence: r.evidence as string,
      url: r.url as string,
    }));
  }

  const deps = (
    token: string,
    over: { limits?: Partial<typeof TRIAGE_REGISTRATION.limits> } = {},
  ) => ({
    policy: createTriagePolicy({ env: {}, now: NOW, ...over }),
    draft: triageDraftSink(drafts, token),
    now: NOW,
  });

  it("passing fixture: one pending email draft per cause, citing real findings, in nobody's name, traced by the database", async () => {
    const a = await register();
    const all = await findings();
    const out = await runTriage({ siteId: SITE_A1, findings: all }, deps(a.token));
    expect(out.stopped).toBeNull();
    expect(out.created.map((c) => c.causeKey)).toEqual([
      "broken-links",
      "certificate",
      "canonical-links",
    ]);
    const rows =
      await owner`select id, kind, payload, finding_ids, created_by from public.drafts where id = any(${out.created.map((c) => c.draftId)}) order by created_at, id`;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.kind).toBe("email");
      expect(r.created_by).toBeNull();
      expect(Object.keys(r.payload as object).sort()).toEqual(["body", "subject"]);
    }
    const subjects = rows.map((r) => (r.payload as { subject: string }).subject).sort();
    expect(subjects).toEqual([
      "Fix first: Broken links",
      "Fix first: Certificate problems",
      "Fix soon: Canonical links",
    ]);
    const decided =
      await owner`select count(*) as n from public.decisions where draft_id = any(${out.created.map((c) => c.draftId)})`;
    expect(Number(decided[0]!.n)).toBe(0);
    const traced =
      await owner`select decision, tool from public.agent_trace where agent_id = ${a.id}`;
    expect(traced.map((t) => [t.decision, t.tool])).toEqual(
      Array(3).fill(["allowed", "draft:email"]),
    );
  });

  it("failing fixture: an agent registered with no scope drafts nothing, and the run stops on the database's refusal", async () => {
    let none: { token: string } | undefined;
    await person.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A_OWNER })}, true)`;
      await tx.unsafe("set local role authenticated");
      const [r] =
        await tx`select * from private.register_agent(${ORG_A}, ${`No scope ${tag}`}, ${USER_A_OWNER}, ${[] as string[]})`;
      none = { token: r!.token as string };
    });
    const before = Number((await owner`select count(*) as n from public.drafts`)[0]!.n);
    const out = await runTriage({ siteId: SITE_A1, findings: await findings() }, deps(none!.token));
    expect([out.created, out.stopped]).toEqual([[], "scope"]);
    expect(Number((await owner`select count(*) as n from public.drafts`)[0]!.n)).toBe(before);
  });

  it("passing fixture: a second run reads the waiting drafts as the agent and drafts nothing again", async () => {
    const a = await register();
    const agentSql = postgres(loginUrl(AGENT), { max: 2, onnotice: () => {} });
    try {
      const all = await findings();
      const first = await runTriage({ siteId: SITE_A1, findings: all }, deps(a.token));
      expect(first.created.length).toBeGreaterThan(0);
      const before = Number((await owner`select count(*) as n from public.drafts`)[0]!.n);
      const second = await runTriage(
        { siteId: SITE_A1, findings: all },
        { ...deps(a.token), readPending: triagePendingSource({ agentSql }, a.token) },
      );
      expect(second.created).toEqual([]);
      expect(second.skipped.map((s) => s.causeKey).sort()).toEqual(
        first.created.map((c) => c.causeKey).sort(),
      );
      expect(second.pending).toMatchObject({ read: true, pages: 1, problem: null });
      expect(second.pending.rows).toBeGreaterThanOrEqual(first.created.length);
      expect(Number((await owner`select count(*) as n from public.drafts`)[0]!.n)).toBe(before);
      const reads =
        await owner`select decision, tool from public.agent_trace where agent_id = ${a.id} and tool = 'read:pending'`;
      expect(reads.map((t) => t.decision)).toEqual(["allowed"]);
    } finally {
      await agentSql.end();
    }
  });

  it("failing fixture: an agent without the read scope is refused by the database, and the run drafts nothing", async () => {
    let draftOnly: { token: string } | undefined;
    await person.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A_OWNER })}, true)`;
      await tx.unsafe("set local role authenticated");
      const [r] =
        await tx`select * from private.register_agent(${ORG_A}, ${`Draft only ${tag}`}, ${USER_A_OWNER}, ${["draft:email"]})`;
      draftOnly = { token: r!.token as string };
    });
    const agentSql = postgres(loginUrl(AGENT), { max: 2, onnotice: () => {} });
    try {
      const before = Number((await owner`select count(*) as n from public.drafts`)[0]!.n);
      const out = await runTriage(
        { siteId: SITE_A1, findings: await findings() },
        {
          ...deps(draftOnly!.token),
          readPending: triagePendingSource({ agentSql }, draftOnly!.token),
        },
      );
      expect([out.created, out.stopped, out.pending.problem]).toEqual([[], "scope", "unavailable"]);
      expect(Number((await owner`select count(*) as n from public.drafts`)[0]!.n)).toBe(before);
    } finally {
      await agentSql.end();
    }
  });

  it("the agent's registered limits (25 calls, cost 0) are the ones the database enforces", async () => {
    const a = await register();
    const [l] =
      await owner`select calls_per_window, window_seconds, cost_ceiling_micros, timeout_ms from public.agent_limits where agent_id = ${a.id}`;
    expect(l).toEqual({
      calls_per_window: TRIAGE_REGISTRATION.limits.callsPerWindow,
      window_seconds: 60,
      cost_ceiling_micros: "0",
      timeout_ms: 10_000,
    });
    // And the database's rate limit stops a run the process's own policy would allow.
    await owner`update public.agent_limits set calls_per_window = 1 where agent_id = ${a.id}`;
    const out = await runTriage({ siteId: SITE_A1, findings: await findings() }, deps(a.token));
    expect(out.created).toHaveLength(1);
    expect(out.stopped).toBe("rate-limit");
  });

  it("the agent's own id is a registry code, not a database id", () => {
    expect(TRIAGE_AGENT_ID).toBe("triage");
  });
});
