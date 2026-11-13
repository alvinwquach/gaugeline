import { describe, expect, it } from "vitest";
import {
  APPROVE_ACTION,
  checkSlackResponseUrl,
  DECLINE_ACTION,
  EDIT_ACTION,
  slackApprovalMessage,
  slackDecidedMessage,
  slackPrivateReply,
  type ApprovalRequest,
} from "../slack-approval.js";

const DRAFT = "a1d10000-0000-4000-8000-0000000000a1";
const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  site: "The Tidewater Bar",
  kind: "pull_request",
  title: "Point the menu link at /drinks",
  draftId: DRAFT,
  inboxUrl: "https://app.example/inbox/" + DRAFT,
  ...over,
});
const elements = (m: ReturnType<typeof slackApprovalMessage>) =>
  (m.blocks[1]!.elements ?? []) as {
    action_id: string;
    value?: string;
    url?: string;
    style?: string;
    text: { text: string };
  }[];

describe("slackApprovalMessage", () => {
  it("offers Approve, Edit first and Decline; the two decisions carry only the draft's id", () => {
    const m = slackApprovalMessage(request());
    expect(m.blocks.map((b) => b.type)).toEqual(["section", "actions"]);
    expect(elements(m).map((e) => [e.text.text, e.action_id, e.value, e.url, e.style])).toEqual([
      ["Approve", APPROVE_ACTION, DRAFT, undefined, "primary"],
      ["Edit first", EDIT_ACTION, undefined, "https://app.example/inbox/" + DRAFT, undefined],
      ["Decline", DECLINE_ACTION, DRAFT, undefined, "danger"],
    ]);
    expect(m.blocks[0]!.text!.text).toBe(
      "*Gaugeline proposes a pull request for The Tidewater Bar*\nPoint the menu link at /drinks",
    );
    expect(m.text).toBe(
      "Gaugeline proposes a pull request for The Tidewater Bar: Point the menu link at /drinks",
    );
  });

  it("shows page and agent text as text: no mention, link or emphasis survives", () => {
    const m = slackApprovalMessage(
      request({
        site: "Bar <!channel> *bold*",
        title: "<@U0OWNER> <https://evil.test|click> ~x~ _y_ `z`",
      }),
    );
    const text = m.blocks[0]!.text!.text;
    expect(text).not.toMatch(/<[!@h]/);
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).not.toMatch(/[~`]|(?<!^)\*(?!\*)bold/);
  });

  it("names no site when the caller has none", () => {
    const m = slackApprovalMessage(request({ site: undefined }));
    expect(m.blocks[0]!.text!.text.startsWith("*Gaugeline proposes a pull request*\n")).toBe(true);
  });

  it("leaves out Edit first when the address is not a plain web address", () => {
    for (const inboxUrl of [
      undefined,
      "javascript:alert(1)",
      ["https://u:p", "app.example/x"].join("@"),
      "not a url",
      "ftp://x.test/",
    ])
      expect(elements(slackApprovalMessage(request({ inboxUrl }))).map((e) => e.action_id)).toEqual(
        [APPROVE_ACTION, DECLINE_ACTION],
      );
  });

  it("refuses a draft id that is not a UUID, and cuts a long title", () => {
    expect(() => slackApprovalMessage(request({ draftId: "x" }))).toThrow(/UUID/);
    const m = slackApprovalMessage(request({ title: "t".repeat(5000) }));
    expect(m.blocks[0]!.text!.text.length).toBeLessThan(400);
  });
});

describe("slackDecidedMessage", () => {
  const at = new Date("2026-11-13T09:00:00Z");
  it("replaces the message: no buttons, who decided, when, and what happens next", () => {
    const m = slackDecidedMessage(request(), { decision: "approved", by: "U0MEMBER", at });
    expect(m.replace_original).toBe(true);
    expect(m.blocks.map((b) => b.type)).toEqual(["section", "context"]);
    expect(JSON.stringify(m)).not.toContain("gaugeline_approve");
    expect(m.blocks[1]!.text!.text).toBe(
      "Approved by <@U0MEMBER> at 2026-11-13T09:00:00.000Z. Your own worker applies it next; nothing changes until it does.",
    );
    expect(
      slackDecidedMessage(request(), { decision: "declined", by: "U0MEMBER", at }).blocks[1]!.text!
        .text,
    ).toContain("Nothing will be applied.");
  });

  it("never puts anything but a Slack user id inside a mention", () => {
    const m = slackDecidedMessage(request(), { decision: "approved", by: "U0X> <!channel", at });
    expect(JSON.stringify(m)).not.toContain("<!channel");
    expect(m.blocks[1]!.text!.text).toContain("by a teammate");
  });
});

describe("slackPrivateReply", () => {
  it("is shown to the clicker only and leaves the message alone, with text escaped", () => {
    const r = slackPrivateReply("Not allowed <!channel>");
    expect(r).toMatchObject({ response_type: "ephemeral", replace_original: false });
    expect(r.text).toContain("&lt;!channel&gt;");
  });
});

describe("checkSlackResponseUrl", () => {
  it("accepts Slack's own response address and nothing else", () => {
    const good = "https://hooks.slack.com/actions/T0NORTHGATE/123456789/abcDEF123";
    expect(checkSlackResponseUrl(good)).toEqual({
      ok: true,
      endpoint: good,
      host: "hooks.slack.com",
    });
    for (const bad of [
      "http://hooks.slack.com/actions/T0/1/a",
      "https://hooks.slack.com.evil.test/actions/T0/1/a",
      "https://hooks.slack.com:8443/actions/T0/1/a",
      ["https://u:p", "hooks.slack.com/actions/T0/1/a"].join("@"),
      "https://hooks.slack.com/services/T0/B0/a",
      "https://hooks.slack.com/actions/T0/1/a?x=1",
      "https://hooks.slack.com/actions/T0/1/a#x",
      "https://127.0.0.1/actions/T0/1/a",
      "https://hooks.slack.com/actions/T0/notnumber/a",
      "not a url",
      "",
      42,
      null,
    ])
      expect(checkSlackResponseUrl(bad), String(bad)).toMatchObject({ ok: false });
  });
});
