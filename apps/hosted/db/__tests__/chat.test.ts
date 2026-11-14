/**
 * Approve in chat (X69, part 1): the database side and the decision core, against a real Postgres. The
 * chat endpoint's own login (a member of gaugeline_chat and authenticated) runs everything the endpoint
 * does; the owner connection only sets things up. Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chatLoginsWithOtherRoles,
  connectionSkipsRls,
  definerFunctionsWithoutEmptySearchPath,
  privateFunctionsExecutableBy,
  tablesWithoutRls,
} from "../audit.js";
import { decideFromChat, PROPOSAL_EXPIRY_MS, type ChatAction } from "../../chat/decide.js";
import { authenticate, type ReceiveDeps } from "../../chat/receive.js";
import { sqlChatStore, type ChatStore } from "../../chat/store.js";
import { slackVerifier } from "../../chat/verify.js";
import { MemoryApplyQueue } from "../../inbox/inbox.js";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  RUN_A1,
  seed,
  SITE_A1,
  SITE_B1,
  type Sql,
  TEST_DATABASE_URL,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_BOTH,
} from "./harness.js";

// Invented secrets, built at run time so no key-shaped string sits in the source (rule 12).
const SECRET_A = ["sig", "northgate", randomBytes(12).toString("hex")].join("-");
const SECRET_B = ["sig", "brightfield", randomBytes(12).toString("hex")].join("-");
const WEBHOOK = ["https://hooks.slack.test/services", "T0NORTHGATE", "B0TIDEWATER", "marker"].join(
  "/",
);
const CONN_A = "c1000000-0000-4000-8000-0000000000a1"; // Northgate's Slack
const CONN_A_DISCORD = "c1000000-0000-4000-8000-0000000000a2";
const CONN_A_HOOK = "c1000000-0000-4000-8000-0000000000a3"; // points at a webhook URL, not a signing secret
const CONN_B = "c1000000-0000-4000-8000-0000000000b1"; // Brightfield's Slack
const CONN_OFF = "c1000000-0000-4000-8000-0000000000a4"; // disabled
const LOGIN = `gl_chat_login_${randomBytes(4).toString("hex")}`;
const TEAM = "T0NORTHGATE";
// The database decides expiry by its own clock, so the tests age drafts from the real one.
const NOW = new Date();
const nowSeconds = Math.floor(NOW.getTime() / 1000);

/** The signature Slack would send for a raw body. */
const sign = (secret: string, body: string, ts: number) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

describe.skipIf(!HAS_DATABASE)("chat approvals: database and decision core", () => {
  let db: TestDatabase;
  let owner: Sql; // the migration owner: set-up only
  let chat: Sql; // the chat endpoint's own login
  let store: ChatStore;
  const queue = new MemoryApplyQueue();

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    await owner.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`select private.put_secret(${ORG_A}, 'chat-slack', 'signing_secret', ${SECRET_A})`;
      await tx`select private.put_secret(${ORG_B}, 'chat-slack', 'signing_secret', ${SECRET_B})`;
      await tx`select private.put_secret(${ORG_A}, 'hook', 'webhook_url', ${WEBHOOK})`;
    });
    await owner.unsafe(`
      insert into public.chat_connections (id, org_id, provider, label, workspace_ref, secret_name, status) values
        ('${CONN_A}', '${ORG_A}', 'slack', 'Northgate Slack', '${TEAM}', 'chat-slack', 'active'),
        ('${CONN_A_DISCORD}', '${ORG_A}', 'discord', 'Northgate Discord', null, 'chat-slack', 'active'),
        ('${CONN_A_HOOK}', '${ORG_A}', 'slack', 'Wrong secret kind', null, 'hook', 'active'),
        ('${CONN_OFF}', '${ORG_A}', 'slack', 'Switched off', null, 'chat-slack', 'disabled'),
        ('${CONN_B}', '${ORG_B}', 'slack', 'Brightfield Slack', null, 'chat-slack', 'active');
      insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id, confirmed_at) values
        ('${ORG_A}', '${CONN_A}', 'U0OWNER', '${USER_A_OWNER}', now()),
        ('${ORG_A}', '${CONN_A}', 'U0MEMBER', '${USER_A_MEMBER}', now()),
        ('${ORG_A}', '${CONN_A}', 'U0CLIENT', '${USER_A_CLIENT}', now()),
        ('${ORG_A}', '${CONN_A}', 'U0BOTH', '${USER_BOTH}', now());
    `);
    // The chat endpoint's login: a member of gaugeline_chat and nothing else (not `authenticated`).
    await owner.unsafe(`create role ${LOGIN} login noinherit password 'chat-test-login'`);
    await owner.unsafe(`grant gaugeline_chat to ${LOGIN}`);
    const u = new URL(db.url);
    u.username = LOGIN;
    u.password = "chat-test-login";
    chat = postgres(u.href, { max: 4, onnotice: () => {} });
    store = sqlChatStore(chat);
  });
  afterAll(async () => {
    await chat?.end();
    await db?.drop();
    // A role belongs to the server, not to the database, so it outlives the database dropped above.
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop role if exists ${LOGIN}`);
    await admin.end();
  });

  async function draft(org = ORG_A, site = SITE_A1, ageMs = 0): Promise<string> {
    const id = randomUUID();
    const at = new Date(NOW.getTime() - ageMs);
    await owner`insert into public.drafts (id, org_id, site_id, kind, payload, created_at)
      values (${id}, ${org}, ${site}, 'email',
        ${owner.json({ subject: "Your menu link is fixed", body: "The drinks page is back." })}, ${at})`;
    return id;
  }
  const rows = (id: string) =>
    owner`select decision, decided_by from public.decisions where draft_id = ${id} order by id`;
  const act = (over: Partial<ChatAction> & { draftId: string }): ChatAction => ({
    chatUserId: "U0MEMBER",
    workspace: TEAM,
    choice: "approve",
    ...over,
  });
  const connection = async (id = CONN_A) => (await store.connection(id))!;
  const decideDeps = () => ({ sql: chat, queue });

  describe("the chat endpoint's role", () => {
    it("can run exactly four functions, reads no table, and is not a path to the server", async () => {
      expect(await privateFunctionsExecutableBy(owner, "gaugeline_chat")).toEqual([
        "chat_claim_request",
        "chat_connection",
        "chat_decide",
        "chat_signing_secret",
      ]);
      for (const role of [
        "anon",
        "authenticated",
        "service_role",
        "gaugeline_agent",
        "gaugeline_worker",
      ]) {
        const callable = await privateFunctionsExecutableBy(owner, role);
        expect(
          callable.filter((f) => f.startsWith("chat_")),
          role,
        ).toEqual([]);
      }
      expect(await chatLoginsWithOtherRoles(owner)).toEqual([]);
      // The deploy check flags a login that can also be a signed-in person, the server, the worker or the agent.
      const names: string[] = [];
      try {
        for (const other of [
          "authenticated",
          "anon",
          "service_role",
          "gaugeline_worker",
          "gaugeline_agent",
        ]) {
          const name = `gl_chat_extra_${randomBytes(3).toString("hex")}`;
          names.push(name);
          await owner.unsafe(
            `create role ${name} login; grant gaugeline_chat, ${other} to ${name}`,
          );
          expect(await chatLoginsWithOtherRoles(owner), other).toEqual([name]);
          await owner.unsafe(`drop role ${name}`);
          names.pop();
        }
      } finally {
        for (const n of names) await owner.unsafe(`drop role if exists ${n}`);
      }
      expect(await connectionSkipsRls(chat)).toBe(false);
      expect(await tablesWithoutRls(owner, "private")).toEqual(["schema_migrations"]);
      expect(await tablesWithoutRls(owner)).toEqual([]);
      expect(await definerFunctionsWithoutEmptySearchPath(owner)).toEqual([]);
    });

    it("cannot select a table, a Vault row or a secret, even by name", async () => {
      const denied = (q: string) =>
        errorOf(
          chat.begin(async (tx) => {
            await tx.unsafe("set local role gaugeline_chat");
            await tx.unsafe(q);
          }),
        );
      for (const q of [
        "select * from public.drafts",
        "select * from public.chat_connections",
        "select * from public.chat_identities",
        "select * from private.chat_requests",
        "select * from private.secret_refs",
        "select * from vault.decrypted_secrets",
        "select private.get_secret('0a000000-0000-4000-8000-00000000000a', 'chat-slack')",
        "insert into public.decisions (org_id, draft_id, decision, decided_by) values (gen_random_uuid(), gen_random_uuid(), 'approved', gen_random_uuid())",
      ])
        expect(await denied(q), q).toMatch(/permission denied/);
    });

    it("signed-in people, the API and the agent cannot call its functions or read its tables", async () => {
      const calls = [
        `select private.chat_signing_secret('${CONN_A}')`,
        `select private.chat_claim_request('${CONN_A}', 'aaaaaaaaaaaa')`,
        `select private.chat_decide('${CONN_A}', 'U0OWNER', '${randomUUID()}', 'approve')`,
        `select * from private.chat_requests`,
      ];
      for (const role of [
        "anon",
        "authenticated",
        "service_role",
        "gaugeline_agent",
        "gaugeline_worker",
      ] as const)
        for (const q of calls)
          expect(
            await errorOf(as(owner, { role, userId: USER_A_OWNER }, (tx) => tx.unsafe(q))),
            `${role}: ${q}`,
          ).toMatch(/permission denied/);
    });

    it("an owner or admin reads their connections and links; a member and a client see none; no value anywhere", async () => {
      const seen = (userId: string) =>
        as(owner, { role: "authenticated", userId }, async (tx) => ({
          connections: await tx`select id, secret_name from public.chat_connections`,
          identities: await tx`select chat_user_id from public.chat_identities`,
        }));
      const o = await seen(USER_A_OWNER);
      expect(o.connections.map((r) => r.id).sort()).toEqual([
        CONN_A,
        CONN_A_DISCORD,
        CONN_A_HOOK,
        CONN_OFF,
      ]);
      expect(o.identities).toHaveLength(4);
      // A member or client sees no connection, and only their own links (to confirm or remove them).
      for (const [u, own] of [
        [USER_A_MEMBER, "U0MEMBER"],
        [USER_A_CLIENT, "U0CLIENT"],
      ] as const) {
        const s = await seen(u);
        expect(s.connections).toEqual([]);
        expect(s.identities).toEqual([{ chat_user_id: own }]);
      }
      // Only an owner or admin may link, and only inside their own organisation.
      const link = (userId: string, org: string, conn: string, user: string) =>
        errorOf(
          as(
            owner,
            { role: "authenticated", userId },
            (tx) =>
              tx`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id) values (${org}, ${conn}, 'U0NEW', ${user})`,
          ),
        );
      expect(await link(USER_A_MEMBER, ORG_A, CONN_A, USER_A_MEMBER)).toMatch(/row-level security/);
      expect(await link(USER_A_OWNER, ORG_A, CONN_B, USER_A_MEMBER)).toMatch(
        /row-level security|foreign key/,
      );
      expect(await link(USER_A_OWNER, ORG_B, CONN_B, USER_A_MEMBER)).toMatch(/row-level security/);
      expect(await link(USER_A_OWNER, ORG_A, CONN_A, USER_A_MEMBER)).toBe("");
    });

    it("a link to someone who is not a member of the organisation is refused", async () => {
      const msg = await errorOf(
        owner`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id)
          values (${ORG_A}, ${CONN_A}, 'U0STRANGER', ${randomUUID()})`,
      );
      expect(msg).toMatch(/foreign key/);
    });
  });

  describe("the store", () => {
    it("names a connection by its id: organisation, provider and workspace", async () => {
      expect(await store.connection(CONN_A)).toEqual({
        id: CONN_A,
        orgId: ORG_A,
        provider: "slack",
        workspaceRef: TEAM,
      });
      expect((await store.connection(CONN_B))?.orgId).toBe(ORG_B);
    });

    it("knows nothing of a disabled connection, an unknown id or text that is not an id", async () => {
      for (const id of [CONN_OFF, randomUUID(), "not-a-uuid", "", "' or 1=1 --"]) {
        expect(await store.connection(id), id).toBeUndefined();
        expect(await store.signingSecret(id), id).toBeUndefined();
        expect(await store.claim(id, "k".repeat(12)), id).toBe(false);
      }
    });

    it("returns each connection's own signing secret, and no webhook URL", async () => {
      expect(await store.signingSecret(CONN_A)).toBe(SECRET_A);
      expect(await store.signingSecret(CONN_B)).toBe(SECRET_B);
      // CONN_A_HOOK's secret is a webhook URL: not a signing secret, so it is not handed out.
      expect(await store.signingSecret(CONN_A_HOOK)).toBeUndefined();
    });

    it("claims a request key once per connection", async () => {
      const key = randomBytes(16).toString("hex");
      expect(await store.claim(CONN_A, key)).toBe(true);
      expect(await store.claim(CONN_A, key)).toBe(false);
      expect(await store.claim(CONN_B, key)).toBe(true); // keys are per connection
      expect(await store.claim(CONN_OFF, key)).toBe(false);
    });

    it("forgets keys older than a day when the next one is claimed", async () => {
      const old = randomBytes(16).toString("hex");
      expect(await store.claim(CONN_A, old)).toBe(true);
      await owner`update private.chat_requests set received_at = now() - interval '25 hours' where request_key = ${old}`;
      expect(await store.claim(CONN_A, randomBytes(16).toString("hex"))).toBe(true);
      expect(
        await owner`select 1 from private.chat_requests where request_key = ${old}`,
      ).toHaveLength(0);
    });

    it("deleting the secret deletes the connection (it never outlives the key)", async () => {
      await owner.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        await tx`select private.put_secret(${ORG_B}, 'temp', 'signing_secret', 'temporary-secret-value')`;
      });
      const id = randomUUID();
      await owner`insert into public.chat_connections (id, org_id, provider, label, secret_name) values (${id}, ${ORG_B}, 'slack', 'temp', 'temp')`;
      expect(await store.signingSecret(id)).toBe("temporary-secret-value");
      await owner.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        await tx`select private.delete_secret(${ORG_B}, 'temp')`;
      });
      expect(await store.connection(id)).toBeUndefined();
    });
  });

  describe("authenticate: the checks before the body is parsed", () => {
    const body = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions" }));
    const deps = (): ReceiveDeps => ({ store, now: () => NOW });
    const signed = (over: { secret?: string; body?: string; ts?: number; key?: string } = {}) => {
      const b = over.body ?? body;
      const ts = over.ts ?? nowSeconds;
      return new Request("https://hosted.example/chat/slack/" + CONN_A, {
        method: "POST",
        body: b,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(ts),
          "x-slack-signature": over.key ?? sign(over.secret ?? SECRET_A, b, ts),
        },
      });
    };
    const run = (req: Request, id = CONN_A, provider: "slack" | "discord" = "slack") =>
      authenticate(req, id, provider, slackVerifier, deps());

    it("accepts a request signed with the connection's secret and hands back the raw body", async () => {
      const r = await run(signed({ body: body + "&t=" + randomBytes(4).toString("hex") }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.connection.orgId).toBe(ORG_A);
        expect(r.rawBody.toString()).toContain("block_actions");
      }
    });

    it("refuses the same signed request a second time (replay), with the same answer as a bad signature", async () => {
      const b = body + "&t=" + randomBytes(4).toString("hex");
      expect((await run(signed({ body: b }))).ok).toBe(true);
      const again = await run(signed({ body: b }));
      expect(again).toEqual({ ok: false, status: 401, reason: "replayed" });
      const bad = await run(signed({ body: b + "x", key: sign(SECRET_A, b, nowSeconds) }));
      expect(bad).toEqual({ ok: false, status: 401, reason: "bad-signature" });
    });

    it("a copy of an accepted signature in another letter case is the same request: refused as a replay", async () => {
      const b = body + "&t=" + randomBytes(4).toString("hex");
      const original = signed({ body: b });
      expect((await run(original)).ok).toBe(true);
      const shouting = signed({
        body: b,
        key: "v0=" + sign(SECRET_A, b, nowSeconds).slice(3).toUpperCase(),
      });
      expect(await run(shouting)).toEqual({ ok: false, status: 401, reason: "replayed" });
    });

    it("a request that fails the signature does not use up its key", async () => {
      const b = body + "&t=" + randomBytes(4).toString("hex");
      const forged = signed({ body: b, secret: SECRET_B });
      expect((await run(forged)).ok).toBe(false);
      // The real request, with the real signature, still goes through: the forgery claimed nothing.
      expect((await run(signed({ body: b }))).ok).toBe(true);
    });

    it("refuses a bad signature, a stale timestamp and another organisation's secret", async () => {
      const b = body + "&t=" + randomBytes(4).toString("hex");
      expect(await run(signed({ body: b, secret: SECRET_A + "x" }))).toMatchObject({
        status: 401,
        reason: "bad-signature",
      });
      expect(await run(signed({ body: b, secret: SECRET_B }))).toMatchObject({
        status: 401,
        reason: "bad-signature",
      });
      expect(await run(signed({ body: b, ts: nowSeconds - 301 }))).toMatchObject({
        status: 401,
        reason: "stale",
      });
      expect(await run(signed({ body: b, ts: nowSeconds + 301 }))).toMatchObject({
        status: 401,
        reason: "stale",
      });
    });

    it("refuses a body over the cap before the database is asked anything", async () => {
      let asked = 0;
      const counting: ChatStore = {
        ...store,
        connection: async (id) => (asked++, store.connection(id)),
      };
      const big = signed({ body: "a".repeat(64 * 1024 + 1) });
      const r = await authenticate(big, CONN_A, "slack", slackVerifier, {
        store: counting,
        now: () => NOW,
      });
      expect(r).toEqual({ ok: false, status: 413, reason: "too-large" });
      expect(asked).toBe(0);
    });

    it("refuses an unknown or disabled connection, the wrong provider and a secret of the wrong kind", async () => {
      const b = body + "&t=" + randomBytes(4).toString("hex");
      expect(await run(signed({ body: b }), randomUUID())).toMatchObject({
        status: 401,
        reason: "unknown-connection",
      });
      expect(await run(signed({ body: b }), CONN_OFF)).toMatchObject({
        status: 401,
        reason: "unknown-connection",
      });
      expect(await run(signed({ body: b }), "../etc/passwd")).toMatchObject({
        reason: "unknown-connection",
      });
      expect(await run(signed({ body: b }), CONN_A_DISCORD)).toMatchObject({
        reason: "wrong-provider",
      });
      expect(await run(signed({ body: b }), CONN_A, "discord")).toMatchObject({
        reason: "wrong-provider",
      });
      expect(await run(signed({ body: b }), CONN_A_HOOK)).toMatchObject({
        status: 401,
        reason: "no-secret",
      });
    });

    it("refuses missing headers", async () => {
      const bare = new Request("https://hosted.example/chat/slack/" + CONN_A, {
        method: "POST",
        body,
      });
      expect(await run(bare)).toMatchObject({ status: 401, reason: "missing-header" });
    });
  });

  describe("decideFromChat: the same decision the inbox records", () => {
    it("an approval by a linked member writes one decision in their name and enqueues one apply job", async () => {
      const id = await draft();
      const r = await decideFromChat(decideDeps(), await connection(), act({ draftId: id }));
      expect(r).toMatchObject({ status: "recorded", decision: "approved", userId: USER_A_MEMBER });
      expect(await rows(id)).toEqual([{ decision: "approved", decided_by: USER_A_MEMBER }]);
      expect(queue.jobs.get(id)).toMatchObject({ orgId: ORG_A, draftId: id, kind: "email" });
      const state =
        await owner`select decision, decided_by from public.draft_state where draft_id = ${id}`;
      expect(state).toEqual([{ decision: "approved", decided_by: USER_A_MEMBER }]);
    });

    it("a decline writes a decision and no job", async () => {
      const id = await draft();
      const r = await decideFromChat(
        decideDeps(),
        await connection(),
        act({ draftId: id, choice: "decline", chatUserId: "U0OWNER" }),
      );
      expect(r).toMatchObject({ status: "recorded", decision: "declined", userId: USER_A_OWNER });
      expect(queue.jobs.has(id)).toBe(false);
    });

    it("a second press is told who decided first, and writes nothing", async () => {
      const id = await draft();
      const conn = await connection();
      await decideFromChat(decideDeps(), conn, act({ draftId: id }));
      const again = await decideFromChat(
        decideDeps(),
        conn,
        act({ draftId: id, chatUserId: "U0OWNER", choice: "decline" }),
      );
      expect(again).toEqual({
        status: "already-decided",
        decision: "approved",
        decidedBy: USER_A_MEMBER,
      });
      expect(await rows(id)).toHaveLength(1);
    });

    it("two presses at the same moment give one decision and one job", async () => {
      const id = await draft();
      const conn = await connection();
      const results = await Promise.all([
        decideFromChat(decideDeps(), conn, act({ draftId: id })),
        decideFromChat(decideDeps(), conn, act({ draftId: id, chatUserId: "U0OWNER" })),
        decideFromChat(decideDeps(), conn, act({ draftId: id })),
      ]);
      expect(results.filter((r) => r.status === "recorded")).toHaveLength(1);
      expect(results.filter((r) => r.status === "already-decided")).toHaveLength(2);
      expect(await rows(id)).toHaveLength(1);
    });

    it("a draft the inbox already decided answers the same way", async () => {
      const id = await draft();
      await owner`insert into public.decisions (org_id, draft_id, decision, decided_by) values (${ORG_A}, ${id}, 'declined', ${USER_A_OWNER})`;
      expect(await decideFromChat(decideDeps(), await connection(), act({ draftId: id }))).toEqual({
        status: "already-decided",
        decision: "declined",
        decidedBy: USER_A_OWNER,
      });
    });

    it("an unlinked chat user cannot decide, and nothing is written", async () => {
      const id = await draft();
      const r = await decideFromChat(
        decideDeps(),
        await connection(),
        act({ draftId: id, chatUserId: "U0STRANGER" }),
      );
      expect(r).toEqual({ status: "unknown-user" });
      expect(await rows(id)).toHaveLength(0);
    });

    it("a client viewer, even linked, cannot decide, and nothing is written", async () => {
      const id = await draft();
      for (const choice of ["approve", "decline"] as const)
        expect(
          await decideFromChat(
            decideDeps(),
            await connection(),
            act({ draftId: id, chatUserId: "U0CLIENT", choice }),
          ),
        ).toEqual({
          status: "not-allowed",
        });
      expect(await rows(id)).toHaveLength(0);
    });

    it("a payload that names another workspace is refused", async () => {
      const id = await draft();
      for (const workspace of ["T0BRIGHTFIELD", null])
        expect(
          await decideFromChat(decideDeps(), await connection(), act({ draftId: id, workspace })),
        ).toEqual({
          status: "wrong-workspace",
        });
      expect(await rows(id)).toHaveLength(0);
    });

    it("another organisation's draft is not found, even for a person who belongs to both", async () => {
      const theirs = await draft(ORG_B, SITE_B1);
      // USER_BOTH is a member of A and an admin of B, and is linked on Northgate's connection.
      const r = await decideFromChat(
        decideDeps(),
        await connection(),
        act({ draftId: theirs, chatUserId: "U0BOTH" }),
      );
      expect(r).toEqual({ status: "not-found" });
      expect(await rows(theirs)).toHaveLength(0);
      // The same person does see it in the inbox (row-level security would allow it): the check is ours.
      const seen = await as(
        owner,
        { role: "authenticated", userId: USER_BOTH },
        (tx) => tx`select id from public.drafts where id = ${theirs}`,
      );
      expect(seen).toHaveLength(1);
    });

    it("refuses a draft id that is not a draft, and one that does not exist", async () => {
      for (const draftId of [randomUUID(), "not-a-uuid", "' or 1=1 --", ""])
        expect(
          await decideFromChat(decideDeps(), await connection(), act({ draftId })),
          draftId,
        ).toEqual({ status: "not-found" });
    });

    it("refuses to approve a proposal past its expiry, but a decline is allowed", async () => {
      const old = await draft(ORG_A, SITE_A1, PROPOSAL_EXPIRY_MS + 1000);
      expect(await decideFromChat(decideDeps(), await connection(), act({ draftId: old }))).toEqual(
        { status: "expired" },
      );
      expect(await rows(old)).toHaveLength(0);
      const fresh = await draft(ORG_A, SITE_A1, PROPOSAL_EXPIRY_MS - 60_000);
      expect(
        (await decideFromChat(decideDeps(), await connection(), act({ draftId: fresh }))).status,
      ).toBe("recorded");
      const declined = await decideFromChat(
        decideDeps(),
        await connection(),
        act({ draftId: old, choice: "decline" }),
      );
      expect(declined.status).toBe("recorded");
    });

    it("sends a person to the inbox when a finding the draft fixes has closed (the confirming click is not offered in chat)", async () => {
      const id = randomUUID();
      const [finding] =
        await owner`select id from public.findings where site_id = ${SITE_A1} limit 1`;
      await owner`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids, created_at)
        values (${id}, ${ORG_A}, ${SITE_A1}, 'email', ${owner.json({ subject: "Fixed", body: "Done." })}, ${[finding!.id as string]}, ${NOW})`;
      // A later clean run that no longer reports the finding's fingerprint.
      const later = randomUUID();
      await owner`insert into public.runs (id, org_id, site_id, started_at, finished_at, summary)
        values (${later}, ${ORG_A}, ${SITE_A1}, '2026-11-11T03:00:00Z', '2026-11-11T03:01:00Z', '{"high":0}')`;
      const r = await decideFromChat(decideDeps(), await connection(), act({ draftId: id }));
      expect(r).toEqual({ status: "open-inbox", why: "closed-findings" });
      expect(await rows(id)).toHaveLength(0);
      // Declining a draft whose finding closed needs no confirmation.
      expect(
        (
          await decideFromChat(
            decideDeps(),
            await connection(),
            act({ draftId: id, choice: "decline" }),
          )
        ).status,
      ).toBe("recorded");
      void RUN_A1;
    });

    it("a draft that fixes a finding of another site is refused (the inbox's own check, in SQL)", async () => {
      const id = randomUUID();
      const [other] =
        await owner`select id from public.findings where site_id <> ${SITE_A1} limit 1`;
      await owner`insert into public.drafts (id, org_id, site_id, kind, payload, finding_ids)
        values (${id}, ${ORG_A}, ${SITE_A1}, 'email', ${owner.json({ subject: "x", body: "y" })}, ${[other!.id as string]})`;
      expect(await decideFromChat(decideDeps(), await connection(), act({ draftId: id }))).toEqual({
        status: "open-inbox",
        why: "invalid-payload",
      });
      expect(await rows(id)).toHaveLength(0);
    });
  });

  describe("a chat login cannot be anyone (review finding 1)", () => {
    const asChatLogin = (q: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      errorOf(chat.begin(async (tx) => void (await q(tx))));
    const claim = (tx: postgres.TransactionSql, who: string) =>
      tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: who })}, true)`;

    it("setting a victim's claims and switching to authenticated is refused: the role is not the login's to take", async () => {
      const id = await draft();
      for (const victim of [USER_A_OWNER, USER_A_MEMBER, USER_BOTH]) {
        const msg = await asChatLogin(async (tx) => {
          await claim(tx, victim);
          await tx.unsafe("set local role authenticated");
          await tx`insert into public.decisions (org_id, draft_id, decision, decided_by)
            values (${ORG_A}, ${id}, 'approved', ${victim})`;
        });
        expect(msg, victim).toMatch(/permission denied to set role|must be member/);
      }
      for (const role of [
        "service_role",
        "gaugeline_worker",
        "gaugeline_agent",
        "anon",
        "postgres",
      ])
        expect(await asChatLogin((tx) => tx.unsafe(`set local role ${role}`)), role).toMatch(
          /permission denied to set role|must be member|does not exist/,
        );
      expect(await rows(id)).toHaveLength(0);
    });

    it("as the login itself it can read no draft, decision, connection id or link, with or without claims", async () => {
      for (const q of [
        "select * from public.drafts",
        "select * from public.decisions",
        "select * from public.chat_connections",
        "select * from public.chat_identities",
        "select * from public.members",
      ])
        expect(
          await asChatLogin(async (tx) => {
            await claim(tx, USER_A_OWNER);
            await tx.unsafe(q);
          }),
          q,
        ).toMatch(/permission denied/);
    });

    it("chat_decide takes no member from the caller, so there is no name to forge: every refusal writes nothing", async () => {
      const mine = await draft();
      const theirs = await draft(ORG_B, SITE_B1);
      const call = async (conn: string, user: string, d: string, choice = "approve") =>
        (
          await chat.begin(async (tx) => {
            await tx.unsafe("set local role gaugeline_chat");
            return tx`select r_status from private.chat_decide(${conn}, ${user}, ${d}, ${choice})`;
          })
        )[0]!.r_status;
      expect(await call(CONN_A, "U0NOBODY", mine)).toBe("unknown-user"); // not linked
      expect(await call(CONN_A, "U0CLIENT", mine)).toBe("not-allowed"); // a client viewer
      expect(await call(CONN_A, "U0OWNER", theirs)).toBe("not-found"); // another organisation's draft
      expect(await call(CONN_B, "U0OWNER", mine)).toBe("unknown-user"); // a link is per connection
      expect(await call(CONN_OFF, "U0OWNER", mine)).toBe("not-found"); // a disabled connection
      expect(await call(randomUUID(), "U0OWNER", mine)).toBe("not-found");
      expect(
        await asChatLogin(async (tx) => {
          await tx.unsafe("set local role gaugeline_chat");
          await tx`select * from private.chat_decide(${CONN_A}, 'U0OWNER', ${mine}, 'maybe')`;
        }),
      ).toMatch(/choice must be/);
      expect(await rows(mine)).toHaveLength(0);
      expect(await rows(theirs)).toHaveLength(0);
      expect(await call(CONN_A, "U0OWNER", mine)).toBe("recorded");
      expect(await rows(mine)).toEqual([{ decision: "approved", decided_by: USER_A_OWNER }]);
    });
  });

  describe("a link counts only once the member confirms it (review finding 2)", () => {
    // Committed, unlike as(): these tests change what the links say and read it back.
    const asUser = (userId: string, fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      errorOf(
        owner.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
          await tx.unsafe("set local role authenticated");
          await fn(tx);
        }),
      );
    const propose = (adminUser: string, chatUser: string, member: string) =>
      asUser(
        adminUser,
        (tx) => tx`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id)
          values (${ORG_A}, ${CONN_A}, ${chatUser}, ${member})`,
      );
    const cleanup = (chatUser: string) =>
      owner`delete from public.chat_identities where connection_id = ${CONN_A} and chat_user_id = ${chatUser}`;

    it("an admin's link to the owner does not let them decide as the owner until the owner confirms it", async () => {
      const id = await draft();
      // USER_BOTH is a member of A (not an admin there): use the owner to stand in as the admin who proposes.
      await owner`update public.members set role = 'admin' where org_id = ${ORG_A} and user_id = ${USER_BOTH}`;
      try {
        expect(await propose(USER_BOTH, "U0FORGER", USER_A_OWNER)).toBe("");
        const pending =
          await owner`select confirmed_at from public.chat_identities where chat_user_id = 'U0FORGER'`;
        expect(pending).toEqual([{ confirmed_at: null }]);
        const r = await decideFromChat(
          decideDeps(),
          await connection(),
          act({ draftId: id, chatUserId: "U0FORGER" }),
        );
        expect(r).toEqual({ status: "unknown-user" });
        expect(await rows(id)).toHaveLength(0);

        // The proposer cannot confirm it for the owner, or set the stamp themselves.
        const byAdmin = await owner.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: USER_BOTH })}, true)`;
          await tx.unsafe("set local role authenticated");
          return tx`update public.chat_identities set confirmed_at = now() where chat_user_id = 'U0FORGER' returning 1`;
        });
        expect(byAdmin).toHaveLength(0);
        expect(
          await propose(USER_BOTH, "U0OTHER", USER_A_OWNER).then(() =>
            asUser(
              USER_BOTH,
              (
                tx,
              ) => tx`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id, confirmed_at)
            values (${ORG_A}, ${CONN_A}, 'U0PRE', ${USER_A_OWNER}, now())`,
            ),
          ),
        ).toMatch(/permission denied/);

        // The owner, signed in, confirms their own link; now it counts, and is stamped by the database.
        const confirmed = await owner.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: USER_A_OWNER })}, true)`;
          await tx.unsafe("set local role authenticated");
          return tx`update public.chat_identities set confirmed_at = '2001-01-01' where chat_user_id = 'U0FORGER' returning confirmed_at`;
        });
        expect(confirmed).toHaveLength(1);
        expect((confirmed[0]!.confirmed_at as Date).getFullYear()).toBeGreaterThan(2020); // the trigger stamps now()
        expect(
          (
            await decideFromChat(
              decideDeps(),
              await connection(),
              act({ draftId: id, chatUserId: "U0FORGER" }),
            )
          ).status,
        ).toBe("recorded");
        expect(await rows(id)).toEqual([{ decision: "approved", decided_by: USER_A_OWNER }]);
      } finally {
        await cleanup("U0FORGER");
        await cleanup("U0OTHER");
        await owner`update public.members set role = 'member' where org_id = ${ORG_A} and user_id = ${USER_BOTH}`;
      }
    });

    it("a confirmation cannot be undone or re-pointed by the member, and a member cannot link anyone but through an admin", async () => {
      await owner`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id) values (${ORG_A}, ${CONN_A}, 'U0PEND', ${USER_A_MEMBER})`;
      try {
        const mine = (q: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          asUser(USER_A_MEMBER, q);
        expect(
          await mine(
            (tx) =>
              tx`update public.chat_identities set confirmed_at = now() where chat_user_id = 'U0PEND'`,
          ),
        ).toBe("");
        // Confirmed once: it cannot be cleared, and no other column is writable.
        const cleared = await owner.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: USER_A_MEMBER })}, true)`;
          await tx.unsafe("set local role authenticated");
          return tx`update public.chat_identities set confirmed_at = null where chat_user_id = 'U0PEND' returning 1`;
        });
        expect(cleared).toHaveLength(0);
        expect(
          await mine(
            (tx) =>
              tx`update public.chat_identities set user_id = ${USER_A_OWNER} where chat_user_id = 'U0PEND'`,
          ),
        ).toMatch(/permission denied/);
        expect(
          await mine(
            (tx) =>
              tx`update public.chat_identities set chat_user_id = 'U0ELSE' where chat_user_id = 'U0PEND'`,
          ),
        ).toMatch(/permission denied/);
        expect(await propose(USER_A_MEMBER, "U0SELF", USER_A_MEMBER)).toMatch(/row-level security/);
        // They may remove their own link.
        expect(
          await mine((tx) => tx`delete from public.chat_identities where chat_user_id = 'U0PEND'`),
        ).toBe("");
      } finally {
        await cleanup("U0PEND");
      }
    });

    it("a member sees only their own links; an admin sees the organisation's", async () => {
      const seen = (userId: string) =>
        as(
          owner,
          { role: "authenticated", userId },
          (tx) => tx`select chat_user_id from public.chat_identities order by 1`,
        );
      expect((await seen(USER_A_MEMBER)).map((r) => r.chat_user_id)).toEqual(["U0MEMBER"]);
      expect((await seen(USER_A_OWNER)).length).toBeGreaterThanOrEqual(4);
    });
  });
});
