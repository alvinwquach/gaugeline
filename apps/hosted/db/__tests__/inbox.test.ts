/**
 * The drafts inbox (G37) against a real Postgres: agents draft, a person decides once, and an approval
 * enqueues exactly one apply job carrying the hash of what was approved. Skipped without
 * GAUGELINE_TEST_DATABASE_URL (see the db harness).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentLoginsWithOtherRoles } from "../audit.js";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  RUN_A1,
  RUN_B1,
  seed,
  SITE_A1,
  SITE_A2,
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
} from "./harness.js";
import { checkDraftPayload, jsonbText, MAX_PAYLOAD_BYTES } from "../../inbox/kinds.js";
import {
  decide,
  listWaiting,
  MemoryApplyQueue,
  verifyApplyJob,
  type ApplyQueue,
} from "../../inbox/inbox.js";

const PR_PAYLOAD = {
  title: "Point the menu link at /drinks",
  body: "The menu page links to /drinks-2025, which returns 404.",
  files: [{ path: "app/menu/links.ts", content: 'export const drinks = "/drinks";\n' }],
};
/** An invented agent token, built at run time (never a key-shaped literal in the source). */
const token = () => ["gla", randomBytes(24).toString("hex")].join("_");
/** What a proposer records for a field's published value (X71): the app and the database check only its shape. */
const digestOf = (field: string) => createHash("sha256").update(field).digest("hex");
/** A sanity payload with the `before` digests its `set` needs. Other payloads are returned unchanged. */
function withBefore(payload: unknown): unknown {
  const p = payload as { set?: unknown; before?: unknown } | null;
  if (!p || typeof p !== "object" || typeof p.set !== "object" || p.set === null || "before" in p)
    return payload;
  const before = Object.fromEntries(Object.keys(p.set).map((k) => [k, digestOf(k)]));
  return { ...p, before };
}
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe.skipIf(!HAS_DATABASE)("drafts inbox", () => {
  let db: TestDatabase;
  let sql: Sql;
  let queue: MemoryApplyQueue;
  const owner = { userId: USER_A_OWNER };
  const member = { userId: USER_A_MEMBER };
  const TOKEN_A = token();
  const TOKEN_B = token();
  const TOKEN_REVOKED = token();

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
    // Registered agents (0011) with every draft scope; then one is revoked.
    for (const [org, ownerId, t, revoked] of [
      [ORG_A, USER_A_OWNER, TOKEN_A, false],
      [ORG_B, USER_B_OWNER, TOKEN_B, false],
      [ORG_A, USER_A_OWNER, TOKEN_REVOKED, true],
    ] as const) {
      const [a] =
        await sql`insert into public.agents (org_id, name, owner_id, scopes, token_sha256, token_prefix)
        values (${org}, ${`Inbox test agent ${sha256(t).slice(0, 8)}`}, ${ownerId},
          '{draft:pull_request,draft:email,draft:sanity_draft}', ${sha256(t)}, ${sha256(t).slice(0, 8)})
        returning id`;
      if (revoked)
        await sql`update public.agents set status = 'revoked' where id = ${a!.id as string}`;
    }
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(() => {
    queue = new MemoryApplyQueue();
  });

  /** A new draft as an agent would write it (inserted by the owner connection for set-up). */
  async function draft(findingIds: string[] = [], payload: object = PR_PAYLOAD): Promise<string> {
    const id = randomUUID();
    await sql`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids)
      values (${id}, ${ORG_A}, ${SITE_A1}, 'pull_request', ${sql.json(payload as never)}, ${findingIds})`;
    return id;
  }
  const decisionsFor = async (id: string) =>
    sql`select decision, edited_payload, decided_by, payload_sha256 from public.decisions where draft_id = ${id}`;

  /**
   * Run `fn` as the agent role and commit; returns "" or the error. `claims` are whatever the session
   * chooses to set: the agent's organisation must never depend on them.
   */
  async function asAgent(fn: (tx: Sql) => Promise<unknown>, claims: object = {}): Promise<string> {
    return errorOf(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx.unsafe("set local role gaugeline_agent");
        await fn(tx as unknown as Sql);
      }),
    );
  }
  const agentInsert = (t: string, site: string, kind = "pull_request", findings: string[] = []) =>
    asAgent(
      (tx) =>
        tx`select private.agent_insert_draft(${t}, ${site}, ${kind}, ${sql.json(PR_PAYLOAD)}, ${findings}::uuid[])`,
    );

  describe("the agent (the database refuses, not the app)", () => {
    it("inserts a draft into its token's organisation, in nobody's name", async () => {
      const marker = randomUUID();
      const msg = await asAgent(
        (tx) =>
          tx`select private.agent_insert_draft(${TOKEN_A}, ${SITE_A1}, 'pull_request',
            ${sql.json({ ...PR_PAYLOAD, body: marker })})`,
      );
      expect(msg).toBe("");
      const rows =
        await sql`select org_id, created_by from public.drafts where payload ->> 'body' = ${marker}`;
      expect(rows).toEqual([{ org_id: ORG_A, created_by: null }]);
    });

    it("cannot choose its organisation with request claims (the reviewer's repro)", async () => {
      const direct = await asAgent(
        (tx) =>
          tx`insert into public.drafts (org_id, site_id, kind, payload)
             values (${ORG_B}, ${SITE_B1}, 'pull_request', '{"title":"injected into org B"}')`,
        { org_id: ORG_B },
      );
      expect(direct).toMatch(/permission denied/);
      const viaFunction = await asAgent(
        (tx) =>
          tx`select private.agent_insert_draft(${TOKEN_A}, ${SITE_B1}, 'pull_request', '{"title":"x"}')`,
        { org_id: ORG_B },
      );
      expect(viaFunction).toMatch(/site not found for this agent/);
    });

    it("refuses an unknown, revoked or short token", async () => {
      for (const t of [token(), TOKEN_REVOKED, "short"])
        expect(await agentInsert(t, SITE_A1)).toMatch(/agent token not recognised/);
    });

    it("another organisation's token writes only into that organisation", async () => {
      expect(await agentInsert(TOKEN_B, SITE_A1)).toMatch(/site not found/);
      expect(await agentInsert(TOKEN_B, SITE_B1)).toBe("");
    });

    it("refuses a finding of another organisation or site, and an unregistered kind", async () => {
      const [fb] = await sql`select id from public.findings where org_id = ${ORG_B}`;
      expect(await agentInsert(TOKEN_A, SITE_A1, "pull_request", [fb!.id])).toMatch(
        /finding not found/,
      );
      // Deny by default (0011): no agent holds a scope for a kind that is not registered.
      expect(await agentInsert(TOKEN_A, SITE_A1, "shell_exec")).toMatch(/no scope to draft/);
    });

    it("cannot insert a decision, change a draft, or read anything", async () => {
      const id = await draft();
      for (const stmt of [
        `insert into public.decisions (org_id, draft_id, decision, decided_by) values ('${ORG_A}', '${id}', 'approved', '${USER_A_OWNER}')`,
        `insert into public.drafts (org_id, site_id, kind, payload) values ('${ORG_A}', '${SITE_A1}', 'email', '{}')`,
        `update public.drafts set payload = '{"title":"x"}' where id = '${id}'`,
        `delete from public.drafts where id = '${id}'`,
        `select * from public.drafts`,
        `select * from public.draft_state`,
        `select * from public.decisions`,
        `select id from public.agents`,
        `select id from public.agent_events`,
      ])
        expect(await asAgent((tx) => tx.unsafe(stmt)), stmt).toMatch(/permission denied/);
    });

    it("a signed-in person cannot use the agent's way in", async () => {
      const msg = await errorOf(
        as(
          sql,
          { role: "authenticated", userId: USER_A_OWNER },
          (tx) =>
            tx`select private.agent_insert_draft(${TOKEN_A}, ${SITE_A1}, 'pull_request', '{}')`,
        ),
      );
      expect(msg).toMatch(/permission denied/);
    });
  });

  describe("the database holds every inserter to the registry and the size cap", () => {
    it("a member cannot insert a draft of an unregistered kind", async () => {
      const msg = await errorOf(
        as(
          sql,
          { role: "authenticated", userId: USER_A_MEMBER },
          (tx) =>
            tx`insert into public.drafts (org_id, site_id, kind, payload, created_by)
             values (${ORG_A}, ${SITE_A1}, 'shell_exec', '{}', ${USER_A_MEMBER})`,
        ),
      );
      expect(msg).toMatch(/drafts_kind_check/);
    });

    it("an edited payload over 16 KB is refused, even inserted directly", async () => {
      const id = await draft();
      const big = { ...PR_PAYLOAD, body: "x".repeat(17_000) };
      const msg = await errorOf(
        as(
          sql,
          { role: "authenticated", userId: USER_A_MEMBER },
          (tx) =>
            tx`insert into public.decisions (org_id, draft_id, decision, edited_payload, decided_by)
             values (${ORG_A}, ${id}, 'edited', ${tx.json(big)}, ${USER_A_MEMBER})`,
        ),
      );
      expect(msg).toMatch(/decisions_edited_payload_size/);
    });

    it("nobody supplies the payload hash: the database computes it", async () => {
      const id = await draft();
      const msg = await errorOf(
        as(
          sql,
          { role: "authenticated", userId: USER_A_MEMBER },
          (tx) =>
            tx`insert into public.decisions (org_id, draft_id, decision, decided_by, payload_sha256)
             values (${ORG_A}, ${id}, 'approved', ${USER_A_MEMBER}, ${"0".repeat(64)})`,
        ),
      );
      expect(msg).toMatch(/permission denied/);
    });
  });

  describe("deciding", () => {
    it("lists waiting drafts only, and approving removes one from the list", async () => {
      const id = await draft();
      expect((await listWaiting(sql, owner)).map((d) => d.id)).toContain(id);
      expect((await decide(sql, owner, id, { kind: "approve" }, queue)).status).toBe("recorded");
      expect((await listWaiting(sql, member)).map((d) => d.id)).not.toContain(id);
    });

    it("approve: one decision row and one apply job, even on a double click", async () => {
      const id = await draft();
      const results = await Promise.all([
        decide(sql, owner, id, { kind: "approve" }, queue),
        decide(sql, owner, id, { kind: "approve" }, queue),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["already-decided", "recorded"]);
      expect(await decisionsFor(id)).toHaveLength(1);
      expect([...queue.jobs.values()].filter((j) => j.draftId === id)).toHaveLength(1);
    });

    it("two people approving at the same moment: one decision, one apply", async () => {
      const id = await draft();
      const results = await Promise.all([
        decide(sql, owner, id, { kind: "approve" }, queue),
        decide(sql, member, id, { kind: "edit", payload: { ...PR_PAYLOAD, title: "Mine" } }, queue),
      ]);
      expect(results.filter((r) => r.status === "recorded")).toHaveLength(1);
      expect(await decisionsFor(id)).toHaveLength(1);
      expect(queue.jobs.size).toBe(1);
    });

    it("the job carries the approved payload and the approval's hash of it", async () => {
      const id = await draft();
      await decide(sql, owner, id, { kind: "approve" }, queue);
      const job = queue.jobs.get(id)!;
      const [row] = await decisionsFor(id);
      expect(job.payloadSha256).toBe(row!.payload_sha256);
      expect(job.payloadSha256).toBe(sha256(job.payloadText));
      expect(verifyApplyJob(job)).toEqual(PR_PAYLOAD);
    });

    it("a job whose payload differs from the approved one is refused", () => {
      const payloadText = JSON.stringify(PR_PAYLOAD);
      const job = {
        orgId: ORG_A,
        draftId: randomUUID(),
        decisionId: "1",
        kind: "pull_request",
        payloadText: JSON.stringify({ ...PR_PAYLOAD, title: "Swapped after approval" }),
        payloadSha256: sha256(payloadText),
      };
      expect(() => verifyApplyJob(job)).toThrow(/not the one approved/);
      expect(verifyApplyJob({ ...job, payloadText })).toEqual(PR_PAYLOAD);
    });

    it("edit first: the edited payload is applied and the original draft is kept", async () => {
      const id = await draft();
      const edited = { ...PR_PAYLOAD, title: "Fix the drinks link on the menu" };
      const r = await decide(sql, member, id, { kind: "edit", payload: edited }, queue);
      expect(r.status).toBe("recorded");
      expect(verifyApplyJob(queue.jobs.get(id)!)).toEqual(edited);
      expect((await sql`select payload from public.drafts where id = ${id}`)[0]!.payload).toEqual(
        PR_PAYLOAD,
      );
      expect((await decisionsFor(id))[0]).toMatchObject({
        decision: "edited",
        edited_payload: edited,
      });
    });

    it("an edit outside the kind's fixed shape is refused before it is recorded (the reviewer's repro)", async () => {
      const id = await draft();
      const hostile = {
        title: "x\n--upload-pack=touch /tmp/pwned",
        body: "ok",
        files: [{ path: "../../.github/workflows/x.yml", content: "on: push" }],
        branch: "--force main",
        extra: { nested: true },
      };
      for (const payload of [
        hostile,
        ["x"],
        { ...PR_PAYLOAD, files: [{ path: "-rf", content: "" }] },
      ]) {
        const r = await decide(sql, member, id, { kind: "edit", payload }, queue);
        expect(r.status).toBe("invalid-payload");
      }
      expect(await decisionsFor(id)).toHaveLength(0);
      expect(queue.jobs.size).toBe(0);
    });

    it("a draft stored before the shape rules (the trigger was not there) cannot be approved, only declined", async () => {
      const id = randomUUID();
      await sql.begin(async (tx) => {
        await tx.unsafe("alter table public.drafts disable trigger drafts_check_payload");
        await tx`insert into public.drafts (id, org_id, site_id, kind, payload)
          values (${id}, ${ORG_A}, ${SITE_A1}, 'pull_request',
            ${tx.json({ title: "x", body: "y", files: [], branch: "main" })})`;
        await tx.unsafe("alter table public.drafts enable trigger drafts_check_payload");
      });
      expect((await decide(sql, owner, id, { kind: "approve" }, queue)).status).toBe(
        "invalid-payload",
      );
      // The database refuses the approval too, whoever inserts it.
      const direct = await errorOf(
        as(
          sql,
          { role: "authenticated", userId: USER_A_OWNER },
          (tx) =>
            tx`insert into public.decisions (org_id, draft_id, decision, decided_by)
             values (${ORG_A}, ${id}, 'approved', ${USER_A_OWNER})`,
        ),
      );
      expect(direct).toMatch(/does not match the pull_request shape/);
      expect((await decide(sql, owner, id, { kind: "decline" }, queue)).status).toBe("recorded");
      expect(queue.jobs.size).toBe(0);
    });

    it("a draft naming another organisation's finding cannot be approved", async () => {
      const [fb] = await sql`select id from public.findings where org_id = ${ORG_B}`;
      const id = await draft([fb!.id as string]);
      const r = await decide(sql, owner, id, { kind: "approve" }, queue);
      expect(r).toMatchObject({ status: "invalid-payload" });
      expect(queue.jobs.size).toBe(0);
    });

    it("decline: a decision row with no hash and no job", async () => {
      const id = await draft();
      const r = await decide(
        sql,
        owner,
        id,
        { kind: "decline", reason: "Menu is being rebuilt" },
        queue,
      );
      expect(r.status).toBe("recorded");
      expect(await decisionsFor(id)).toMatchObject([
        { decision: "declined", payload_sha256: null },
      ]);
      expect(queue.jobs.size).toBe(0);
    });

    it("a client viewer cannot approve: no decision, no job", async () => {
      const id = await draft();
      const r = await decide(sql, { userId: USER_A_CLIENT }, id, { kind: "approve" }, queue);
      expect(r.status).toBe("not-found");
      expect(await decisionsFor(id)).toHaveLength(0);
      expect(queue.jobs.size).toBe(0);
    });

    it("an id that is not a UUID is not found, not an error", async () => {
      expect(await decide(sql, owner, "nope'--", { kind: "approve" }, queue)).toEqual({
        status: "not-found",
      });
    });

    it("the job is enqueued inside the decision's transaction: a failed enqueue records nothing", async () => {
      const id = await draft();
      const failing: ApplyQueue = {
        enqueueApply: async (tx) => {
          await tx`select 1`; // the same transaction is usable
          throw new Error("queue unavailable");
        },
      };
      expect(await errorOf(decide(sql, owner, id, { kind: "approve" }, failing))).toMatch(
        /queue unavailable/,
      );
      expect(await decisionsFor(id)).toHaveLength(0);
    });
  });

  describe("approving a draft whose finding has since closed", () => {
    async function finding(fingerprint: string): Promise<string> {
      const [f] = await sql`insert into public.findings
        (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
        values (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'broken-links', 'high', 'Broken link', 'https://tidewater-bar.test/', ${fingerprint})
        returning id`;
      return f!.id as string;
    }

    it("a later complete run without its fingerprint closes it: approval warns first", async () => {
      const f = await finding("aaaaaaaaaaaaaaaa");
      const id = await draft([f]);
      await sql`insert into public.runs (org_id, site_id, started_at, finished_at, summary)
        values (${ORG_A}, ${SITE_A1}, '2026-11-12T03:00:00Z', '2026-11-12T03:01:00Z', '{}')`;
      const first = await decide(sql, owner, id, { kind: "approve" }, queue);
      expect(first).toEqual({ status: "confirm-closed-findings", closedFindingIds: [f] });
      expect(await decisionsFor(id)).toHaveLength(0);
      const second = await decide(sql, owner, id, { kind: "approve" }, queue, {
        confirmClosed: true,
      });
      expect(second.status).toBe("recorded");
      expect(queue.jobs.size).toBe(1);
    });

    // Each case gets its own site, so the runs of one never close the findings of another.
    async function closedBy(laterSummary: object): Promise<string> {
      const [site] = await sql`insert into public.sites (org_id, name, url, timezone)
        values (${ORG_A}, 'Closing test', ${`https://closing-${randomUUID()}.test`}, 'Europe/London') returning id`;
      const [first] = await sql`insert into public.runs (org_id, site_id, started_at, finished_at)
        values (${ORG_A}, ${site!.id}, '2026-11-01T03:00:00Z', '2026-11-01T03:01:00Z') returning id`;
      const [f] = await sql`insert into public.findings
        (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
        values (${ORG_A}, ${site!.id}, ${first!.id}, 'broken-links', 'high', 'Broken link',
          'https://tidewater-bar.test/', 'cccccccccccccccc') returning id`;
      const id = randomUUID();
      await sql`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids)
        values (${id}, ${ORG_A}, ${site!.id}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${[f!.id]})`;
      await sql`insert into public.runs (org_id, site_id, started_at, finished_at, summary)
        values (${ORG_A}, ${site!.id}, '2026-11-02T03:00:00Z', '2026-11-02T03:01:00Z', ${sql.json(laterSummary as never)})`;
      return (await decide(sql, owner, id, { kind: "approve" }, queue)).status;
    }

    it("a later run that finished but could not run the finding's check does not close it", async () => {
      const skipped = (id: string) => ({ couldNotCheck: [{ id, reason: "the site timed out" }] });
      expect(await closedBy(skipped("broken-links"))).toBe("recorded");
      // A different check being skipped says nothing about this one.
      expect(await closedBy(skipped("canonical-missing"))).toBe("confirm-closed-findings");
    });

    it("a later run with an error, or a possibly cut-off list of skipped checks, does not close it", async () => {
      expect(await closedBy({ error: "fetch-failed" })).toBe("recorded");
      const twenty = Array.from({ length: 20 }, (_, i) => ({
        id: `other-check-${i}`,
        reason: "r",
      }));
      expect(await closedBy({ couldNotCheck: twenty })).toBe("recorded");
      expect(await closedBy({ couldNotCheck: twenty.slice(1) })).toBe("confirm-closed-findings");
      expect(await closedBy({ couldNotCheck: "not a list" })).toBe("confirm-closed-findings");
    });

    it("a later run that was partial does not close it: no warning", async () => {
      const [r] =
        await sql`insert into public.runs (org_id, site_id, started_at, finished_at, summary)
        values (${ORG_B}, ${SITE_B1}, '2026-11-11T08:00:00Z', '2026-11-11T08:00:30Z', '{"partial":true}')
        returning id`;
      expect(r).toBeDefined();
      const [f] = await sql`select id from public.findings where run_id = ${RUN_B1}`;
      const id = randomUUID();
      await sql`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids)
        values (${id}, ${ORG_B}, ${SITE_B1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${[f!.id]})`;
      const r2 = await decide(sql, { userId: USER_B_OWNER }, id, { kind: "approve" }, queue);
      expect(r2.status).toBe("recorded");
    });
  });
  describe("the database holds every inserter to each kind's shape (a person can bypass the app)", () => {
    const HOSTILE_PR = {
      title: "t\nx",
      body: "b",
      branch: "main",
      files: [{ path: "../../.github/workflows/x.yml", content: "x" }],
    };
    const HOSTILE_EDITS: [string, unknown][] = [
      ["a newline in the title", { ...PR_PAYLOAD, title: "t\nx" }],
      [
        "a path into .github",
        { ...PR_PAYLOAD, files: [{ path: "../../.github/workflows/pwn.yml", content: "x" }] },
      ],
      ["a branch key", { ...PR_PAYLOAD, branch: "main" }],
      [
        "a git hook",
        { ...PR_PAYLOAD, files: [{ path: "sub/.git/hooks/pre-commit", content: "x" }] },
      ],
      ["a C1 line break in the title", { ...PR_PAYLOAD, title: "t\u0085x" }],
      ["not an object", ["x"]],
    ];
    const person = { role: "authenticated" as const, userId: USER_A_MEMBER };
    const directDecision = (id: string, edited: unknown) =>
      errorOf(
        as(
          sql,
          person,
          (tx) =>
            tx`insert into public.decisions (org_id, draft_id, decision, edited_payload, decided_by)
             values (${ORG_A}, ${id}, 'edited', ${tx.json(edited as never)}, ${USER_A_MEMBER})`,
        ),
      );

    it("the agent's function refuses the hostile draft (the reviewer's repro)", async () => {
      const msg = await asAgent(
        (tx) =>
          tx`select private.agent_insert_draft(${TOKEN_A}, ${SITE_A1}, 'pull_request', ${sql.json(HOSTILE_PR)})`,
      );
      expect(msg).toMatch(/does not match the pull_request shape/);
    });

    it("a person inserting a hostile draft directly is refused too", async () => {
      const msg = await errorOf(
        as(
          sql,
          person,
          (tx) =>
            tx`insert into public.drafts (org_id, site_id, kind, payload, created_by)
             values (${ORG_A}, ${SITE_A1}, 'pull_request', ${tx.json(HOSTILE_PR)}, ${USER_A_MEMBER})`,
        ),
      );
      expect(msg).toMatch(/does not match the pull_request shape/);
    });

    it("a person recording a hostile edit directly is refused, and the draft keeps its one decision", async () => {
      const id = await draft();
      for (const [name, edited] of HOSTILE_EDITS)
        expect(await directDecision(id, edited), name).toMatch(/shape|decisions_/);
      expect(await decisionsFor(id)).toHaveLength(0);
      const r = await decide(sql, owner, id, { kind: "approve" }, queue);
      expect(r.status).toBe("recorded");
    });

    it("a sanity draft cannot set Sanity's system fields, through the app or directly", async () => {
      const id = randomUUID();
      const payload = withBefore({
        documentId: "menu",
        documentType: "page",
        set: { title: "Opening hours" },
      });
      await sql`insert into public.drafts (id, org_id, site_id, kind, payload)
        values (${id}, ${ORG_A}, ${SITE_A1}, 'sanity_draft', ${sql.json(payload as never)})`;
      const hostile = withBefore({
        documentId: "menu",
        documentType: "page",
        set: { _id: "menu", _type: "page", title: "x" },
      });
      const r = await decide(sql, owner, id, { kind: "edit", payload: hostile }, queue);
      expect(r.status).toBe("invalid-payload");
      expect(await directDecision(id, hostile)).toMatch(/does not match the sanity_draft shape/);
      expect(await decisionsFor(id)).toHaveLength(0);
      expect(queue.jobs.size).toBe(0);
    });

    // One list, two validators: the app's (kinds.ts) and the database's must agree on every payload.
    const CORPUS: [string, unknown][] = [
      ["pull_request", PR_PAYLOAD],
      ["pull_request", { ...PR_PAYLOAD, body: "" }],
      ["pull_request", { ...PR_PAYLOAD, title: "" }],
      ["pull_request", { ...PR_PAYLOAD, title: "a\tb" }],
      ["pull_request", { ...PR_PAYLOAD, body: "one\ntwo\tthree" }],
      ["pull_request", { ...PR_PAYLOAD, body: "a\rb" }],
      ["pull_request", { ...PR_PAYLOAD, branch: "main" }],
      ["pull_request", { title: "t", body: "b" }],
      ["pull_request", { ...PR_PAYLOAD, files: [] }],
      ["pull_request", { ...PR_PAYLOAD, files: "x" }],
      ["pull_request", { ...PR_PAYLOAD, files: [{ path: "a.txt" }] }],
      ["pull_request", { ...PR_PAYLOAD, files: [{ path: "a.txt", content: "x", mode: "x" }] }],
      ["pull_request", { ...PR_PAYLOAD, files: [{ path: "a.txt", content: 1 }] }],
      [
        "pull_request",
        {
          ...PR_PAYLOAD,
          files: Array.from({ length: 21 }, (_, i) => ({ path: `f${i}`, content: "" })),
        },
      ],
      [
        "pull_request",
        {
          ...PR_PAYLOAD,
          files: Array.from({ length: 20 }, (_, i) => ({ path: `f${i}`, content: "" })),
        },
      ],
      ["pull_request", { ...PR_PAYLOAD, files: [PR_PAYLOAD.files[0], PR_PAYLOAD.files[0]] }],
      ["pull_request", 5],
      ["email", { subject: "s", body: "b" }],
      ["email", { subject: "s", body: "b", to: "someone" }],
      ["email", { subject: "s" }],
      ["email", { subject: "s", body: 1 }],
      ["email", { subject: "a\u2028b", body: "b" }],
      ["email", { subject: "s", body: "a\u0085b" }],
      ["email", { subject: "s".repeat(201), body: "b" }],
      ["email", { subject: "s".repeat(200), body: "b" }],
      // Bidirectional controls and non-characters: refused in a single line, fine in prose.
      ...[
        0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfffe, 0xffff,
      ].flatMap((c): [string, unknown][] => [
        ["email", { subject: `a${String.fromCharCode(c)}b`, body: "b" }],
        ["pull_request", { ...PR_PAYLOAD, title: `a${String.fromCharCode(c)}b` }],
        ["email", { subject: "s", body: `a${String.fromCharCode(c)}b` }],
      ]),
      ["email", { subject: "a\u05d0b", body: "b" }],
      ["email", { subject: "a\u202fb\u2065c\u206ad\ufffde", body: "b" }],
      // Two paths that differ only by case, and the same path twice.
      [
        "pull_request",
        {
          ...PR_PAYLOAD,
          files: [
            { path: "docs/Readme.md", content: "x" },
            { path: "docs/README.md", content: "y" },
          ],
        },
      ],
      [
        "pull_request",
        {
          ...PR_PAYLOAD,
          files: [
            { path: "docs/readme.md", content: "x" },
            { path: "docs/readme2.md", content: "y" },
          ],
        },
      ],
      // Numbers: more than 15 significant digits is refused, 15 or fewer is fine.
      ...[0.1 + 0.2, 1 / 3, 100000000000000.5, 0.1, 4.5, -0.25, 999999999999999, 0.000001].map(
        (n): [string, unknown] => [
          "sanity_draft",
          { documentId: "menu", documentType: "page", set: { n } },
        ],
      ),
      [
        "sanity_draft",
        {
          documentId: "menu",
          documentType: "page",
          set: { title: "x", n: 1.5, b: false, z: null },
        },
      ],
      ["sanity_draft", { documentId: "menu", documentType: "page", set: {} }],
      ["sanity_draft", { documentId: "menu", documentType: "page", set: { _id: "x" } }],
      ["sanity_draft", { documentId: "menu", documentType: "page", set: { "a.b": "x" } }],
      ["sanity_draft", { documentId: "menu", documentType: "page", set: { a: { b: 1 } } }],
      ["sanity_draft", { documentId: "menu", documentType: "page", set: { a: [1] } }],
      ["sanity_draft", { documentId: "menu", documentType: "page", set: { n: 1e20 } }],
      ["sanity_draft", { documentId: "menu", documentType: "page", set: { n: 1e-7 } }],
      ["sanity_draft", { documentId: "drafts.menu", documentType: "page", set: { a: "x" } }],
      ["sanity_draft", { documentId: "_menu", documentType: "page", set: { a: "x" } }],
      ["sanity_draft", { documentId: "menu", documentType: "1page", set: { a: "x" } }],
      [
        "sanity_draft",
        {
          documentId: "menu",
          documentType: "page",
          set: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "x"])),
        },
      ],
      ["sanity_draft", { documentId: "menu", documentType: "page" }],
      ...[
        "app/menu/links.ts",
        "src/[id]/(g)/@modal/page.tsx",
        ".eslintrc.json",
        "a.git/x",
        "gitmodules",
        ".git/config",
        "sub/.git/hooks/pre-commit",
        ".GIT./x",
        ".gitmodules",
        "d/.gitmodules",
        ".github/w.yml",
        "p/.github/w.yml",
        ".circleci/config.yml",
        "x/.circleci/c.yml",
        ".gitlab-ci.yml",
        "x/.gitlab-ci.yml",
        ".husky/pre-commit",
        "../x",
        "a/../x",
        "a/./x",
        "...",
        "/etc/x",
        "-rf",
        "a/-b",
        "a//b",
        "a/",
        "a b",
        "x".repeat(301),
        "x".repeat(300),
      ].map((path): [string, unknown] => [
        "pull_request",
        { ...PR_PAYLOAD, files: [{ path, content: "x" }] },
      ]),
    ];

    it("gives the same verdict as the app's shapes on a list of payloads", async () => {
      const before = Object.fromEntries([["hours", digestOf("hours")]]);
      const sanityBase = { documentId: "menu", documentType: "page", set: { hours: "x" } };
      const BEFORE_CASES: [string, unknown][] = [
        ["sanity_draft", { ...sanityBase, before }],
        ["sanity_draft", sanityBase], // no before
        ["sanity_draft", { ...sanityBase, before: {} }],
        ["sanity_draft", { ...sanityBase, before: "x" }],
        ["sanity_draft", { ...sanityBase, before: [] }],
        ["sanity_draft", { ...sanityBase, before: { phone: digestOf("phone") } }],
        ["sanity_draft", { ...sanityBase, before: { ...before, phone: digestOf("phone") } }],
        ["sanity_draft", { ...sanityBase, before: { hours: digestOf("hours").toUpperCase() } }],
        ["sanity_draft", { ...sanityBase, before: { hours: digestOf("hours").slice(1) } }],
        ["sanity_draft", { ...sanityBase, before: { hours: 5 } }],
        ["sanity_draft", { ...sanityBase, before: { hours: null } }],
        ["sanity_draft", { ...sanityBase, before, extra: 1 }],
      ];
      for (const [kind, payload] of [
        ...CORPUS.map(([k, p]): [string, unknown] => [k, withBefore(p)]),
        ...BEFORE_CASES,
      ]) {
        const [row] =
          await sql`select private.draft_payload_problem(${kind}, ${sql.json(payload as never)}) as problem`;
        const appOk = checkDraftPayload(kind, payload).ok;
        expect(row!.problem === null, `${kind} ${JSON.stringify(payload).slice(0, 120)}`).toBe(
          appOk,
        );
      }
    });
  });

  describe("numbers the database holds as exact decimals (the app only ever sees a parsed double)", () => {
    const sanityText = (n: string) =>
      `{"documentId": "menu", "documentType": "page", "set": {"n": ${n}}, "before": {"n": "${digestOf("n")}"}}`;
    // [JSON text, whether the database accepts it, whether the app accepts the text's parsed value].
    const NUMBERS: [string, boolean, boolean][] = [
      ["9.99999999999999999999e14", false, false], // under 1e15 as a decimal, 1e15 as a double
      ["0.1234567890123456789012345", false, false], // JSON.parse drops digits: another value
      ["0.30000000000000004", false, false],
      ["100000000000000.5", false, false],
      ["123456.789", true, true],
      ["1.500000000000000000000", true, true], // the same value as 1.5
      ["999999999999999", true, true],
      ["0.000001", true, true],
      ["1e15", false, false],
      // Just under 1e-6 as a decimal, exactly 1e-6 as a double: the database is the authority, and the app
      // never gets to see the digits (its input is parsed). Writing the double back is accepted.
      ["0.00000099999999999999999999", false, true],
    ];
    it("the database refuses what a double cannot hold, and agrees with the app wherever the app can see", async () => {
      for (const [text, dbOk, appOk] of NUMBERS) {
        const payload = sanityText(text);
        const [row] =
          await sql`select private.draft_payload_problem('sanity_draft', ${payload}::text::jsonb) as problem`;
        expect(row!.problem === null, `database: ${text}`).toBe(dbOk);
        expect(checkDraftPayload("sanity_draft", JSON.parse(payload)).ok, `app: ${text}`).toBe(
          appOk,
        );
        if (dbOk !== appOk) {
          // The only disagreement is a value the app saw after rounding; the rounded value is fine.
          const [again] =
            await sql`select private.draft_payload_problem('sanity_draft', ${JSON.stringify(JSON.parse(payload))}::text::jsonb) as problem`;
          expect(again!.problem, `written back: ${text}`).toBeNull();
        }
      }
    });

    it("a stored draft the database would refuse is invalid-payload on approval, not a thrown 23514", async () => {
      const id = randomUUID();
      const stored = sanityText("0.00000099999999999999999999");
      await sql.begin(async (tx) => {
        await tx.unsafe("alter table public.drafts disable trigger drafts_check_payload");
        await tx`insert into public.drafts (id, org_id, site_id, kind, payload)
          values (${id}, ${ORG_A}, ${SITE_A1}, 'sanity_draft', ${stored}::text::jsonb)`;
        await tx.unsafe("alter table public.drafts enable trigger drafts_check_payload");
      });
      const r = await decide(sql, owner, id, { kind: "approve" }, queue);
      expect(r.status).toBe("invalid-payload");
      expect(await decisionsFor(id)).toHaveLength(0);
      expect(queue.jobs.size).toBe(0);
      // The draft keeps its one decision: it can still be declined.
      expect((await decide(sql, owner, id, { kind: "decline" }, queue)).status).toBe("recorded");
    });
  });

  describe("size, characters and caps (a refusal, never a thrown database error)", () => {
    it("an edit of 17 KB is invalid-payload, not an exception; one at the cap is recorded", async () => {
      const id = await draft();
      const big = { ...PR_PAYLOAD, body: "x".repeat(17_000) };
      const r = await decide(sql, member, id, { kind: "edit", payload: big }, queue);
      expect(r).toMatchObject({ status: "invalid-payload" });
      const room = MAX_PAYLOAD_BYTES - Buffer.byteLength(jsonbText(PR_PAYLOAD));
      const exact = { ...PR_PAYLOAD, body: PR_PAYLOAD.body + "y".repeat(room) };
      const [t] = await sql`select octet_length(${sql.json(exact)}::jsonb::text) as n`;
      expect(t!.n).toBe(MAX_PAYLOAD_BYTES);
      expect((await decide(sql, member, id, { kind: "edit", payload: exact }, queue)).status).toBe(
        "recorded",
      );
    });

    it("U+0000 and an unpaired surrogate are invalid-payload, not 22P05", async () => {
      const id = await draft();
      for (const content of ["a\u0000b", "a\ud800b"]) {
        const edit = { ...PR_PAYLOAD, files: [{ path: "a.txt", content }] };
        const r = await decide(sql, member, id, { kind: "edit", payload: edit }, queue);
        expect(r.status).toBe("invalid-payload");
      }
      expect(await decisionsFor(id)).toHaveLength(0);
    });

    it("a draft names at most 50 findings (the agent's function and the table)", async () => {
      const ids = Array.from({ length: 51 }, () => randomUUID());
      expect(await agentInsert(TOKEN_A, SITE_A1, "pull_request", ids)).toMatch(
        /at most 50 findings/,
      );
      const direct = await errorOf(
        sql`insert into public.drafts (org_id, site_id, kind, payload, finding_ids)
          values (${ORG_A}, ${SITE_A1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${ids})`,
      );
      expect(direct).toMatch(/drafts_finding_ids_cap/);
    });

    it("finding_ids is a flat list: a two-dimensional array is refused", async () => {
      const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const twoD = `{{${a},${b}},{${c},${d}}}`;
      const direct = await errorOf(
        sql`insert into public.drafts (org_id, site_id, kind, payload, finding_ids)
          values (${ORG_A}, ${SITE_A1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${twoD}::uuid[])`,
      );
      expect(direct).toMatch(/drafts_finding_ids_cap/);
      const viaAgent = await asAgent(
        (tx) =>
          tx`select private.agent_insert_draft(${TOKEN_A}, ${SITE_A1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${twoD}::uuid[])`,
      );
      expect(viaAgent).not.toBe("");
      // A flat array that does not start at 1 reads back nested, so it is refused too.
      const offset = `[0:0]={${a}}`;
      const shifted = await errorOf(
        sql`insert into public.drafts (org_id, site_id, kind, payload, finding_ids)
          values (${ORG_A}, ${SITE_A1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${offset}::uuid[])`,
      );
      expect(shifted).toMatch(/drafts_finding_ids_cap/);
      const shiftedViaAgent = await asAgent(
        (tx) =>
          tx`select private.agent_insert_draft(${TOKEN_A}, ${SITE_A1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${offset}::uuid[])`,
      );
      expect(shiftedViaAgent).not.toBe("");
      // A flat list, and an empty one, are fine.
      expect(
        await errorOf(
          sql`insert into public.drafts (org_id, site_id, kind, payload, finding_ids)
            values (${ORG_A}, ${SITE_A1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, '{}'::uuid[])`,
        ),
      ).toBe("");
    });

    it("a site holds at most 200 undecided agent drafts; deciding frees room", async () => {
      await sql`insert into public.drafts (org_id, site_id, kind, payload)
        select ${ORG_A}, ${SITE_A2}, 'pull_request', ${sql.json(PR_PAYLOAD)}
        from generate_series(1, 200)`;
      const msg = await agentInsert(TOKEN_A, SITE_A2);
      expect(msg).toMatch(/already has 200 drafts waiting for a decision/);
      // Another site of the same organisation is not affected.
      expect(await agentInsert(TOKEN_A, SITE_A1)).toBe("");
      const [one] = await sql`select id from public.drafts where site_id = ${SITE_A2} limit 1`;
      await sql`insert into public.decisions (org_id, draft_id, decision, decided_by)
        values (${ORG_A}, ${one!.id}, 'declined', ${USER_A_OWNER})`;
      expect(await agentInsert(TOKEN_A, SITE_A2)).toBe("");
      expect(await agentInsert(TOKEN_A, SITE_A2)).toMatch(/200 drafts waiting/);
    });
  });

  describe("the 200-draft cap holds when many agents write at once", () => {
    /** A new site of organisation A holding 195 waiting drafts, so 30 callers race for the last 5 places. */
    async function siteNear(): Promise<string> {
      const site = randomUUID();
      await sql`insert into public.sites (id, org_id, name, url, timezone)
        values (${site}, ${ORG_A}, 'Cap Test Bakery', ${`https://cap-${site}.test`}, 'UTC')`;
      await sql`insert into public.drafts (org_id, site_id, kind, payload)
        select ${ORG_A}, ${site}, 'pull_request', ${sql.json(PR_PAYLOAD)} from generate_series(1, 195)`;
      return site;
    }
    const waiting = async (site: string) => {
      const [n] = await sql`select count(*)::int as n from public.drafts where site_id = ${site}`;
      return n!.n as number;
    };
    /**
     * 30 connections, each in its own transaction at `isolation`, each taking its snapshot (a first
     * statement) and then waiting for all the others before it calls the agent's function: the snapshot
     * is older than every other caller's insert. Returns how many calls succeeded.
     */
    async function race(
      site: string,
      isolation: string,
    ): Promise<{ ok: number; errors: string[] }> {
      const n = 30;
      const pool = postgres(db.url, { max: n, onnotice: () => {} });
      let ready = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      try {
        const results = await Promise.all(
          Array.from({ length: n }, () =>
            errorOf(
              pool.begin(`isolation level ${isolation}`, async (tx) => {
                await tx`select 1`;
                if (++ready === n) release();
                await gate;
                await tx.unsafe("set local role gaugeline_agent");
                await tx`select private.agent_insert_draft(${TOKEN_A}, ${site}, 'pull_request', ${tx.json(PR_PAYLOAD)}, '{}'::uuid[])`;
              }),
            ),
          ),
        );
        return {
          ok: results.filter((e) => e === "").length,
          errors: results.filter((e) => e !== ""),
        };
      } finally {
        await pool.end();
      }
    }

    it("READ COMMITTED: exactly the last 5 places are given", async () => {
      const site = await siteNear();
      const r = await race(site, "read committed");
      expect(r.ok).toBe(5);
      expect(await waiting(site)).toBe(200);
    });

    it("REPEATABLE READ (a snapshot older than the lock) cannot overfill a site", async () => {
      const site = await siteNear();
      const r = await race(site, "repeatable read");
      expect(await waiting(site)).toBe(195);
      expect(r.ok).toBe(0);
      expect(r.errors.every((e) => /READ COMMITTED or SERIALIZABLE/.test(e))).toBe(true);
    });

    it("SERIALIZABLE cannot overfill a site either", async () => {
      const site = await siteNear();
      await race(site, "serializable");
      expect(await waiting(site)).toBeLessThanOrEqual(200);
    });
  });

  describe("the docs example", () => {
    it("names the real lines of the functions in its error context", async () => {
      const docs = readFileSync(
        fileURLToPath(new URL("../../../../docs/hosted/inbox.md", import.meta.url)),
        "utf8",
      );
      const contexts = [
        ...docs.matchAll(/function (private\.\w+)\(.*?\) line (\d+) at ([A-Za-z ]+)/g),
      ];
      expect(contexts.length).toBeGreaterThanOrEqual(2);
      for (const [, name, line, what] of contexts) {
        const [fn] =
          await sql`select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = ${name!.replace("private.", "")}`;
        const text = (fn!.prosrc as string).split("\n")[Number(line) - 1] ?? "";
        const expected =
          what!.trim() === "RAISE" ? /raise exception/i : /insert into public\.drafts/i;
        expect(text, `${name} line ${line} at ${what}`).toMatch(expected);
      }
    });
  });

  describe("an agent login is only an agent login", () => {
    it("reports a login that can also be a signed-in person or the server", async () => {
      const tag = randomUUID().replace(/-/g, "").slice(0, 10);
      const good = `gl_agent_ok_${tag}`;
      const viaPerson = `gl_agent_auth_${tag}`;
      const viaServer = `gl_agent_srv_${tag}`;
      const indirect = `gl_agent_ind_${tag}`;
      const middle = `gl_agent_mid_${tag}`;
      try {
        await sql.unsafe(`
          create role ${good} login in role gaugeline_agent;
          create role ${viaPerson} login in role gaugeline_agent, authenticated;
          create role ${viaServer} login in role gaugeline_agent, service_role;
          create role ${middle} nologin in role authenticated;
          create role ${indirect} login in role gaugeline_agent, ${middle};`);
        const found = await agentLoginsWithOtherRoles(sql);
        expect(found).toEqual(expect.arrayContaining([viaPerson, viaServer, indirect]));
        expect(found).not.toContain(good);
        expect(found).not.toContain("gaugeline_agent");
      } finally {
        for (const r of [good, viaPerson, viaServer, indirect, middle])
          await sql.unsafe(`drop role if exists ${r}`);
      }
    });

    it("finds nothing on a database whose agent role has no members beyond its own logins", async () => {
      const found = await agentLoginsWithOtherRoles(sql);
      expect(found.filter((n) => !n.startsWith("gl_agent_"))).toEqual([]);
    });
  });
});
