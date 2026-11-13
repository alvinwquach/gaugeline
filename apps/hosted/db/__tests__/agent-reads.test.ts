/**
 * Agent reads (AG-08, migration 0014) against a real Postgres, through REAL login roles: an agent's login (a
 * member of `gaugeline_agent` only) and a person's login (a member of `authenticated` only). The migration
 * owner seeds drafts with fixed times and reads the deny log. Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateFunctionsExecutableBy } from "../audit.js";
import {
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  RUN_A1,
  RUN_B1,
  SITE_A1,
  SITE_A2,
  SITE_B1,
  seed,
  type Sql,
  TEST_DATABASE_URL,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_OWNER,
  USER_B_OWNER,
} from "./harness.js";

const tag = randomBytes(4).toString("hex");
const PERSON = `gl_reads_person_${tag}`;
const AGENT = `gl_reads_agent_${tag}`;
const PASSWORD = "reads-test-login";

// Invented drafts (rule 12), hours before now: two fresh in A (one per site), one fresh in B, one expired
// (73 h) and one decided in A, and a Sanity draft and a pull request whose values must not be listed.
const D = (n: number) => `a8d00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PR_FILE_SECRET = ["file", "content", "never", "listed"].join("-");
const FIELD_VALUE = ["field", "value", "never", "listed"].join("-");

class Rollback extends Error {}

type Page = {
  allowed: boolean;
  reason?: string;
  more?: boolean;
  found?: boolean;
  drafts?: Record<string, unknown>[];
  runs?: Record<string, unknown>[];
};

describe.skipIf(!HAS_DATABASE)("agent reads: pending drafts and run history", () => {
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
      create role ${AGENT} login noinherit password '${PASSWORD}' in role gaugeline_agent;
      insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids, created_at) values
        ('${D(1)}', '${ORG_A}', '${SITE_A1}', 'email', '{"subject":"Menu link fixed","body":"The drinks page is back."}', '{}', now() - interval '1 hour'),
        ('${D(2)}', '${ORG_A}', '${SITE_A2}', 'pull_request', '{"title":"Add the canonical tag","body":"One line in the layout.","files":[{"path":"app/layout.tsx","content":"${PR_FILE_SECRET}"}]}', '{}', now() - interval '2 hours'),
        ('${D(3)}', '${ORG_A}', '${SITE_A1}', 'sanity_draft', '{"documentId":"menu-page","documentType":"page","set":{"seoTitle":"${FIELD_VALUE}","alt":"x"},"before":{"seoTitle":"${"a".repeat(64)}","alt":"${"b".repeat(64)}"}}', '{}', now() - interval '3 hours'),
        ('${D(4)}', '${ORG_A}', '${SITE_A1}', 'email', '{"subject":"Expired","body":"Too old."}', '{}', now() - interval '73 hours'),
        ('${D(5)}', '${ORG_A}', '${SITE_A1}', 'email', '{"subject":"Decided","body":"Already declined."}', '{}', now() - interval '4 hours'),
        ('${D(6)}', '${ORG_B}', '${SITE_B1}', 'email', '{"subject":"Other agency","body":"Not yours."}', '{}', now() - interval '1 hour');
      insert into public.decisions (org_id, draft_id, decision, decided_by)
        values ('${ORG_A}', '${D(5)}', 'declined', '${USER_A_OWNER}');`);
    person = postgres(loginUrl(PERSON), { max: 2, onnotice: () => {} });
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

  async function register(scopes: string[], org = ORG_A): Promise<{ id: string; token: string }> {
    const by = org === ORG_A ? USER_A_OWNER : USER_B_OWNER;
    const name = `Reader ${randomBytes(4).toString("hex")}`;
    const [r] = await asPerson(
      by,
      (tx) => tx`select * from private.register_agent(${org}, ${name}, ${by}, ${scopes})`,
      true,
    );
    return { id: r!.agent_id as string, token: r!.token as string };
  }

  /** The agent's own login calls a read and commits (so the count and any deny row stay). */
  const pending = (
    token: string | null,
    o: {
      limit?: number;
      at?: string | null;
      id?: string | null;
      draft?: string;
      site?: string;
    } = {},
  ): Promise<Page> =>
    agent.begin(async (tx) => {
      await tx.unsafe("set local role gaugeline_agent");
      const [r] = await tx`select private.agent_list_pending(${token}, ${o.limit ?? 20},
        ${o.at ?? null}::text::timestamptz, ${o.id ?? null}::uuid, ${o.draft ?? null}::uuid,
        ${o.site ?? null}::uuid) as p`;
      return r!.p as Page;
    }) as Promise<Page>;
  const runs = (
    token: string | null,
    site: string,
    o: { limit?: number; at?: string | null; id?: string | null } = {},
  ): Promise<Page> =>
    agent.begin(async (tx) => {
      await tx.unsafe("set local role gaugeline_agent");
      const [r] = await tx`select private.agent_list_runs(${token}, ${site}::uuid, ${o.limit ?? 20},
        ${o.at ?? null}::text::timestamptz, ${o.id ?? null}::uuid) as p`;
      return r!.p as Page;
    }) as Promise<Page>;

  const lastDenyId = async () =>
    Number((await owner`select coalesce(max(id), 0) as n from public.agent_denies`)[0]!.n);
  const deniesSince = async (since: number) => [
    ...(await owner`select org_id, agent_id, tool, reason from public.agent_denies
      where id > ${since} order by id`),
  ];
  const calls = async (id: string) =>
    Number(
      (await owner`select window_calls from public.agent_limits where agent_id = ${id}`)[0]!
        .window_calls,
    );
  const ids = (p: Page) => (p.drafts ?? []).map((d) => d.id);

  describe("read:pending", () => {
    it("passing fixture: lists only its organisation's undecided drafts younger than 72 hours, newest first", async () => {
      const a = await register(["read:pending"]);
      const since = await lastDenyId();
      const p = await pending(a.token);
      expect(p.allowed).toBe(true);
      expect(ids(p)).toEqual([D(1), D(2), D(3)]);
      expect(p.more).toBe(false);
      expect(await deniesSince(since)).toEqual([]);
    });

    it("lists safe fields only: the payload as its hash, never a file's content or a field's value", async () => {
      const a = await register(["read:pending"]);
      const p = await pending(a.token);
      const text = JSON.stringify(p);
      expect(text).not.toContain(PR_FILE_SECRET);
      expect(text).not.toContain(FIELD_VALUE);
      for (const d of p.drafts!)
        expect(Object.keys(d).sort()).toEqual([
          "created_at",
          "cursor_at",
          "excerpt",
          "expires_at",
          "finding_ids",
          "id",
          "kind",
          "payload_sha256",
          "site_id",
          "title",
        ]);
      const sanity = p.drafts!.find((d) => d.id === D(3))!;
      expect(sanity).toMatchObject({ title: "page menu-page", excerpt: "fields: alt, seoTitle" });
      const [row] = await owner`select payload::text as t from public.drafts where id = ${D(2)}`;
      const pr = p.drafts!.find((d) => d.id === D(2))!;
      expect(pr.payload_sha256).toBe(createHash("sha256").update(String(row!.t)).digest("hex"));
      expect(pr).toMatchObject({
        title: "Add the canonical tag",
        excerpt: "One line in the layout.",
      });
      const created = Date.parse(String(pr.created_at));
      expect(Date.parse(String(pr.expires_at)) - created).toBe(72 * 3600 * 1000);
    });

    it("an agent of organisation B sees nothing of A, and A's draft id read by B is not found", async () => {
      const b = await register(["read:pending"], ORG_B);
      expect(ids(await pending(b.token))).toEqual([D(6)]);
      expect(ids(await pending(b.token, { draft: D(1) }))).toEqual([]);
      expect(ids(await pending(b.token, { site: SITE_A1 }))).toEqual([]);
    });

    it("one draft by id, and a site filter, within the organisation", async () => {
      const a = await register(["read:pending"]);
      expect(ids(await pending(a.token, { draft: D(2) }))).toEqual([D(2)]);
      expect(ids(await pending(a.token, { draft: D(4) }))).toEqual([]); // expired
      expect(ids(await pending(a.token, { draft: D(5) }))).toEqual([]); // decided
      expect(ids(await pending(a.token, { site: SITE_A1 }))).toEqual([D(1), D(3)]);
    });

    it("pages by the last row's (time, id), with no row twice or missed, ties broken by id", async () => {
      const a = await register(["read:pending"]);
      await owner.unsafe(
        `update public.agent_limits set calls_per_window = 100 where agent_id = '${a.id}'`,
      );
      const seen: unknown[] = [];
      let at: string | null = null;
      let id: string | null = null;
      for (let i = 0; i < 5; i++) {
        const p = await pending(a.token, { limit: 1, at, id });
        seen.push(...ids(p));
        if (!p.more) break;
        const last = p.drafts![p.drafts!.length - 1]!;
        at = String(last.cursor_at);
        id = String(last.id);
      }
      expect(seen).toEqual([D(1), D(2), D(3)]);
    });

    it("a cursor keeps its microseconds: two drafts in the same millisecond are both listed, once", async () => {
      // A cursor that lost its microseconds on the way (a JS Date) would skip the second. The API, like
      // this test, sends it as text.
      const b = await register(["read:pending"], ORG_B);
      await owner.unsafe(
        `update public.agent_limits set calls_per_window = 100 where agent_id = '${b.id}'`,
      );
      await owner.unsafe(`insert into public.drafts (id, org_id, site_id, kind, payload, created_at) values
        ('${D(7)}', '${ORG_B}', '${SITE_B1}', 'email', '{"subject":"a","body":"b"}',
          date_trunc('second', now() - interval '5 hours') + interval '500 microseconds'),
        ('${D(8)}', '${ORG_B}', '${SITE_B1}', 'email', '{"subject":"c","body":"d"}',
          date_trunc('second', now() - interval '5 hours') + interval '200 microseconds')`);
      try {
        const seen: unknown[] = [];
        let at: string | null = null;
        let id: string | null = null;
        for (let i = 0; i < 5; i++) {
          const p = await pending(b.token, { limit: 1, at, id });
          seen.push(...ids(p));
          if (!p.more) break;
          const last = p.drafts![p.drafts!.length - 1]!;
          at = String(last.cursor_at);
          id = String(last.id);
        }
        expect(seen).toEqual([D(6), D(7), D(8)]);
      } finally {
        // Drafts are append-only: decided, they leave the pending list for the other tests.
        await owner.unsafe(`insert into public.decisions (org_id, draft_id, decision, decided_by) values
          ('${ORG_B}', '${D(7)}', 'declined', '${USER_B_OWNER}'),
          ('${ORG_B}', '${D(8)}', 'declined', '${USER_B_OWNER}')`);
      }
    });

    it("refuses a page over 50 and half a cursor before the policy: no count, no deny row", async () => {
      const a = await register(["read:pending"]);
      const since = await lastDenyId();
      expect(await errorOf(pending(a.token, { limit: 51 }))).toMatch(/limit must be 1 to 50/);
      expect(await errorOf(pending(a.token, { limit: 0 }))).toMatch(/limit must be 1 to 50/);
      expect(await errorOf(pending(a.token, { at: "2026-11-10 03:00:00+00" }))).toMatch(/cursor/);
      expect(await deniesSince(since)).toEqual([]);
      expect(await calls(a.id)).toBe(0);
    });

    it("authorizes exactly once per call", async () => {
      const a = await register(["read:pending"]);
      await pending(a.token);
      expect(await calls(a.id)).toBe(1);
      await pending(a.token, { draft: D(1) });
      expect(await calls(a.id)).toBe(2);
    });

    it("failing fixture: an agent without read:pending is refused with scope, logged, and lists nothing", async () => {
      const a = await register(["draft:email", "read:runs"]);
      const since = await lastDenyId();
      expect(await pending(a.token)).toEqual({ allowed: false, reason: "scope" });
      expect(await deniesSince(since)).toEqual([
        { org_id: ORG_A, agent_id: a.id, tool: "read:pending", reason: "scope" },
      ]);
    });

    it("an unknown, disabled or revoked agent, and the global kill switch, are refused and logged", async () => {
      const since = await lastDenyId();
      expect(await pending(`gla_00000000_${"x".repeat(43)}`)).toEqual({
        allowed: false,
        reason: "unknown-agent",
      });
      expect(await pending(null)).toEqual({ allowed: false, reason: "unknown-agent" });
      const d = await register(["read:pending"]);
      await asPerson(
        USER_A_OWNER,
        (tx) => tx`update public.agents set status = 'disabled' where id = ${d.id}`,
        true,
      );
      expect(await pending(d.token)).toEqual({ allowed: false, reason: "disabled" });
      const r = await register(["read:pending"]);
      await asPerson(USER_A_OWNER, (tx) => tx`select private.revoke_agent(${r.id})`, true);
      expect(await pending(r.token)).toEqual({ allowed: false, reason: "revoked" });
      const k = await register(["read:pending"]);
      await owner`insert into private.agent_switches (agent_id) values (null)`;
      try {
        expect(await pending(k.token)).toEqual({ allowed: false, reason: "kill-switch-global" });
      } finally {
        await owner`delete from private.agent_switches where agent_id is null`;
      }
      expect((await deniesSince(since)).map((x) => [x.tool, x.reason])).toEqual([
        ["read:pending", "unknown-agent"],
        ["read:pending", "unknown-agent"],
        ["read:pending", "disabled"],
        ["read:pending", "revoked"],
        ["read:pending", "kill-switch-global"],
      ]);
    });

    it("the rate limit applies to reads", async () => {
      const a = await register(["read:pending"]);
      await owner.unsafe(
        `update public.agent_limits set calls_per_window = 1 where agent_id = '${a.id}'`,
      );
      expect((await pending(a.token)).allowed).toBe(true);
      expect(await pending(a.token)).toEqual({ allowed: false, reason: "rate-limit" });
    });

    it("an allowed read sets last used; a refused one does not", async () => {
      const a = await register(["read:runs"]);
      await pending(a.token);
      const [r1] = await owner`select last_used_at from public.agents where id = ${a.id}`;
      expect(r1!.last_used_at).toBeNull();
      const b = await register(["read:pending"]);
      await pending(b.token);
      const [r2] = await owner`select last_used_at from public.agents where id = ${b.id}`;
      expect(r2!.last_used_at).not.toBeNull();
    });
  });

  describe("read:runs", () => {
    it("passing fixture: one site's runs of the token's organisation, with the summary counts", async () => {
      const a = await register(["read:runs"]);
      const p = await runs(a.token, SITE_A1);
      expect(p).toMatchObject({ allowed: true, found: true, more: false });
      expect(p.runs!.map((r) => r.id)).toEqual([RUN_A1]);
      expect(p.runs![0]).toMatchObject({
        started_at: "2026-11-10T03:00:00.000Z",
        finished_at: "2026-11-10T03:01:10.000Z",
        summary: { high: 1, medium: 0, low: 0 },
      });
    });

    it("another organisation's site reads as not found, the same as one that does not exist", async () => {
      const a = await register(["read:runs"]);
      const b = await register(["read:runs"], ORG_B);
      expect(await runs(a.token, SITE_B1)).toEqual({ allowed: true, found: false });
      expect(await runs(a.token, "00000000-0000-4000-8000-000000000000")).toEqual({
        allowed: true,
        found: false,
      });
      expect((await runs(b.token, SITE_B1)).runs!.map((r) => r.id)).toEqual([RUN_B1]);
      expect(JSON.stringify(await runs(b.token, SITE_A1))).not.toContain(RUN_A1);
    });

    it("failing fixture: read:pending alone does not read runs (scope, logged)", async () => {
      const a = await register(["read:pending"]);
      const since = await lastDenyId();
      expect(await runs(a.token, SITE_A1)).toEqual({ allowed: false, reason: "scope" });
      expect(await deniesSince(since)).toEqual([
        { org_id: ORG_A, agent_id: a.id, tool: "read:runs", reason: "scope" },
      ]);
    });

    it("refuses a page over 50 before the policy", async () => {
      const a = await register(["read:runs"]);
      expect(await errorOf(runs(a.token, SITE_A1, { limit: 51 }))).toMatch(/limit must be 1 to 50/);
      expect(await calls(a.id)).toBe(0);
    });
  });

  describe("who can call", () => {
    it("a client viewer, an owner, the server, the worker and the chat login cannot run either read", async () => {
      const a = await register(["read:pending", "read:runs"]);
      for (const user of [USER_A_CLIENT, USER_A_OWNER]) {
        expect(
          await errorOf(asPerson(user, (tx) => tx`select private.agent_list_pending(${a.token})`)),
        ).toMatch(/permission denied/);
        expect(
          await errorOf(
            asPerson(
              user,
              (tx) => tx`select private.agent_list_runs(${a.token}, ${SITE_A1}::uuid)`,
            ),
          ),
        ).toMatch(/permission denied/);
      }
      for (const role of [
        "anon",
        "authenticated",
        "service_role",
        "gaugeline_worker",
        "gaugeline_chat",
      ]) {
        const fns = await privateFunctionsExecutableBy(owner, role);
        expect(fns, role).not.toContain("agent_list_pending");
        expect(fns, role).not.toContain("agent_list_runs");
      }
    });

    it("the agent role still reads no table directly", async () => {
      expect(
        await errorOf(
          agent.begin(async (tx) => {
            await tx.unsafe("set local role gaugeline_agent");
            await tx`select id from public.drafts limit 1`;
          }),
        ),
      ).toMatch(/permission denied/);
      const [g] = await owner`select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'gaugeline_agent'`;
      expect(g!.n).toBe(0);
    });

    it("both reads are SECURITY DEFINER with an empty search_path", async () => {
      const rows = await owner`select p.proname, p.prosecdef, p.proconfig from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname in ('agent_list_pending', 'agent_list_runs') order by 1`;
      expect(rows.map((r) => [r.proname, r.prosecdef, r.proconfig])).toEqual([
        ["agent_list_pending", true, ['search_path=""']],
        ["agent_list_runs", true, ['search_path=""']],
      ]);
    });
  });
});
