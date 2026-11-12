/**
 * The drafts inbox (G37) against a real Postgres: agents draft, a person decides once, and an approval
 * enqueues exactly one apply job. Skipped without GAUGELINE_TEST_DATABASE_URL (see the db harness).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  RUN_A1,
  seed,
  SITE_A1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
} from "./harness.js";
import { decide, listWaiting, MemoryApplyQueue } from "../../inbox/inbox.js";

const PR_PAYLOAD = {
  title: "Fix the menu link",
  path: "app/menu/page.tsx",
  body: "Points /menu at /drinks.",
};

describe.skipIf(!HAS_DATABASE)("drafts inbox", () => {
  let db: TestDatabase;
  let sql: Sql;
  let queue: MemoryApplyQueue;
  const owner = { userId: USER_A_OWNER };
  const member = { userId: USER_A_MEMBER };

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(() => {
    queue = new MemoryApplyQueue();
  });

  /** A new draft as the agent would write it (inserted by the owner connection for set-up). */
  async function draft(findingIds: string[] = []): Promise<string> {
    const id = randomUUID();
    await sql`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids)
      values (${id}, ${ORG_A}, ${SITE_A1}, 'pull_request', ${sql.json(PR_PAYLOAD)}, ${findingIds})`;
    return id;
  }
  const decisionsFor = async (id: string) =>
    sql`select decision, edited_payload, decided_by from public.decisions where draft_id = ${id}`;

  /** Run `fn` as the agent role, with an agent's claims for `orgId`, then roll back. */
  async function asAgent(orgId: string, fn: (tx: Sql) => Promise<unknown>): Promise<string> {
    return errorOf(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "gaugeline_agent", org_id: orgId })}, true)`;
        await tx.unsafe("set local role gaugeline_agent");
        await fn(tx as unknown as Sql);
        throw new Error("rolled back");
      }),
    );
  }

  describe("the agent role (the database refuses, not the app)", () => {
    it("can insert a draft of a registered kind for its own organisation", async () => {
      const msg = await asAgent(
        ORG_A,
        (tx) =>
          tx`insert into public.drafts (org_id, site_id, kind, payload) values (${ORG_A}, ${SITE_A1}, 'email', '{"subject":"Hours"}')`,
      );
      expect(msg).toBe("rolled back");
    });
    it("cannot insert a draft for another organisation, in a person's name, or of another kind", async () => {
      for (const stmt of [
        `insert into public.drafts (org_id, site_id, kind, payload) values ('${ORG_B}', '${SITE_A1}', 'email', '{}')`,
        `insert into public.drafts (org_id, site_id, kind, payload) values ('${ORG_A}', '${SITE_A1}', 'record_field', '{}')`,
      ])
        expect(await asAgent(ORG_A, (tx) => tx.unsafe(stmt))).toMatch(/row-level security/);
      expect(
        await asAgent(ORG_A, (tx) =>
          tx.unsafe(`insert into public.drafts (org_id, site_id, kind, payload, created_by)
            values ('${ORG_A}', '${SITE_A1}', 'email', '{}', '${USER_A_OWNER}')`),
        ),
      ).toMatch(/permission denied/);
    });
    it("cannot insert a decision, change a draft, or read the inbox", async () => {
      const id = await draft();
      for (const stmt of [
        `insert into public.decisions (org_id, draft_id, decision, decided_by) values ('${ORG_A}', '${id}', 'approved', '${USER_A_OWNER}')`,
        `update public.drafts set payload = '{"title":"x"}' where id = '${id}'`,
        `delete from public.drafts where id = '${id}'`,
        `select * from public.drafts`,
        `select * from public.draft_state`,
        `select * from public.decisions`,
      ])
        expect(await asAgent(ORG_A, (tx) => tx.unsafe(stmt)), stmt).toMatch(/permission denied/);
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

    it("edit first: the edited payload is applied and the original draft is kept", async () => {
      const id = await draft();
      const edited = { ...PR_PAYLOAD, title: "Fix the drinks link on the menu" };
      const r = await decide(sql, member, id, { kind: "edit", payload: edited }, queue);
      expect(r.status).toBe("recorded");
      expect(queue.jobs.get(id)?.payload).toEqual(edited);
      expect((await sql`select payload from public.drafts where id = ${id}`)[0]!.payload).toEqual(
        PR_PAYLOAD,
      );
      expect((await decisionsFor(id))[0]).toMatchObject({
        decision: "edited",
        edited_payload: edited,
      });
    });

    it("decline: a decision row and no job", async () => {
      const id = await draft();
      const r = await decide(
        sql,
        owner,
        id,
        { kind: "decline", reason: "Menu is being rebuilt" },
        queue,
      );
      expect(r.status).toBe("recorded");
      expect(await decisionsFor(id)).toHaveLength(1);
      expect(queue.jobs.size).toBe(0);
    });

    it("a client viewer cannot approve: no decision, no job", async () => {
      const id = await draft();
      const r = await decide(sql, { userId: USER_A_CLIENT }, id, { kind: "approve" }, queue);
      expect(r.status).toBe("not-found");
      expect(await decisionsFor(id)).toHaveLength(0);
      expect(queue.jobs.size).toBe(0);
    });

    it("approving a draft whose finding has since closed warns first", async () => {
      const [finding] = await sql`insert into public.findings
        (org_id, site_id, run_id, check_id, severity, title, url, fingerprint)
        values (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 'broken-links', 'high', 'Broken link', 'https://tidewater-bar.test/', 'aaaaaaaaaaaaaaaa')
        returning id`;
      // A later finished run of the same site no longer has that fingerprint: the finding closed.
      await sql`insert into public.runs (org_id, site_id, started_at, finished_at, summary)
        values (${ORG_A}, ${SITE_A1}, '2026-11-11T03:00:00Z', '2026-11-11T03:01:00Z', '{}')`;
      const id = await draft([finding!.id as string]);
      const first = await decide(sql, owner, id, { kind: "approve" }, queue);
      expect(first).toEqual({ status: "confirm-closed-findings", closedFindingIds: [finding!.id] });
      expect(await decisionsFor(id)).toHaveLength(0);
      const second = await decide(sql, owner, id, { kind: "approve" }, queue, {
        confirmClosed: true,
      });
      expect(second.status).toBe("recorded");
      expect(queue.jobs.size).toBe(1);
    });

    it("refuses an edited payload that is not an object", async () => {
      const id = await draft();
      const bad = { kind: "edit", payload: ["x"] } as unknown as Parameters<typeof decide>[3];
      expect(await errorOf(decide(sql, owner, id, bad, queue))).toMatch(/object/);
      expect(await decisionsFor(id)).toHaveLength(0);
    });
  });
});
