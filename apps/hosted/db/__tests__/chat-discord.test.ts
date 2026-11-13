/**
 * Approve in Discord (X69, part 3) against a real Postgres and a local stand-in for Discord (fake-discord.ts):
 * the interaction payload, the answers, and the whole path through the hosted app's route handler; and the
 * connection code that requires a workspace. Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../app/api/chat/discord/[connection]/route.js";
import { POST as SLACK_POST } from "../../app/api/chat/slack/[connection]/route.js";
import { ConnectError, connectChat } from "../../chat/connect.js";
import { closeSlackDeps } from "../../chat/deps.js";
import { decideFromChat } from "../../chat/decide.js";
import { parseDiscord, sendDiscordApprovalRequest } from "../../chat/discord.js";
import { MemoryApplyQueue } from "../../inbox/inbox.js";
import { vaultSecretStore } from "../../worker/secrets.js";
import { FakeDiscord } from "./fake-discord.js";
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

const GUILD = "700000000000000001";
const LOGIN = `gl_chat_discord_${randomBytes(4).toString("hex")}`;
const WEBHOOK = ["https://discord.com/api/webhooks/800000000000000001", "a".repeat(40)].join("/");
const APP = "https://app.example";
const DRAFT = "a1d10000-0000-4000-8000-0000000000a1";
const JSON_TYPE = "application/json";

const buf = (p: unknown) => Buffer.from(JSON.stringify(p));
const press = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  type: 3,
  guild_id: GUILD,
  member: { user: { id: "800000000000000011" } },
  data: { component_type: 2, custom_id: `gaugeline_approve:${DRAFT}`, ...data },
  ...over,
});

describe("parseDiscord", () => {
  it("reads the clicker, the server, the draft and the choice, and nothing else", () => {
    expect(parseDiscord(buf(press()), JSON_TYPE)).toEqual({
      kind: "decision",
      action: {
        chatUserId: "800000000000000011",
        workspace: GUILD,
        draftId: DRAFT,
        choice: "approve",
      },
    });
    expect(
      parseDiscord(buf(press({}, { custom_id: `gaugeline_decline:${DRAFT}` })), JSON_TYPE),
    ).toMatchObject({ action: { choice: "decline" } });
    expect(parseDiscord(buf({ type: 1 }), "application/json; charset=utf-8")).toEqual({
      kind: "ping",
    });
  });

  it("a press in a direct message names no server, so it can match none", () => {
    const dm = press({
      guild_id: undefined,
      member: undefined,
      user: { id: "800000000000000011" },
    });
    expect(parseDiscord(buf(dm), JSON_TYPE)).toMatchObject({ kind: "malformed" });
    expect(parseDiscord(buf(press({ guild_id: "<x>" })), JSON_TYPE)).toMatchObject({
      action: { workspace: null },
    });
  });

  it("asks for nothing on another application's button, and refuses anything not exactly the shape", () => {
    for (const custom_id of [
      "other:1",
      "gaugeline_approve",
      `gaugeline_approve:${DRAFT}x`,
      `GAUGELINE_APPROVE:${DRAFT}`,
    ])
      expect(parseDiscord(buf(press({}, { custom_id })), JSON_TYPE), custom_id).toEqual({
        kind: "ignore",
      });
    expect(parseDiscord(buf(press({}, { component_type: 3 })), JSON_TYPE)).toEqual({
      kind: "ignore",
    });
    const bad: [string, Buffer, string | null][] = [
      ["a form", Buffer.from("payload=x"), "application/x-www-form-urlencoded"],
      ["no type", buf(press()), null],
      ["a longer type that merely starts the same", buf(press()), "application/json-evil"],
      ["text", buf(press()), "text/plain"],
      ["not json", Buffer.from("{nope"), JSON_TYPE],
      ["an array", buf([1]), JSON_TYPE],
      ["a slash command", buf({ type: 2 }), JSON_TYPE],
      ["a modal", buf({ type: 5 }), JSON_TYPE],
      ["a user id with markup", buf(press({ member: { user: { id: "1> <@2" } } })), JSON_TYPE],
      [
        "a bot",
        buf(press({ member: { user: { id: "800000000000000011", bot: true } } })),
        JSON_TYPE,
      ],
      [
        "a draft that is not a uuid",
        buf(press({}, { custom_id: "gaugeline_approve:" + "a".repeat(36) })),
        JSON_TYPE,
      ],
      ["no user", buf(press({ member: {} })), JSON_TYPE],
    ];
    for (const [label, body, type] of bad)
      expect(parseDiscord(body, type), label).toEqual({ kind: "malformed" });
  });
});

describe.skipIf(!HAS_DATABASE)("approving in Discord", () => {
  let db: TestDatabase;
  let owner: Sql;
  let discord: FakeDiscord;
  let CONN = "";
  const A_OWNER = "800000000000000021";
  const A_MEMBER = "800000000000000022";
  const A_CLIENT = "800000000000000023";

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    discord = new FakeDiscord(GUILD);
    CONN = (
      await connectChat(
        { sql: owner, secrets: vaultSecretStore(owner) },
        {
          orgId: ORG_A,
          provider: "discord",
          label: "Northgate Discord",
          workspaceRef: GUILD,
          signingSecret: discord.publicKeyHex,
        },
      )
    ).connectionId;
    await owner.unsafe(`
      insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id, confirmed_at) values
        ('${ORG_A}', '${CONN}', '${A_OWNER}', '${USER_A_OWNER}', now()),
        ('${ORG_A}', '${CONN}', '${A_MEMBER}', '${USER_A_MEMBER}', now()),
        ('${ORG_A}', '${CONN}', '${A_CLIENT}', '${USER_A_CLIENT}', now());
      create role ${LOGIN} login noinherit password 'chat-test-login';
      grant gaugeline_chat to ${LOGIN};
    `);
    const u = new URL(db.url);
    u.username = LOGIN;
    u.password = "chat-test-login";
    process.env.GAUGELINE_CHAT_DATABASE_URL = u.href;
    process.env.GAUGELINE_APP_URL = APP;
  });
  afterAll(async () => {
    delete process.env.GAUGELINE_CHAT_DATABASE_URL;
    delete process.env.GAUGELINE_APP_URL;
    await closeSlackDeps();
    await db?.drop();
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop role if exists ${LOGIN}`);
    await admin.end();
  });

  async function proposal(org = ORG_A, site = SITE_A1): Promise<{ id: string; mid: string }> {
    const id = randomUUID();
    await owner`insert into public.drafts (id, org_id, site_id, kind, payload)
      values (${id}, ${org}, ${site}, 'pull_request',
        ${owner.json({ title: "Point the menu link at /drinks @everyone", body: "The menu links to /drinks-2025.", files: [{ path: "app/menu.ts", content: "x" }] })})`;
    let mid = "";
    const r = await sendDiscordApprovalRequest(
      WEBHOOK,
      {
        site: "The Tidewater Bar",
        kind: "pull_request",
        title: "Point the menu link at /drinks @everyone",
        draftId: id,
        inboxUrl: `${APP}/inbox/${id}`,
      },
      async (endpoint, body) => {
        expect(endpoint).toBe(WEBHOOK + "?with_components=true");
        mid = discord.post(body);
        return { ok: true, status: 200 };
      },
    );
    expect(r.ok).toBe(true);
    return { id, mid };
  }
  const decisions = (id: string) =>
    owner`select decision, decided_by from public.decisions where draft_id = ${id} order by id`;
  type Signed = ReturnType<FakeDiscord["press"]>;
  async function send(p: Signed, connection = CONN): Promise<Response> {
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
  /** Press, and let the fake apply the callback the app answered with, as Discord would. */
  async function pressAs(
    mid: string,
    action: string,
    user: string,
    over: Parameters<FakeDiscord["press"]>[3] = {},
  ) {
    const res = await send(discord.press(mid, action, user, over));
    if (res.status === 200) discord.apply((await res.json()) as never, mid, user);
    return res;
  }
  const shown = (mid: string) => JSON.stringify(discord.channel.get(mid));

  it("answers Discord's PING with PONG once the signature checks out, and 401 without it", async () => {
    const ok = await send(discord.ping());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json");
    expect(await ok.json()).toEqual({ type: 1 });
    const other = new FakeDiscord(GUILD);
    expect((await send(other.ping())).status).toBe(401);
    const unsigned = discord.ping();
    delete unsigned.headers["x-signature-ed25519"];
    expect((await send(unsigned)).status).toBe(401);
  });

  it("approving writes one decision for the right person, updates the message, and a second press says it was decided", async () => {
    const { id, mid } = await proposal();
    expect(discord.customIds(mid)).toEqual([`gaugeline_approve:${id}`, `gaugeline_decline:${id}`]);
    const msg = discord.channel.get(mid)!;
    expect(JSON.stringify(msg.components)).toContain(`${APP}/inbox/${id}`);
    expect(shown(mid)).not.toMatch(/(?<!\\)@everyone/);

    expect((await pressAs(mid, "gaugeline_approve", A_MEMBER)).status).toBe(200);
    expect(await decisions(id)).toEqual([{ decision: "approved", decided_by: USER_A_MEMBER }]);
    const after = discord.channel.get(mid)!;
    expect(after.components).toEqual([]);
    expect(JSON.stringify(after)).toContain(`Approved by <@${A_MEMBER}> at 20`);
    expect(JSON.stringify(after)).toContain('"allowed_mentions":{"parse":[]}');

    // A second press from a stale copy of the message that still has its buttons.
    expect((await pressAs(mid, "gaugeline_approve", A_OWNER)).status).toBe(200);
    expect(await decisions(id)).toHaveLength(1);
    expect(discord.private.get(A_OWNER)?.at(-1)).toMatch(/already approved/);
  });

  it("declining records a decline and says so in the message", async () => {
    const { id, mid } = await proposal();
    await pressAs(mid, "gaugeline_decline", A_OWNER);
    expect(await decisions(id)).toEqual([{ decision: "declined", decided_by: USER_A_OWNER }]);
    expect(shown(mid)).toMatch(/Declined by <@800000000000000021>.*Nothing will be applied/);
  });

  it("a stranger and a client viewer get a private reply, nothing is recorded, the message is unchanged", async () => {
    const { id, mid } = await proposal();
    const before = shown(mid);
    await pressAs(mid, "gaugeline_approve", "800000000000000099");
    await pressAs(mid, "gaugeline_approve", A_CLIENT);
    await pressAs(mid, "gaugeline_decline", A_CLIENT);
    expect(await decisions(id)).toHaveLength(0);
    expect(shown(mid)).toBe(before);
    expect(discord.private.get("800000000000000099")?.at(-1)).toMatch(/not linked/);
    expect(discord.private.get(A_CLIENT)?.at(-1)).toMatch(/not allowed/);
  });

  it("another organisation's draft in a button is not available through this connection", async () => {
    const theirs = await proposal(ORG_B, SITE_B1);
    await pressAs(theirs.mid, "gaugeline_approve", A_OWNER);
    expect(await decisions(theirs.id)).toHaveLength(0);
    expect(discord.private.get(A_OWNER)?.at(-1)).toMatch(/not available/);
  });

  it("another server, or a direct message, decides nothing", async () => {
    const { id, mid } = await proposal();
    await pressAs(mid, "gaugeline_approve", A_MEMBER, { guild: "700000000000000999" });
    expect((await pressAs(mid, "gaugeline_approve", A_MEMBER, { guild: null })).status).toBe(400);
    expect(await decisions(id)).toHaveLength(0);
  });

  it("an unsigned, wrongly signed, stale, replayed, oversized or tampered request is refused before anything is read", async () => {
    const { id, mid } = await proposal();
    const status = async (p: Signed) => (await send(p)).status;
    expect(
      await status(
        discord.press(mid, "gaugeline_approve", A_MEMBER, {
          key: generateKeyPairSync("ed25519").privateKey,
        }),
      ),
    ).toBe(401);
    expect(
      await status(
        discord.press(mid, "gaugeline_approve", A_MEMBER, {
          timestamp: Math.floor(Date.now() / 1000) - 400,
        }),
      ),
    ).toBe(401);
    const unsigned = discord.press(mid, "gaugeline_approve", A_MEMBER);
    delete unsigned.headers["x-signature-ed25519"];
    expect(await status(unsigned)).toBe(401);
    const tampered = discord.press(mid, "gaugeline_approve", A_MEMBER);
    tampered.body = tampered.body.replace(A_MEMBER, A_OWNER);
    expect(await status(tampered)).toBe(401);
    const big = discord.press(mid, "gaugeline_approve", A_MEMBER, {
      mutate: (p) => (p.padding = "a".repeat(70_000)),
    });
    expect(await status(big)).toBe(413);
    expect(await decisions(id)).toHaveLength(0);
    const real = discord.press(mid, "gaugeline_approve", A_MEMBER);
    expect(await status(real)).toBe(200);
    expect(await status(real)).toBe(401); // a replay
    expect(await decisions(id)).toHaveLength(1);
  });

  it("a signed body in any content type but JSON is a 400 before anything is claimed or looked up", async () => {
    const { id, mid } = await proposal();
    const p = discord.press(mid, "gaugeline_approve", A_MEMBER);
    for (const type of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "application/json-evil",
      "",
    ]) {
      const headers = { ...p.headers };
      if (type) headers["content-type"] = type;
      else delete headers["content-type"];
      expect((await send({ ...p, headers })).status, type).toBe(400);
    }
    expect(await decisions(id)).toHaveLength(0);
    // The same signed request as JSON is still accepted: the refusals used up no replay key.
    expect(
      (
        await send({
          ...p,
          headers: { ...p.headers, "content-type": "application/json; charset=utf-8" },
        })
      ).status,
    ).toBe(200);
    expect(await decisions(id)).toHaveLength(1);
  });

  it("a button of another application is acknowledged and changes nothing; a Slack connection does not answer here", async () => {
    const { id, mid } = await proposal();
    const res = await send(discord.press(mid, "x", A_MEMBER, { customId: "someone_elses_button" }));
    expect(await res.json()).toEqual({ type: 6 });
    expect(await decisions(id)).toHaveLength(0);
    const slackConn = (
      await connectChat(
        { sql: owner, secrets: vaultSecretStore(owner) },
        {
          orgId: ORG_A,
          provider: "slack",
          label: "s",
          workspaceRef: "T0NORTHGATE",
          signingSecret: "slack-signing-secret-x",
        },
      )
    ).connectionId;
    expect((await send(discord.press(mid, "gaugeline_approve", A_MEMBER), slackConn)).status).toBe(
      401,
    );
    expect(typeof SLACK_POST).toBe("function");
  });

  describe("a connection must name its workspace", () => {
    const secrets = () => vaultSecretStore(owner);
    const input = (over: Record<string, unknown> = {}) => ({
      orgId: ORG_B,
      provider: "discord" as const,
      label: "Brightfield Discord",
      workspaceRef: "700000000000000002",
      signingSecret: new FakeDiscord("1").publicKeyHex,
      ...over,
    });
    it("is refused without one, or with one of the wrong shape, and nothing is stored", async () => {
      for (const workspaceRef of ["", "abc", "<x>", "1".repeat(40), undefined as unknown as string])
        await expect(
          connectChat({ sql: owner, secrets: secrets() }, input({ workspaceRef })),
          String(workspaceRef),
        ).rejects.toThrow(ConnectError);
      for (const provider of ["teams" as const])
        await expect(
          connectChat({ sql: owner, secrets: secrets() }, input({ provider })),
        ).rejects.toThrow(/cannot be connected yet/);
      await expect(
        connectChat({ sql: owner, secrets: secrets() }, input({ signingSecret: "not hex" })),
      ).rejects.toThrow(/signing value/);
      await expect(
        connectChat({ sql: owner, secrets: secrets() }, input({ label: "" })),
      ).rejects.toThrow(/label/);
      expect(
        await owner`select 1 from private.secret_refs where org_id = ${ORG_B} and name like 'chat-%'`,
      ).toHaveLength(0);
    });
    it("connecting the same workspace again keeps one connection and rotates the secret", async () => {
      const a = await connectChat({ sql: owner, secrets: secrets() }, input());
      const b = await connectChat(
        { sql: owner, secrets: secrets() },
        input({ signingSecret: new FakeDiscord("1").publicKeyHex }),
      );
      expect(b.connectionId).toBe(a.connectionId);
      expect(
        await owner`select 1 from public.chat_connections where org_id = ${ORG_B}`,
      ).toHaveLength(1);
    });
    it("a connection row written without one decides nothing (fails closed)", async () => {
      const id = randomUUID();
      await owner`insert into public.chat_connections (id, org_id, provider, label, secret_name)
        values (${id}, ${ORG_A}, 'discord', 'no workspace', (select secret_name from public.chat_connections where id = ${CONN}))`;
      await owner`insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id, confirmed_at) values (${ORG_A}, ${id}, ${A_OWNER}, ${USER_A_OWNER}, now())`;
      const d = await proposal();
      const login = postgres(process.env.GAUGELINE_CHAT_DATABASE_URL!, {
        max: 1,
        onnotice: () => {},
      });
      try {
        const r = await decideFromChat(
          { sql: login, queue: new MemoryApplyQueue() },
          { id, orgId: ORG_A, provider: "discord", workspaceRef: null },
          { chatUserId: A_OWNER, workspace: null, draftId: d.id, choice: "approve" },
        );
        expect(r).toEqual({ status: "wrong-workspace" });
        expect(await decisions(d.id)).toHaveLength(0);
      } finally {
        await login.end();
      }
    });
  });

  describe("posting a proposal", () => {
    it("goes only to a Discord webhook; any other address is refused and nothing is sent", async () => {
      const req = { site: "Bar", kind: "email", title: "Subject", draftId: DRAFT };
      let sent = 0;
      for (const url of [
        "https://evil.test/api/webhooks/1/x",
        "http://discord.com/api/webhooks/800000000000000001/" + "a".repeat(40),
        "",
      ])
        expect(
          (await sendDiscordApprovalRequest(url, req, async () => (sent++, { ok: true }))).ok,
        ).toBe(false);
      expect(sent).toBe(0);
      expect(
        (await sendDiscordApprovalRequest(WEBHOOK, req, async () => (sent++, { ok: true }))).ok,
      ).toBe(true);
    });
  });
});
