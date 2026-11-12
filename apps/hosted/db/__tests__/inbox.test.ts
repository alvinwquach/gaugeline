/**
 * The drafts inbox (G37) against a real Postgres: agents draft, a person decides once, and an approval
 * enqueues exactly one apply job carrying the hash of what was approved. Skipped without
 * GAUGELINE_TEST_DATABASE_URL (see the db harness).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
} from "./harness.js";
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
    for (const [org, t, revoked] of [
      [ORG_A, TOKEN_A, false],
      [ORG_B, TOKEN_B, false],
      [ORG_A, TOKEN_REVOKED, true],
    ] as const)
      await sql`insert into private.agent_tokens (org_id, token_sha256, revoked_at)
        values (${org}, sha256(convert_to(${t}, 'UTF8')), ${revoked ? new Date() : null})`;
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
      expect(await agentInsert(TOKEN_A, SITE_A1, "shell_exec")).toMatch(/drafts_kind_check/);
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
        `select * from private.agent_tokens`,
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
      // The writer refuses a job for any site but its configured target's, so the job names the site.
      expect(job.siteId).toBe(SITE_A1);
      expect(verifyApplyJob(job)).toEqual(PR_PAYLOAD);
    });

    it("a job whose payload differs from the approved one is refused", () => {
      const payloadText = JSON.stringify(PR_PAYLOAD);
      const job = {
        orgId: ORG_A,
        siteId: SITE_A1,
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

    it("a draft whose own payload is not its kind's shape cannot be approved, only declined", async () => {
      const id = await draft([], { title: "x", body: "y", files: [], branch: "main" });
      expect((await decide(sql, owner, id, { kind: "approve" }, queue)).status).toBe(
        "invalid-payload",
      );
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
});
