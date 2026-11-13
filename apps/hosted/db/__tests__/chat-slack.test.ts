/**
 * Approve in Slack (X69, part 2) against a real Postgres and a local stand-in for Slack (fake-slack.ts):
 * the interaction payload, the messages, and the whole path through the hosted app's route handler. The
 * chat login runs everything the endpoint does. Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSlackDeps, openChatDatabase, setReplyForTests } from "../../chat/deps.js";
import { parseInteraction, sendApprovalRequest, slackInteraction } from "../../chat/slack.js";
import { sqlChatStore } from "../../chat/store.js";
import { MemoryApplyQueue } from "../../inbox/inbox.js";
import { POST } from "../../app/api/chat/slack/[connection]/route.js";
import { FakeSlack } from "./fake-slack.js";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  SITE_A1,
  SITE_B1,
  type Sql,
  TEST_DATABASE_URL,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
} from "./harness.js";

const SECRET = ["sig", "northgate", randomBytes(12).toString("hex")].join("-");
const TEAM = "T0NORTHGATE";
const CONN = "c2000000-0000-4000-8000-0000000000a1";
const LOGIN = `gl_chat_slack_${randomBytes(4).toString("hex")}`;
const WEBHOOK = ["https://hooks.slack.com/services", TEAM, "B0TIDEWATER", "x".repeat(24)].join("/");
const APP = "https://app.example";

// Slack's own shapes for the interaction, as bolt-js types them; parseInteraction takes only ids from them.
const form = (payload: unknown) =>
  Buffer.from("payload=" + encodeURIComponent(JSON.stringify(payload)));
const FORM = "application/x-www-form-urlencoded";
const DRAFT = "a1d10000-0000-4000-8000-0000000000a1";
const press = (over: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => ({
  type: "block_actions",
  user: { id: "U0MEMBER", team_id: TEAM },
  team: { id: TEAM },
  response_url: "https://hooks.slack.com/actions/T0NORTHGATE/1/abc",
  actions: [{ type: "button", action_id: "gaugeline_approve", value: DRAFT, ...action }],
  ...over,
});

describe("parseInteraction", () => {
  it("reads the clicker, the workspace, the draft and the choice, and nothing else", () => {
    expect(parseInteraction(form(press()), FORM)).toEqual({
      kind: "decision",
      responseUrl: "https://hooks.slack.com/actions/T0NORTHGATE/1/abc",
      action: { chatUserId: "U0MEMBER", workspace: TEAM, draftId: DRAFT, choice: "approve" },
    });
    const d = parseInteraction(form(press({}, { action_id: "gaugeline_decline" })), FORM);
    expect(d).toMatchObject({ action: { choice: "decline" } });
    // The workspace may come from the user (an enterprise install has no team on the payload).
    const u = parseInteraction(form(press({ team: null })), FORM);
    expect(u).toMatchObject({ action: { workspace: TEAM } });
  });

  it("asks for nothing on a link button, another action or another kind of interaction", () => {
    for (const p of [
      press({}, { action_id: "gaugeline_edit", value: undefined }),
      press({}, { action_id: "some_other_button" }),
      { type: "view_submission" },
      { type: "shortcut" },
    ])
      expect(parseInteraction(form(p), FORM), JSON.stringify(p)).toEqual({ kind: "ignore" });
  });

  it("refuses anything that is not exactly the shape: nothing malformed reaches the decision", () => {
    const bad: [string, Buffer, string | null][] = [
      ["not a form", form(press()), "application/json"],
      ["no content type", form(press()), null],
      [
        "a longer type that merely starts the same",
        form(press()),
        "application/x-www-form-urlencoded-evil",
      ],
      ["multipart", form(press()), "multipart/form-data; boundary=x"],
      ["no payload", Buffer.from("x=1"), FORM],
      ["two payloads", Buffer.concat([form(press()), Buffer.from("&"), form(press())]), FORM],
      ["not json", Buffer.from("payload=%7Bnot"), FORM],
      ["json that is not an object", form([1]), FORM],
      ["two actions", form(press({ actions: [press().actions[0], press().actions[0]] })), FORM],
      ["no actions", form(press({ actions: [] })), FORM],
      ["a user id with markup", form(press({ user: { id: "U0X> <!channel" } })), FORM],
      ["a lowercase user id", form(press({ user: { id: "u0member" } })), FORM],
      ["no user", form(press({ user: null })), FORM],
      ["a draft id that is not an id", form(press({}, { value: "x' or 1=1 --" })), FORM],
      ["no draft id", form(press({}, { value: undefined })), FORM],
      ["a numeric draft id", form(press({}, { value: 42 })), FORM],
    ];
    for (const [label, body, type] of bad)
      expect(parseInteraction(body, type), label).toEqual({ kind: "malformed" });
  });

  it("a workspace that is not an id is treated as none, so a connection that names one refuses it", () => {
    const r = parseInteraction(
      form(press({ team: { id: "<script>" }, user: { id: "U0MEMBER" } })),
      FORM,
    );
    expect(r).toMatchObject({ action: { workspace: null } });
  });
});

describe.skipIf(!HAS_DATABASE)("approving in Slack", () => {
  let db: TestDatabase;
  let owner: Sql;
  let chat: Sql;
  let slack: FakeSlack;
  const queue = new MemoryApplyQueue();

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    await owner.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`select private.put_secret(${ORG_A}, 'chat-slack', 'signing_secret', ${SECRET})`;
    });
    await owner.unsafe(`
      insert into public.chat_connections (id, org_id, provider, label, workspace_ref, secret_name)
        values ('${CONN}', '${ORG_A}', 'slack', 'Northgate Slack', '${TEAM}', 'chat-slack');
      insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id, confirmed_at) values
        ('${ORG_A}', '${CONN}', 'U0OWNER', '${USER_A_OWNER}', now()),
        ('${ORG_A}', '${CONN}', 'U0MEMBER', '${USER_A_MEMBER}', now()),
        ('${ORG_A}', '${CONN}', 'U0CLIENT', '${USER_A_CLIENT}', now());
      create role ${LOGIN} login noinherit password 'chat-test-login';
      grant gaugeline_chat to ${LOGIN};
    `);
    const u = new URL(db.url);
    u.username = LOGIN;
    u.password = "chat-test-login";
    chat = postgres(u.href, { max: 4, onnotice: () => {} });
    slack = new FakeSlack(SECRET, TEAM);
    // The route handler reads its database from the environment, like the running app.
    process.env.GAUGELINE_CHAT_DATABASE_URL = u.href;
    process.env.GAUGELINE_APP_URL = APP;
    setReplyForTests((endpoint, body) => slack.reply(endpoint, body));
  });
  afterAll(async () => {
    delete process.env.GAUGELINE_CHAT_DATABASE_URL;
    delete process.env.GAUGELINE_APP_URL;
    setReplyForTests(undefined);
    await closeSlackDeps();
    await chat?.end();
    await db?.drop();
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop role if exists ${LOGIN}`);
    await admin.end();
  });

  async function proposal(org = ORG_A, site = SITE_A1): Promise<{ id: string; ts: string }> {
    const id = randomUUID();
    await owner`insert into public.drafts (id, org_id, site_id, kind, payload)
      values (${id}, ${org}, ${site}, 'pull_request',
        ${owner.json({ title: "Point the menu link at /drinks <!channel>", body: "The menu links to /drinks-2025.", files: [{ path: "app/menu.ts", content: "x" }] })})`;
    // The team's channel shows it, posted the way the worker would post it: core's message, to the webhook.
    let ts = "";
    const r = await sendApprovalRequest(
      WEBHOOK,
      {
        site: "The Tidewater Bar",
        kind: "pull_request",
        title: "Point the menu link at /drinks <!channel>",
        draftId: id,
        inboxUrl: `${APP}/inbox/${id}`,
      },
      async (endpoint, body) => {
        expect(endpoint).toBe(WEBHOOK);
        ts = slack.post(body);
        return { ok: true, status: 200 };
      },
    );
    expect(r.ok).toBe(true);
    return { id, ts };
  }
  const decisions = (id: string) =>
    owner`select decision, decided_by from public.decisions where draft_id = ${id} order by id`;
  /** Press through the hosted app's route handler, as Slack would. */
  async function send(p: ReturnType<FakeSlack["press"]>, connection = CONN): Promise<Response> {
    return POST(
      new Request(`https://hosted.example${p.path(connection)}`, {
        method: "POST",
        body: p.body,
        headers: p.headers,
      }),
      {
        params: Promise.resolve({ connection }),
      },
    );
  }
  const text = (ts: string) => JSON.stringify(slack.channel.get(ts));

  it("approving writes one decision for the right person, updates the message, and a second click says it was decided", async () => {
    const { id, ts } = await proposal();
    // What the channel shows: the proposal with its three buttons, page text as text.
    expect(slack.buttons(ts).map((b) => b.action_id)).toEqual([
      "gaugeline_approve",
      "gaugeline_edit",
      "gaugeline_decline",
    ]);
    expect(slack.buttons(ts)[1]!.url).toBe(`${APP}/inbox/${id}`);
    expect(text(ts)).not.toContain("<!channel>");

    const first = await send(slack.press(ts, "gaugeline_approve", "U0MEMBER"));
    expect(first.status).toBe(200);
    expect(await decisions(id)).toEqual([{ decision: "approved", decided_by: USER_A_MEMBER }]);
    // The message was replaced in place: no buttons, who decided, when.
    const after = slack.channel.get(ts)!;
    expect(after.blocks.map((b) => b.type)).toEqual(["section", "context"]);
    expect(JSON.stringify(after)).toMatch(/Approved by <@U0MEMBER> at 20\d\d-/);
    expect(JSON.stringify(after)).not.toContain("gaugeline_approve");
    expect(text(ts)).not.toContain("<!channel>");

    // A second press (a new signed request, as a stale copy of the message can still be pressed).
    const second = await send(slack.press(ts, "gaugeline_approve", "U0OWNER"));
    expect(second.status).toBe(200);
    expect(await decisions(id)).toHaveLength(1);
    expect(slack.private.get("U0OWNER")?.at(-1)).toMatch(/already approved/);
  });

  it("declining records a decline and says so in the message", async () => {
    const { id, ts } = await proposal();
    await send(slack.press(ts, "gaugeline_decline", "U0OWNER"));
    expect(await decisions(id)).toEqual([{ decision: "declined", decided_by: USER_A_OWNER }]);
    expect(JSON.stringify(slack.channel.get(ts))).toMatch(
      /Declined by <@U0OWNER>.*Nothing will be applied/,
    );
  });

  it("Edit first is a link: pressing it records nothing", async () => {
    const { id, ts } = await proposal();
    const r = await send(slack.press(ts, "gaugeline_edit", "U0MEMBER"));
    expect(r.status).toBe(200);
    expect(await decisions(id)).toHaveLength(0);
    expect(slack.channel.get(ts)!.blocks).toHaveLength(2); // untouched
  });

  it("a stranger and a client viewer get a private reply, nothing is recorded, the message is unchanged", async () => {
    const { id, ts } = await proposal();
    const before = text(ts);
    await send(slack.press(ts, "gaugeline_approve", "U0STRANGER"));
    await send(slack.press(ts, "gaugeline_approve", "U0CLIENT"));
    await send(slack.press(ts, "gaugeline_decline", "U0CLIENT"));
    expect(await decisions(id)).toHaveLength(0);
    expect(text(ts)).toBe(before);
    expect(slack.private.get("U0STRANGER")?.at(-1)).toMatch(/not linked/);
    expect(slack.private.get("U0CLIENT")?.at(-1)).toMatch(/not allowed/);
  });

  it("another organisation's draft in a button is not available through this connection", async () => {
    const theirs = await proposal(ORG_B, SITE_B1);
    await send(slack.press(theirs.ts, "gaugeline_approve", "U0OWNER"));
    expect(await decisions(theirs.id)).toHaveLength(0);
    expect(slack.private.get("U0OWNER")?.at(-1)).toMatch(/not available/);
  });

  it("a request from another workspace is refused and records nothing", async () => {
    const { id, ts } = await proposal();
    await send(slack.press(ts, "gaugeline_approve", "U0MEMBER", { team: "T0BRIGHTFIELD" }));
    expect(await decisions(id)).toHaveLength(0);
  });

  it("an unsigned, wrongly signed, stale, replayed or oversized request is refused before anything is read", async () => {
    const { id, ts } = await proposal();
    const repliesBefore = slack.replies.length;
    const refused = async (p: ReturnType<FakeSlack["press"]>, status: number) => {
      expect((await send(p)).status).toBe(status);
    };
    await refused(slack.press(ts, "gaugeline_approve", "U0MEMBER", { secret: SECRET + "x" }), 401);
    await refused(
      slack.press(ts, "gaugeline_approve", "U0MEMBER", {
        timestamp: Math.floor(Date.now() / 1000) - 400,
      }),
      401,
    );
    const unsigned = slack.press(ts, "gaugeline_approve", "U0MEMBER");
    delete (unsigned.headers as Record<string, string>)["x-slack-signature"];
    await refused(unsigned, 401);
    // A body changed after signing.
    const tampered = slack.press(ts, "gaugeline_approve", "U0MEMBER");
    tampered.body = tampered.body.replace("U0MEMBER", "U0OWNER");
    await refused(tampered, 401);
    // Too big, even with a valid signature over it.
    const big = slack.press(ts, "gaugeline_approve", "U0MEMBER", {
      mutate: (p) => (p.padding = "a".repeat(70_000)),
    });
    await refused(big, 413);
    expect(await decisions(id)).toHaveLength(0);
    expect(slack.replies.length).toBe(repliesBefore);

    // The genuine request goes through once; sent again it is a replay and changes nothing more.
    const real = slack.press(ts, "gaugeline_approve", "U0MEMBER");
    await refused(real, 200);
    const replies = slack.replies.length;
    await refused(real, 401);
    expect(await decisions(id)).toHaveLength(1);
    expect(slack.replies.length).toBe(replies);
  });

  it("an unknown connection answers like a bad signature", async () => {
    const { ts } = await proposal();
    expect(
      (await send(slack.press(ts, "gaugeline_approve", "U0MEMBER"), randomUUID())).status,
    ).toBe(401);
    expect((await send(slack.press(ts, "gaugeline_approve", "U0MEMBER"), "not-an-id")).status).toBe(
      401,
    );
  });

  it("a reply address that is not Slack's gets no reply, and the decision is still recorded", async () => {
    const { id, ts } = await proposal();
    const replies = slack.replies.length;
    const r = await send(
      slack.press(ts, "gaugeline_approve", "U0MEMBER", {
        mutate: (p) => (p.response_url = "https://evil.test/actions/T0/1/a"),
      }),
    );
    expect(r.status).toBe(200);
    expect(await decisions(id)).toHaveLength(1);
    expect(slack.replies.length).toBe(replies);
  });

  it("a reply that cannot be sent does not undo the decision, and the answer to Slack is still 200", async () => {
    const { id, ts } = await proposal();
    const deps = {
      sql: chat,
      store: sqlChatStore(chat),
      queue,
      reply: async () => {
        throw new Error("network down");
      },
    };
    const p = slack.press(ts, "gaugeline_approve", "U0MEMBER");
    const r = await slackInteraction(
      new Request("https://hosted.example/x", { method: "POST", body: p.body, headers: p.headers }),
      CONN,
      deps,
    );
    expect(r.status).toBe(200);
    expect(await decisions(id)).toHaveLength(1);
    expect(queue.jobs.has(id)).toBe(true);
  });

  it("a signed body in any content type but a form is a 400 and is not parsed", async () => {
    const { id, ts } = await proposal();
    for (const type of [
      "application/json",
      "multipart/form-data; boundary=x",
      "text/plain",
      "application/x-www-form-urlencoded-evil",
      "",
    ]) {
      const p = slack.press(ts, "gaugeline_approve", "U0MEMBER");
      if (type) p.headers["content-type"] = type;
      else delete p.headers["content-type"];
      expect((await send(p)).status, type).toBe(400);
    }
    expect(await decisions(id)).toHaveLength(0);
    // The form type Slack sends is accepted, with or without a charset.
    const ok = slack.press(ts, "gaugeline_approve", "U0MEMBER");
    ok.headers["content-type"] = "application/x-www-form-urlencoded; charset=utf-8";
    expect((await send(ok)).status).toBe(200);
    expect(await decisions(id)).toHaveLength(1);
  });

  it("a malformed body that IS signed is a 400 and records nothing", async () => {
    const { id, ts } = await proposal();
    const r = await send(
      slack.press(ts, "gaugeline_approve", "U0MEMBER", { mutate: (p) => (p.actions = []) }),
    );
    expect(r.status).toBe(400);
    expect(await decisions(id)).toHaveLength(0);
  });

  it("the endpoint does not run without a wired apply queue outside development and tests", async () => {
    const was = process.env.NODE_ENV;
    await closeSlackDeps();
    process.env.NODE_ENV = "production";
    try {
      const { ts } = await proposal();
      expect((await send(slack.press(ts, "gaugeline_approve", "U0MEMBER"))).status).toBe(503);
    } finally {
      process.env.NODE_ENV = was;
      await closeSlackDeps();
    }
  });

  describe("posting a proposal", () => {
    const req = { site: "Bar", kind: "email", title: "Subject", draftId: DRAFT };
    it("goes only to a Slack incoming webhook; any other address is refused and nothing is sent", async () => {
      let sent = 0;
      for (const url of [
        "https://evil.test/hook",
        "http://hooks.slack.com/services/T0/B0/x",
        "https://hooks.slack.com.evil.test/services/T0/B0/x",
        "",
      ])
        expect((await sendApprovalRequest(url, req, async () => (sent++, { ok: true }))).ok).toBe(
          false,
        );
      expect(sent).toBe(0);
      expect((await sendApprovalRequest(WEBHOOK, req, async () => (sent++, { ok: true }))).ok).toBe(
        true,
      );
      expect(sent).toBe(1);
    });
  });

  describe("what the chat role can reach (reviewer notes c and d)", () => {
    it("gaugeline_chat holds no privilege on any table, view, column or sequence: the apply queue must be a definer function too", async () => {
      const rows = await owner`
        select n.nspname || '.' || c.relname as name from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private', 'vault', 'auth')
          and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
          and (case when c.relkind = 'S'
                 then has_sequence_privilege('gaugeline_chat', c.oid, 'USAGE, SELECT, UPDATE')
                 else has_table_privilege('gaugeline_chat', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                   or has_any_column_privilege('gaugeline_chat', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES') end)
        order by 1`;
      expect(rows.map((r) => r.name)).toEqual([]);
    });

    it("the insert policy on links refuses a confirmed row even if the column were granted", async () => {
      // The column grant already refuses it (a test in chat.test.ts). This is the second line: grant the
      // column inside a transaction that is rolled back, and the policy alone must still say no.
      class Rollback extends Error {}
      let message = "";
      try {
        await owner.begin(async (tx) => {
          await tx.unsafe("grant insert (confirmed_at) on public.chat_identities to authenticated");
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: USER_A_OWNER })}, true)`;
          await tx.unsafe("set local role authenticated");
          try {
            await tx`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id, confirmed_at)
              values (${ORG_A}, ${CONN}, 'U0PRECONFIRMED', ${USER_A_MEMBER}, now())`;
          } catch (e) {
            message = e instanceof Error ? e.message : String(e);
          }
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
      }
      expect(message).toMatch(/row-level security/);
    });
  });

  describe("the endpoint's own login", () => {
    it("refuses a login that can also be the server, the worker or the agent, and one that is not the chat role", async () => {
      const login = async (name: string, roles: string) => {
        await owner.unsafe(
          `create role ${name} login noinherit password 'x'; ${roles ? `grant ${roles} to ${name};` : ""}`,
        );
        const u = new URL(db.url);
        u.username = name;
        u.password = "x";
        return u.href;
      };
      const names = [1, 2, 3, 4].map(() => `gl_chat_bad_${randomBytes(3).toString("hex")}`);
      try {
        const cases: [string, string][] = [
          // Also a signed-in person (the review's finding: it could claim to be anyone).
          [await login(names[0]!, "gaugeline_chat, authenticated"), "also act as"],
          [await login(names[1]!, "gaugeline_chat, service_role"), "also act as"],
          [await login(names[2]!, "gaugeline_chat, gaugeline_worker"), "also act as"],
          [await login(names[3]!, "authenticated"), "member of gaugeline_chat"],
        ];
        for (const [url, why] of cases)
          await expect(openChatDatabase({ GAUGELINE_CHAT_DATABASE_URL: url })).rejects.toThrow(why);
        // A login that is a member of gaugeline_chat and nothing else is the one that is accepted.
        const only = await openChatDatabase({
          GAUGELINE_CHAT_DATABASE_URL: process.env.GAUGELINE_CHAT_DATABASE_URL,
        });
        await only.end();
        await expect(openChatDatabase({ GAUGELINE_CHAT_DATABASE_URL: db.url })).rejects.toThrow(
          /skips row-level security/,
        );
        await expect(openChatDatabase({})).rejects.toThrow(/not set/);
      } finally {
        const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
        for (const n of names) await admin.unsafe(`drop role if exists ${n}`);
        await admin.end();
      }
    });
  });
});
