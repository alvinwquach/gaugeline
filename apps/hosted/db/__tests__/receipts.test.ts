/**
 * Approval receipts (AG-06) against a real Postgres, through REAL login roles: a signed-in person's login
 * (a member of `authenticated` only), the server's (`service_role`), the agent's and the worker's. Every
 * claim: a choice in the inbox writes one receipt in its own transaction; the chain is per organisation,
 * append-only, readable by owners and admins only; two choices at once chain without a fork; and an export
 * verifies offline with core's verifier, the same code `gaugeline receipts verify` runs.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPROVAL_RECEIPT_GENESIS,
  approvalReceiptLine,
  buildApprovalReceipt,
  sha256Hex,
  verifyApprovalReceipts,
  type ApprovalReceiptInput,
} from "@gaugeline/core";
import { exportReceipts, ReceiptsExportRefused } from "../../lib/web/receipts.js";
import {
  DRAFT_A1,
  DRAFT_B1,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  SITE_A2,
  seed,
  TEST_DATABASE_URL,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
  USER_BOTH,
  type Sql,
  type TestDatabase,
} from "./harness.js";

const tag = randomBytes(4).toString("hex");
const LOGINS = {
  person: `gl_rcpt_person_${tag}`,
  server: `gl_rcpt_server_${tag}`,
  agent: `gl_rcpt_agent_${tag}`,
  worker: `gl_rcpt_worker_${tag}`,
} as const;
const PASSWORD = "receipts-test-login";

class Rollback extends Error {}

/** Invented drafts for the pop-up kitchen (rule 12). */
const draftId = (n: number) => `a2d1${String(n).padStart(4, "0")}-0000-4000-8000-0000000000a2`;
const EMAIL = (n: number) => ({ subject: `Weekend menu ${n}`, body: "The new menu is up." });

describe.skipIf(!HAS_DATABASE)("approval receipts", () => {
  let db: TestDatabase;
  let owner: Sql;
  const conn = {} as Record<keyof typeof LOGINS, Sql>;

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
      create role ${LOGINS.person} login noinherit password '${PASSWORD}' in role authenticated;
      create role ${LOGINS.server} login noinherit password '${PASSWORD}' in role service_role;
      create role ${LOGINS.agent} login noinherit password '${PASSWORD}' in role gaugeline_agent;
      create role ${LOGINS.worker} login noinherit password '${PASSWORD}' in role gaugeline_worker;`);
    for (const k of Object.keys(LOGINS) as (keyof typeof LOGINS)[])
      conn[k] = postgres(loginUrl(LOGINS[k]), { max: 4, onnotice: () => {} });
    // Drafts for the tests below, as the server (the owner here) would write them.
    for (let n = 1; n <= 8; n++)
      await owner`insert into public.drafts (id, org_id, site_id, kind, payload)
        values (${draftId(n)}, ${ORG_A}, ${SITE_A2}, 'email', ${owner.json(EMAIL(n))})`;
  });
  afterAll(async () => {
    for (const c of Object.values(conn)) await c?.end();
    await db?.drop();
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(
      Object.values(LOGINS)
        .map((r) => `drop role if exists ${r};`)
        .join(" "),
    );
    await admin.end();
  });

  /** On `login`, as `role` with claims for `userId`; rolled back unless `commit`. */
  async function on<T>(
    login: keyof typeof LOGINS,
    role: string,
    userId: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    commit = false,
  ): Promise<T> {
    let out: T | undefined;
    try {
      await conn[login].begin(async (tx) => {
        const claims = JSON.stringify(userId ? { role, sub: userId } : { role });
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx.unsafe(`set local role ${role}`);
        out = await fn(tx);
        if (!commit) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return out as T;
  }
  const person = <T>(
    userId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    commit = false,
  ) => on("person", "authenticated", userId, fn, commit);
  const decide = (
    tx: postgres.TransactionSql,
    org: string,
    draft: string,
    decision: string,
    by: string,
    edited?: object,
  ) =>
    tx`insert into public.decisions (org_id, draft_id, decision, edited_payload, decided_by)
       values (${org}, ${draft}, ${decision}, ${edited ? tx.json(edited as never) : null}, ${by})
       on conflict (draft_id) where decision in ('approved', 'edited', 'declined') do nothing
       returning id`;
  const chainOf = async (org: string) =>
    (await owner`select record from public.receipts where org_id = ${org} order by seq`)
      .map((r) => `${r.record as string}\n`)
      .join("");

  describe("the SQL writes the same canonical text as core", () => {
    const cases: (ApprovalReceiptInput & { seq: number; prev: string; at: string })[] = [
      {
        org: ORG_A,
        draft: DRAFT_A1,
        decisionId: "1",
        kind: "email",
        decision: "approved",
        payloadSha256: sha256Hex("x"),
        approver: { member: USER_A_OWNER, role: "owner" },
        seq: 1,
        prev: APPROVAL_RECEIPT_GENESIS,
        at: "2026-11-02T09:15:04.218734Z",
      },
      {
        org: ORG_B,
        draft: DRAFT_B1,
        decisionId: "9007199254740993",
        kind: "pull_request",
        decision: "declined",
        payloadSha256: sha256Hex("y"),
        approver: { member: USER_BOTH, role: null },
        seq: 42,
        prev: sha256Hex("z"),
        at: "2026-12-31T23:59:59.999999Z",
      },
      {
        org: ORG_A,
        draft: draftId(1),
        decisionId: "77",
        kind: "sanity_draft",
        decision: "edited",
        payloadSha256: sha256Hex("w"),
        approver: { member: USER_A_MEMBER, role: "member" },
        seq: 3,
        prev: sha256Hex("v"),
        at: "2026-02-27T00:00:00.000000Z",
      },
    ];
    for (const c of cases)
      it(`${c.decision}, role ${String(c.approver.role)}, at ${c.at}`, async () => {
        const { seq, prev, at, ...input } = c;
        const prior =
          seq === 1 ? null : { ...buildApprovalReceipt(input, null), seq: seq - 1, hash: prev };
        const expected = buildApprovalReceipt({ ...input, decidedAt: at }, prior);
        // As text: the driver would turn a timestamptz parameter into a Date and drop the microseconds.
        const args = [
          c.org,
          seq,
          c.draft,
          c.decisionId,
          c.kind,
          c.decision,
          c.payloadSha256,
          c.approver.member,
          c.approver.role,
          at,
          prev,
        ] as const;
        const [body] =
          await owner`select private.receipt_text(${args[0]}, ${args[1]}, ${args[2]}, ${args[3]},
          ${args[4]}, ${args[5]}, ${args[6]}, ${args[7]}, ${args[8]}, ${args[9]}::text::timestamptz, ${args[10]}, null) as t`;
        expect(body!.t).toBe(
          approvalReceiptLine(expected).replace(`,"hash":"${expected.hash}"`, ""),
        );
        expect(sha256Hex(body!.t as string)).toBe(expected.hash);
        const [line] =
          await owner`select private.receipt_text(${args[0]}, ${args[1]}, ${args[2]}, ${args[3]},
          ${args[4]}, ${args[5]}, ${args[6]}, ${args[7]}, ${args[8]}, ${args[9]}::text::timestamptz, ${args[10]}, ${expected.hash}) as t`;
        expect(line!.t).toBe(approvalReceiptLine(expected));
      });
  });

  describe("a choice in the inbox writes one receipt, in the same transaction", () => {
    it("the seed's approval and decline each have a receipt that starts its organisation's chain", async () => {
      for (const org of [ORG_A, ORG_B]) {
        const v = verifyApprovalReceipts(await chainOf(org));
        expect(v).toMatchObject({ ok: true, receipts: 1, org });
      }
    });

    it("an approval: the approver, their role, the database's payload hash and a 72-hour expiry", async () => {
      const id = await person(
        USER_A_MEMBER,
        async (tx) => {
          const [d] = await decide(tx, ORG_A, draftId(1), "approved", USER_A_MEMBER);
          // A member cannot read receipts, not even the one their own choice just wrote.
          expect(await tx`select * from public.receipts`).toEqual([]);
          return d!.id as string;
        },
        true,
      );
      const [rec] = await owner`select r.record, x.payload_sha256 from public.receipts r
        join public.decisions x on x.id = r.decision_id where r.decision_id = ${id}`;
      const parsed = JSON.parse(rec!.record as string) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        decision: "approved",
        decisionId: String(id),
        draft: draftId(1),
        approver: { member: USER_A_MEMBER, role: "member" },
        payloadSha256: rec!.payload_sha256,
        seq: 2,
      });
      const decided = Date.parse(`${(parsed.decidedAt as string).slice(0, 23)}Z`);
      expect(Date.parse(`${(parsed.expiresAt as string).slice(0, 23)}Z`) - decided).toBe(
        72 * 3_600_000,
      );
      expect(rec!.record).not.toContain("Weekend menu");
    });

    it("a decline: the hash of the draft's payload as the database prints it, and no expiry", async () => {
      const id = await person(
        USER_A_OWNER,
        async (tx) => (await decide(tx, ORG_A, draftId(2), "declined", USER_A_OWNER))[0]!.id,
        true,
      );
      const [rec] = await owner`select r.record, d.payload::text as p from public.receipts r
        join public.drafts d on d.id = r.draft_id where r.decision_id = ${id}`;
      const parsed = JSON.parse(rec!.record as string) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        decision: "declined",
        expiresAt: null,
        approver: { role: "owner" },
      });
      expect(parsed.payloadSha256).toBe(sha256Hex(rec!.p as string));
    });

    it("an edit: the hash of the edited payload, not the draft's", async () => {
      const edited = { subject: "Weekend menu, edited", body: "The new menu is up today." };
      const id = await person(
        USER_A_OWNER,
        async (tx) => (await decide(tx, ORG_A, draftId(3), "edited", USER_A_OWNER, edited))[0]!.id,
        true,
      );
      const [rec] =
        await owner`select r.record, x.payload_sha256, x.edited_payload::text as e from public.receipts r
        join public.decisions x on x.id = r.decision_id where r.decision_id = ${id}`;
      expect(JSON.parse(rec!.record as string)).toMatchObject({
        decision: "edited",
        payloadSha256: rec!.payload_sha256,
      });
      expect(rec!.payload_sha256).toBe(sha256Hex(rec!.e as string));
    });

    it("a double click writes one decision and one receipt", async () => {
      const ids = await person(
        USER_A_OWNER,
        async (tx) => [
          ...(await decide(tx, ORG_A, draftId(4), "approved", USER_A_OWNER)),
          ...(await decide(tx, ORG_A, draftId(4), "approved", USER_A_OWNER)),
        ],
        true,
      );
      expect(ids).toHaveLength(1);
      expect(
        await owner`select id from public.receipts where draft_id = ${draftId(4)}`,
      ).toHaveLength(1);
    });

    it("an outcome row the worker appends later (not a person's choice) writes no receipt", async () => {
      const outcomes = await owner`select pg_get_constraintdef(oid) as d from pg_constraint
        where conrelid = 'public.decisions'::regclass and conname = 'decisions_decision_check'`;
      // Today the table holds only choices; the trigger's WHEN clause names them, so a later outcome kind is skipped.
      expect(outcomes[0]!.d).toMatch(/approved.*edited.*declined/);
      const [t] =
        await owner`select pg_get_triggerdef(oid) as d from pg_trigger where tgname = 'decisions_write_receipt'`;
      expect(t!.d).toMatch(/AFTER INSERT .* WHEN .*approved.*edited.*declined/);
    });

    it("a decision that cannot get a receipt is not recorded either (one transaction)", async () => {
      await owner
        .begin(async (tx) => {
          await tx`alter table public.receipts add constraint fail_now check (seq < 0) not valid`;
          const e = await errorOf(
            tx.savepoint((sp) => decide(sp, ORG_A, draftId(5), "approved", USER_A_OWNER)),
          );
          expect(e).toMatch(/fail_now/);
          expect(await tx`select id from public.decisions where draft_id = ${draftId(5)}`).toEqual(
            [],
          );
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
    });
  });

  describe("two choices at the same moment chain without a fork", () => {
    it("both receipts are present, consecutive, and the chain verifies", async () => {
      const count = async () =>
        Number(
          (await owner`select count(*)::int as n from public.receipts where org_id = ${ORG_A}`)[0]!
            .n,
        );
      const before = await count();
      // The person's decision is written first and its transaction stays open; only then does the server's
      // start, and the person's commits once the server's is seen waiting on a lock (polled from the owner's
      // connection, no sleep and no iteration cap: the test's own timeout catches a hang). If the server's
      // finished without waiting, the head was not locked, and the check below fails.
      let decided: () => void = () => {};
      const personDecided = new Promise<void>((r) => (decided = r));
      let serverDone = false;
      const a = conn.person.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: USER_A_OWNER })}, true)`;
        await tx.unsafe("set local role authenticated");
        await decide(tx, ORG_A, draftId(6), "approved", USER_A_OWNER);
        decided();
        for (;;) {
          const [w] = await owner`select count(*)::int as n from pg_stat_activity
            where usename = ${LOGINS.server} and wait_event_type = 'Lock'`;
          if (Number(w!.n) > 0 || serverDone) break;
        }
        expect(serverDone, "the second decision finished while the first held the head").toBe(
          false,
        );
      });
      await personDecided;
      const b = conn.server
        .begin(async (tx) => {
          await tx.unsafe("set local role service_role");
          await decide(tx, ORG_A, draftId(7), "declined", USER_BOTH);
        })
        .finally(() => {
          serverDone = true;
        });
      await Promise.all([a, b]);
      const rows =
        await owner`select seq, prev, hash, draft_id from public.receipts where org_id = ${ORG_A} order by seq`;
      expect(rows).toHaveLength(before + 2);
      expect(new Set(rows.map((r) => r.prev)).size).toBe(rows.length);
      expect(rows.slice(-2).map((r) => r.draft_id)).toEqual([draftId(6), draftId(7)]);
      expect(verifyApprovalReceipts(await chainOf(ORG_A))).toMatchObject({
        ok: true,
        receipts: before + 2,
      });
      const [head] =
        await owner`select seq, hash from private.receipt_heads where org_id = ${ORG_A}`;
      expect(Number(head!.seq)).toBe(before + 2);
      expect(head!.hash).toBe(rows.at(-1)!.hash);
    });
  });

  describe("append-only, and nobody writes a receipt directly", () => {
    const writes = [
      "update public.receipts set seq = seq + 100",
      "delete from public.receipts",
      "truncate public.receipts",
      `insert into public.receipts (org_id, seq, decision_id, draft_id, prev, hash, record)
         values ('${ORG_A}', 999, 1, '${DRAFT_A1}', '${"0".repeat(64)}', '${"1".repeat(64)}', '{}')`,
    ];
    for (const [login, role, user] of [
      ["person", "authenticated", USER_A_OWNER],
      ["server", "service_role", null],
      ["agent", "gaugeline_agent", null],
      ["worker", "gaugeline_worker", null],
    ] as const)
      it(`${role} can neither change, remove nor add a receipt`, async () => {
        for (const w of writes)
          expect(
            await errorOf(on(login, role, user, (tx) => tx.unsafe(w))),
            `${role}: ${w}`,
          ).toMatch(/permission denied/);
      });

    it("even the table owner is refused an update, a delete or a truncate", async () => {
      for (const w of writes.slice(0, 3))
        expect(await errorOf(owner.begin((tx) => tx.unsafe(w))), w).toMatch(/append-only/);
    });

    it("the table itself refuses a fork, a second receipt at one position and a second for one draft", async () => {
      const [first] =
        await owner`select org_id, seq, prev, draft_id, decision_id from public.receipts
        where org_id = ${ORG_B} order by seq limit 1`;
      const row = (change: Record<string, unknown>) => {
        const r = {
          seq: 900,
          prev: "e".repeat(64),
          draft: draftId(9),
          decision: 1_000_000,
          ...change,
        };
        return owner.begin(
          (
            tx,
          ) => tx`insert into public.receipts (org_id, seq, decision_id, draft_id, prev, hash, record)
          values (${ORG_B}, ${r.seq as number}, ${r.decision as number}, ${r.draft as string}, ${r.prev as string},
            ${"f".repeat(64)}, '{}')`,
        );
      };
      expect(await errorOf(row({ seq: first!.seq }))).toMatch(/receipts_org_id_seq_key/);
      expect(await errorOf(row({ prev: first!.prev }))).toMatch(/receipts_org_id_prev_key/);
      expect(await errorOf(row({ draft: first!.draft_id }))).toMatch(
        /receipts_org_id_draft_id_key/,
      );
      expect(await errorOf(row({ decision: first!.decision_id }))).toMatch(
        /receipts_decision_id_key/,
      );
    });

    it("the chain head is private: no role reads or writes it", async () => {
      for (const [login, role, user] of [
        ["person", "authenticated", USER_A_OWNER],
        ["server", "service_role", null],
        ["agent", "gaugeline_agent", null],
        ["worker", "gaugeline_worker", null],
      ] as const) {
        expect(
          await errorOf(on(login, role, user, (tx) => tx`select * from private.receipt_heads`)),
        ).toMatch(/permission denied/);
        expect(
          await errorOf(
            on(
              login,
              role,
              user,
              (tx) =>
                tx`select private.receipt_text(null, 1, null, 1, 'email', 'approved', null, null, null, now(), null, null)`,
            ),
          ),
        ).toMatch(/permission denied/);
      }
    });
  });

  describe("who reads the chain (row-level security)", () => {
    const visible = (userId: string) =>
      person(userId, async (tx) =>
        [
          ...new Set((await tx`select org_id from public.receipts`).map((r) => r.org_id as string)),
        ].sort(),
      );

    it("an owner reads their own organisation's chain only", async () => {
      expect(await visible(USER_A_OWNER)).toEqual([ORG_A]);
      expect(await visible(USER_B_OWNER)).toEqual([ORG_B]);
    });
    it("an admin of one organisation and member of another reads only the first", async () => {
      expect(await visible(USER_BOTH)).toEqual([ORG_B]);
    });
    it("a member and a client viewer read nothing", async () => {
      expect(await visible(USER_A_MEMBER)).toEqual([]);
      expect(await visible(USER_A_CLIENT)).toEqual([]);
    });
    it("anon, the server, the agent and the worker read nothing", async () => {
      expect(
        await errorOf(on("person", "anon", null, (tx) => tx`select * from public.receipts`)),
      ).toMatch(/permission denied/);
      for (const [login, role] of [
        ["server", "service_role"],
        ["agent", "gaugeline_agent"],
        ["worker", "gaugeline_worker"],
      ] as const)
        expect(
          await errorOf(on(login, role, null, (tx) => tx`select * from public.receipts`)),
          role,
        ).toMatch(/permission denied/);
    });
  });

  describe("the export (JSON lines) and the offline check", () => {
    const exportAs = (userId: string, org: string) =>
      person(userId, (tx) => exportReceipts(tx, org));

    it("an owner's export verifies offline with core's verifier", async () => {
      const text = await exportAs(USER_A_OWNER, ORG_A);
      expect(text).toBe(await chainOf(ORG_A));
      expect(verifyApprovalReceipts(text)).toMatchObject({ ok: true, org: ORG_A });
      expect(verifyApprovalReceipts(await exportAs(USER_BOTH, ORG_B))).toMatchObject({
        ok: true,
        org: ORG_B,
      });
    });

    it("a member, a client viewer and another organisation's owner are refused, not handed an empty chain", async () => {
      for (const [user, org] of [
        [USER_A_MEMBER, ORG_A],
        [USER_A_CLIENT, ORG_A],
        [USER_B_OWNER, ORG_A],
        [USER_BOTH, ORG_A],
      ] as const)
        expect(await errorOf(exportAs(user, org)), `${user} ${org}`).toBe(
          new ReceiptsExportRefused().message,
        );
    });

    it("a changed, removed or reordered line in the export fails the check", async () => {
      const lines = (await exportAs(USER_A_OWNER, ORG_A)).trimEnd().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const join = (ls: string[]) => `${ls.join("\n")}\n`;
      const changed = [...lines];
      changed[1] = changed[1]!
        .replace('"decision":"approved"', '"decision":"edited"')
        .replace('"decision":"declined"', '"decision":"approved"');
      expect(verifyApprovalReceipts(join(changed)).problem).toMatchObject({ index: 1 });
      expect(verifyApprovalReceipts(join([lines[0]!, ...lines.slice(2)])).problem).toMatchObject({
        index: 1,
        check: "sequence",
      });
      expect(
        verifyApprovalReceipts(join([lines[0]!, lines[2]!, lines[1]!, ...lines.slice(3)])).problem,
      ).toMatchObject({ index: 1, check: "sequence" });
    });

    it("a receipt rewritten in the database by its owner (triggers off) is found by the next export's check", async () => {
      await owner
        .begin(async (tx) => {
          await tx`alter table public.receipts disable trigger receipts_append_only`;
          await tx`update public.receipts set record = replace(record, '"role":"owner"', '"role":"admin"')
          where org_id = ${ORG_A} and seq = 1`;
          await tx`alter table public.receipts enable trigger receipts_append_only`;
          const text = (
            await tx`select record from public.receipts where org_id = ${ORG_A} order by seq`
          )
            .map((r) => `${r.record as string}\n`)
            .join("");
          expect(verifyApprovalReceipts(text).problem).toMatchObject({ index: 0, check: "hash" });
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
    });
  });
});
