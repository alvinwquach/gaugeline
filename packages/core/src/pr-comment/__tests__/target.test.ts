/** Which pull request a run is for, from what the workflow gives it. Pure: the CLI reads the event file. */
import { describe, expect, it } from "vitest";
import { commentTargetFrom } from "../target.js";

const EVENT = { action: "synchronize", number: 12, pull_request: { number: 12 } };
const ok = {
  eventName: "pull_request",
  repository: "brightside-studio/site",
  token: "demo",
  event: EVENT,
};

describe("commentTargetFrom", () => {
  it("takes the repository and the pull request's number", () => {
    expect(commentTargetFrom(ok)).toEqual({
      ok: true,
      target: { owner: "brightside-studio", repo: "site", pullNumber: 12 },
    });
  });

  it("is only for a pull_request event: no other event, and never pull_request_target", () => {
    for (const eventName of [
      "push",
      "pull_request_target",
      "issue_comment",
      "workflow_dispatch",
      "deployment_status",
      "Pull_Request",
      "",
      undefined,
    ])
      expect(commentTargetFrom({ ...ok, eventName }), String(eventName)).toEqual({
        ok: false,
        reason: "not-a-pull-request",
      });
  });

  it("needs a token", () => {
    for (const token of [undefined, "", "   "])
      expect(commentTargetFrom({ ...ok, token })).toEqual({ ok: false, reason: "no-token" });
  });

  it("refuses a repository that is not owner/name", () => {
    for (const repository of [
      undefined,
      "",
      "site",
      "a/b/c",
      "/site",
      "a/",
      "a b/c",
      "../x",
      "a/..",
    ])
      expect(commentTargetFrom({ ...ok, repository }), String(repository)).toEqual({
        ok: false,
        reason: "bad-repository",
      });
  });

  it("refuses an event with no pull request number, or one that is not a whole positive number", () => {
    for (const event of [
      undefined,
      null,
      "text",
      [],
      {},
      { pull_request: {} },
      { pull_request: { number: "12" } },
      { pull_request: { number: 0 } },
      { pull_request: { number: -1 } },
      { pull_request: { number: 1.5 } },
      { pull_request: { number: Number.MAX_SAFE_INTEGER + 2 } },
      { number: 12 },
    ])
      expect(commentTargetFrom({ ...ok, event }), JSON.stringify(event)).toEqual({
        ok: false,
        reason: "bad-event",
      });
  });
});
