import { describe, expect, it } from "vitest";
import {
  checkDiscordWebhook,
  DISCORD_ACK,
  DISCORD_PONG,
  discordApprovalMessage,
  discordDecidedData,
  discordPrivateReply,
  discordUpdateMessage,
} from "../discord-approval.js";
import type { ApprovalRequest } from "../slack-approval.js";

const DRAFT = "a1d10000-0000-4000-8000-0000000000a1";
const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  site: "The Tidewater Bar",
  kind: "pull_request",
  title: "Point the menu link at /drinks",
  draftId: DRAFT,
  inboxUrl: "https://app.example/inbox/" + DRAFT,
  ...over,
});
type Button = { type: number; style: number; label: string; custom_id?: string; url?: string };
const buttons = (m: ReturnType<typeof discordApprovalMessage>) =>
  (m.components[0] as { components: Button[] }).components;

describe("discordApprovalMessage", () => {
  it("offers Approve, Edit first (a link) and Decline; a press carries the action and the draft id only", () => {
    const m = discordApprovalMessage(request());
    expect(buttons(m).map((b) => [b.label, b.style, b.custom_id, b.url])).toEqual([
      ["Approve", 3, `gaugeline_approve:${DRAFT}`, undefined],
      ["Edit first", 5, undefined, "https://app.example/inbox/" + DRAFT],
      ["Decline", 4, `gaugeline_decline:${DRAFT}`, undefined],
    ]);
    // Discord: a custom_id is 1 to 100 characters; a link button has a url and no custom_id.
    for (const b of buttons(m)) expect((b.custom_id ?? "x").length).toBeLessThanOrEqual(100);
    expect(m.allowed_mentions).toEqual({ parse: [] });
    expect(m.embeds[0]!.title).toBe("Gaugeline proposes a pull request for The Tidewater Bar");
  });

  it("shows page and agent text as text, and nothing in it can ping", () => {
    const m = discordApprovalMessage(
      request({
        site: "Bar @everyone",
        title: "<@123456789> @here [x](https://evil.test) **b** `c`",
      }),
    );
    const text = JSON.stringify(m.embeds);
    expect(m.allowed_mentions).toEqual({ parse: [] });
    expect(text).toContain("\\\\@everyone");
    expect(text).not.toMatch(/(?<!\\\\)<@1/);
    expect(text).not.toContain("](https");
  });

  it("leaves out Edit first when the address is not a plain web address", () => {
    for (const inboxUrl of [
      undefined,
      "javascript:alert(1)",
      ["https://u:p", "app.example/x"].join("@"),
      "nope",
      "ftp://x.test/",
      "https://a.test/" + "x".repeat(600),
    ])
      expect(buttons(discordApprovalMessage(request({ inboxUrl }))).map((b) => b.label)).toEqual([
        "Approve",
        "Decline",
      ]);
  });

  it("refuses a draft id that is not a UUID and cuts long text", () => {
    expect(() => discordApprovalMessage(request({ draftId: "x" }))).toThrow(/UUID/);
    expect(
      discordApprovalMessage(request({ title: "t".repeat(9000) })).embeds[0]!.description.length,
    ).toBeLessThanOrEqual(4096);
  });
});

describe("the answers to a press", () => {
  const at = new Date("2026-11-13T09:00:00Z");
  it("replaces the message in place (type 7): no buttons, who decided, when, what happens next", () => {
    const body = discordUpdateMessage(
      discordDecidedData(request(), { decision: "approved", by: "123456789012345678", at }),
    );
    expect(body.type).toBe(7);
    expect(body.data.components).toEqual([]);
    expect(body.data.embeds[0]!.description).toBe(
      "Approved by <@123456789012345678> at 2026-11-13T09:00:00.000Z. Your own worker applies it next; nothing changes until it does.",
    );
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
    const declined = discordDecidedData(request(), {
      decision: "declined",
      by: "123456789012345678",
      at,
    });
    expect(declined.embeds[0]!.description).toContain("Nothing will be applied.");
  });

  it("puts only a Discord id inside a mention", () => {
    const d = discordDecidedData(request(), { decision: "approved", by: "1> @everyone <@2", at });
    expect(JSON.stringify(d)).not.toContain("<@2");
    expect(d.embeds[0]!.description).toContain("by a teammate");
  });

  it("a private reply is ephemeral (flag 64), escaped, and pings nobody", () => {
    const r = discordPrivateReply("Not allowed @everyone");
    expect(r).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    expect(r.data.content).toContain("\\@everyone");
  });

  it("PONG and the quiet acknowledgement have Discord's types", () => {
    expect(DISCORD_PONG).toEqual({ type: 1 });
    expect(DISCORD_ACK).toEqual({ type: 6 });
  });
});

describe("checkDiscordWebhook", () => {
  it("accepts Discord's own webhook address and asks for components", () => {
    const good = ["https://discord.com/api/webhooks/123456789012345678", "a".repeat(40)].join("/");
    expect(checkDiscordWebhook(good)).toEqual({
      ok: true,
      endpoint: good + "?with_components=true",
      host: "discord.com",
    });
  });

  it("refuses anything else", () => {
    const tok = "a".repeat(40);
    for (const bad of [
      `http://discord.com/api/webhooks/123456789012345678/${tok}`,
      `https://discord.com.evil.test/api/webhooks/123456789012345678/${tok}`,
      `https://discord.com:8443/api/webhooks/123456789012345678/${tok}`,
      `https://${["u:p", "discord.com"].join("@")}/api/webhooks/123456789012345678/${tok}`,
      `https://discord.com/api/webhooks/123456789012345678/${tok}?wait=true`,
      `https://discord.com/api/webhooks/123456789012345678/${tok}#x`,
      `https://discord.com/api/webhooks/abc/${tok}`,
      `https://discord.com/api/webhooks/123456789012345678/short`,
      `https://hooks.slack.com/services/T0/B0/${tok}`,
      `https://127.0.0.1/api/webhooks/123456789012345678/${tok}`,
      "not a url",
      "",
      7,
      null,
    ])
      expect(checkDiscordWebhook(bad), String(bad)).toMatchObject({ ok: false });
  });
});
