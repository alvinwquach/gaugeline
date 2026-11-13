/**
 * X75, integration against the stand-in mailbox: an approved email draft becomes one Gmail draft, nothing
 * is sent, and each refusal (no approval, a changed payload, an expired approval, a recipient that is not
 * the customer's, a stop, a revoked token) leaves a trail entry and no request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEmailDraft } from "../gmail/apply.js";
import { APPROVAL_TTL_MS } from "../approval.js";
import type { Approval, TrailEntry } from "../types.js";
import { KILL_SWITCH_ENV } from "../switches.js";
import { HOUR, NOW, OTHER_ORG, OTHER_SITE, sha256 } from "./helpers.js";
import { CONTACTS, GMAIL_TOKEN, MAIL, mailJob, mailRig } from "./gmail-helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("an approved email draft is saved in the mailbox's Drafts", () => {
  it("creates one draft addressed to the configured contacts, and records its id", async () => {
    const r = mailRig();
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out).toMatchObject({ outcome: "applied", ref: "r1000", decisionId: r.job.decisionId });
    expect(r.gmail.requests).toHaveLength(1);
    expect(r.gmail.unexpected).toEqual([]);
    const [d] = r.gmail.drafts;
    expect(d!.to).toEqual(CONTACTS);
    expect(d!.subject).toBe(MAIL.subject);
    expect(d!.text).toBe(MAIL.body.replace(/\n/g, "\r\n"));
    expect(r.log).toEqual([out]);
    expect(r.lookups).toEqual([r.job.decisionId]);
  });

  it("makes no call to send: the stand-in saw exactly one drafts.create and nothing else", async () => {
    const r = mailRig();
    await applyEmailDraft(r.job, r.deps);
    expect(r.gmail.requests.map((q) => `${q.method} ${new URL(q.url).pathname}`)).toEqual([
      "POST /gmail/v1/users/me/drafts",
    ]);
    expect(r.gmail.unexpected).toEqual([]);
  });

  it("an edited approval is an approval too, and sends the edited text the approval hashes", async () => {
    const edited = { ...MAIL, subject: "Tidewater Bar: two things fixed this week" };
    const j = mailJob(edited);
    const r = mailRig({}, j, { decision: "edited" });
    expect((await applyEmailDraft(j, r.deps)).outcome).toBe("applied");
    expect(r.gmail.drafts[0]!.subject).toBe(edited.subject);
  });

  it("neutralises page text in the body (N17): bidi controls go, zero-width marks show, ANSI goes", async () => {
    const hostile = {
      subject: "Findings this week",
      body: "Quote from the page: \u202Eevil\u202C and zero\u200Bwidth and \u001b[2Jclear\n\u{E0041}tag",
    };
    // The payload shape refuses control characters outright (C0 and C1): a raw escape never gets this far.
    const refused = mailRig({}, mailJob({ ...hostile }));
    expect((await applyEmailDraft(refused.job, refused.deps)).reason).toBe("payload");
    expect(refused.gmail.requests).toEqual([]);
    // Bidi controls, zero-width characters and tag characters are valid prose: the writer cleans them.
    const clean = { ...hostile, body: hostile.body.replace("\u001b[2J", "") };
    const r = mailRig({}, mailJob(clean));
    expect((await applyEmailDraft(r.job, r.deps)).outcome).toBe("applied");
    const text = r.gmail.drafts[0]!.text;
    expect(text).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u{E0000}-\u{E007F}]/u);
    expect(text).toContain("zero\\u{200B}width");
    expect(text).toContain("evil");
  });

  it("the body keeps its paragraphs and its link as the person approved them", async () => {
    const r = mailRig();
    await applyEmailDraft(r.job, r.deps);
    expect(r.gmail.drafts[0]!.text).toContain(
      "\r\n\r\nThe finding: https://reports.northgate-studio.example/tidewater-bar/f/3\r\n\r\n",
    );
  });
});

describe("a job is refused, with one trail entry and no request, unless its approval is good", () => {
  const cases: [string, Partial<Approval> | null, string][] = [
    ["there is no approval row", null, "approval"],
    ["the row is a decline", { decision: "declined" }, "approval"],
    [
      "the approved hash is another payload's (a stale approval)",
      { payloadSha256: sha256("{}") },
      "hash",
    ],
    ["the row is for another draft", { draftId: "a1d10000-0000-4000-8000-0000000000a2" }, "draft"],
    ["the row is for another organisation", { orgId: OTHER_ORG }, "org"],
    ["the row is for another site", { siteId: OTHER_SITE }, "site"],
    ["the row is for another kind", { kind: "pull_request" }, "kind"],
    ["a decline follows the approval", { later: ["declined"] }, "withdrawn"],
    [
      "the approval is 72 hours old",
      { decidedAt: new Date(NOW.getTime() - APPROVAL_TTL_MS) },
      "expired",
    ],
    [
      "the record's own expiry has passed",
      { expiresAt: new Date(NOW.getTime() - HOUR) },
      "expired",
    ],
  ];
  for (const [name, approval, reason] of cases)
    it(`when ${name}`, async () => {
      const r = mailRig({}, mailJob(), approval);
      const out = await applyEmailDraft(r.job, r.deps);
      expect(out).toMatchObject({ outcome: "refused", reason });
      expect(r.gmail.requests).toEqual([]);
      expect(r.log).toEqual([out]);
    });

  it("when the payload text was changed after the approval (the job carries the new text, the row the old hash)", async () => {
    const j = mailJob();
    const changed = JSON.stringify({ ...MAIL, body: `${MAIL.body}\nP.S. send me your login.` });
    const r = mailRig({}, { ...j, payloadText: changed }, { payloadSha256: j.payloadSha256 });
    const out = await applyEmailDraft({ ...j, payloadText: changed }, r.deps);
    expect(out).toMatchObject({ outcome: "refused", reason: "hash" });
    expect(r.gmail.requests).toEqual([]);
  });

  it("when only the subject is changed, the hash differs (the approval covers subject and body)", async () => {
    const j = mailJob();
    const changed = JSON.stringify({ ...MAIL, subject: "Urgent: wire transfer" });
    const forged = { ...j, payloadText: changed, payloadSha256: sha256(changed) };
    const r = mailRig({}, j);
    const out = await applyEmailDraft(forged, r.deps);
    expect(out).toMatchObject({ outcome: "refused", reason: "hash" });
  });

  it("when the job is a pull request, not an email", async () => {
    const r = mailRig({}, mailJob(MAIL, { kind: "pull_request" }));
    expect((await applyEmailDraft(r.job, r.deps)).reason).toBe("kind");
  });

  it("when the lookup throws (the database is down)", async () => {
    const r = mailRig();
    r.deps.approvals = {
      find: async () => {
        throw new Error("connection lost");
      },
    };
    expect((await applyEmailDraft(r.job, r.deps)).reason).toBe("approval");
    expect(r.gmail.requests).toEqual([]);
  });
});

describe("the payload is checked again before anything is built", () => {
  const bad: [string, unknown][] = [
    ["a recipient in the payload", { ...MAIL, to: "someone-else@evil.example" }],
    ["a cc in the payload", { ...MAIL, cc: "spy@evil.example" }],
    ["a bcc in the payload", { ...MAIL, bcc: "spy@evil.example" }],
    ["a CRLF in the subject", { ...MAIL, subject: "hi\r\nBcc: spy@evil.example" }],
    ["a bidi override in the subject", { ...MAIL, subject: "invoice \u202Egnp.exe" }],
    ["an empty subject", { ...MAIL, subject: "" }],
    ["a body that is not text", { ...MAIL, body: 5 }],
    ["a missing body", { subject: MAIL.subject }],
  ];
  for (const [name, payload] of bad)
    it(`refuses ${name}`, async () => {
      const r = mailRig({}, mailJob(payload));
      const out = await applyEmailDraft(r.job, r.deps);
      expect(out).toMatchObject({ outcome: "refused", reason: "payload" });
      expect(r.gmail.requests).toEqual([]);
    });

  it("refuses payload text that is not JSON, even with a matching hash", async () => {
    const text = "{not json";
    const j = mailJob(MAIL, { payloadText: text, payloadSha256: sha256(text) });
    const r = mailRig({}, j);
    expect((await applyEmailDraft(j, r.deps)).reason).toBe("payload");
  });
});

describe("recipients come from the customer's configured contacts, never from the payload", () => {
  it("refuses a target whose contact is not a plain address, whatever else is true", async () => {
    for (const contacts of [
      ["Maya <maya@tidewater-bar.example>"],
      ["maya@tidewater-bar.example\r\nBcc: spy@evil.example"],
      ["maya@tidewater-bar.example,spy@evil.example"],
      [],
      Array.from({ length: 6 }, (_, i) => `c${i}@tidewater-bar.example`),
    ]) {
      const r = mailRig();
      r.deps.target = { ...r.deps.target, contacts };
      const out = await applyEmailDraft(r.job, r.deps);
      expect(out, JSON.stringify(contacts)).toMatchObject({ outcome: "refused", reason: "target" });
      expect(r.gmail.requests).toEqual([]);
    }
  });

  it("a sender built for other contacts refuses the draft before the network (the second guard)", async () => {
    const { gmailSender } = await import("../gmail/send.js");
    const r = mailRig();
    r.deps.createDraft = gmailSender(r.tok.source, ["someone-else@tidewater-bar.example"]);
    expect(await applyEmailDraft(r.job, r.deps)).toMatchObject({
      outcome: "refused",
      reason: "registry",
    });
    expect(r.gmail.requests).toEqual([]);
  });

  it("leaves out an address that bounced last time, and says nothing about it in the trail", async () => {
    const r = mailRig();
    r.deps.target = { ...r.deps.target, bounced: [CONTACTS[0]!.toUpperCase()] };
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out.outcome).toBe("applied");
    expect(r.gmail.drafts[0]!.to).toEqual([CONTACTS[1]]);
  });

  it("refuses when every contact bounced: there is nobody to address", async () => {
    const r = mailRig();
    r.deps.target = { ...r.deps.target, bounced: CONTACTS };
    expect(await applyEmailDraft(r.job, r.deps)).toMatchObject({
      outcome: "refused",
      reason: "recipient",
    });
    expect(r.gmail.requests).toEqual([]);
  });
});

describe("dry run is the default, and a stop stops", () => {
  it("a dry run builds the request, checks it, sends nothing and records the plan", async () => {
    const r = mailRig({ mode: "dry-run" });
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out).toMatchObject({
      outcome: "dry_run",
      planned: [{ endpoint: "createDraft", path: "/gmail/v1/users/me/drafts" }],
    });
    expect(out.ref).toBeUndefined();
    expect(r.gmail.requests).toEqual([]);
    expect(r.tok.t.reads).toBe(0);
  });

  it("the kill switch stops it before the request, and the organisation's pause too", async () => {
    for (const over of [{ env: { [KILL_SWITCH_ENV]: "1" } }, { orgPaused: async () => true }]) {
      const r = mailRig(over);
      const out = await applyEmailDraft(r.job, r.deps);
      expect(out.outcome).toBe("refused");
      expect(["kill switch", "organisation paused"]).toContain(out.reason);
      expect(r.gmail.requests).toEqual([]);
    }
  });

  it("a pause that flips on after the checks and before the request stops the request", async () => {
    let calls = 0;
    const r = mailRig({
      orgPaused: async () => {
        calls += 1;
        return calls > 1;
      },
    });
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out).toMatchObject({ outcome: "refused", reason: "organisation paused" });
    expect(r.gmail.requests).toEqual([]);
  });
});

describe("a draft is created once for one approval", () => {
  it("a second apply of the same approval creates no second draft", async () => {
    const r = mailRig();
    const first = await applyEmailDraft(r.job, r.deps);
    const second = await applyEmailDraft(r.job, r.deps);
    expect(first.outcome).toBe("applied");
    expect(second).toMatchObject({ outcome: "refused", reason: "duplicate" });
    expect(r.gmail.drafts).toHaveLength(1);
  });

  it("two applies at the same moment create one draft", async () => {
    const r = mailRig();
    const [a, b] = await Promise.all([
      applyEmailDraft(r.job, r.deps),
      applyEmailDraft(r.job, r.deps),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["applied", "refused"]);
    expect(r.gmail.drafts).toHaveLength(1);
  });

  it("a record that already says applied (another worker, a restart) creates none", async () => {
    const r = mailRig({}, mailJob(), { later: ["applied"] });
    expect(await applyEmailDraft(r.job, r.deps)).toMatchObject({
      outcome: "refused",
      reason: "duplicate",
    });
    expect(r.gmail.requests).toEqual([]);
  });

  it("a failed attempt may be tried again: Gmail refused it, so there is no draft yet", async () => {
    const r = mailRig();
    r.gmail.state.status = 500;
    const first = await applyEmailDraft(r.job, r.deps);
    expect(first).toMatchObject({ outcome: "apply_failed", status: 500 });
    r.gmail.state.status = 0;
    expect((await applyEmailDraft(r.job, r.deps)).outcome).toBe("applied");
    expect(r.gmail.drafts).toHaveLength(1);
  });
});

describe("a revoked or removed token leaves the draft in the inbox with a note to reconnect", () => {
  it("a 401 from Gmail is apply_failed with the reason reconnect, and the draft is not created", async () => {
    const r = mailRig();
    r.gmail.state.revoked = true;
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out).toMatchObject({ outcome: "apply_failed", status: 401, reason: "reconnect" });
    expect(r.gmail.drafts).toEqual([]);
    expect(r.log).toEqual([out]);
  });

  it("a 403 is the same", async () => {
    const r = mailRig();
    r.gmail.state.status = 403;
    expect(await applyEmailDraft(r.job, r.deps)).toMatchObject({
      status: 403,
      reason: "reconnect",
    });
  });

  it("disconnecting removes the token at once: the next apply is refused with no request", async () => {
    const r = mailRig();
    r.tok.t.current = null;
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out).toMatchObject({ outcome: "refused", reason: "disconnected" });
    expect(r.gmail.requests).toEqual([]);
  });

  it("other failures keep their status and are not called a reconnect", async () => {
    const r = mailRig();
    r.gmail.state.status = 429;
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out).toMatchObject({ outcome: "apply_failed", status: 429 });
    expect(out.reason).toBeUndefined();
  });

  it("a network failure leaves an apply_failed entry with no status, then the error goes on", async () => {
    const r = mailRig();
    r.gmail.state.redirect = true;
    await expect(applyEmailDraft(r.job, r.deps)).rejects.toThrow();
    expect(r.log).toEqual([expect.objectContaining({ outcome: "apply_failed" })]);
    expect(r.log[0]!.status).toBeUndefined();
  });
});

describe("what is recorded and what is said", () => {
  const everything = (r: ReturnType<typeof mailRig>, extra: unknown[] = []) =>
    JSON.stringify([r.log, extra, r.gmail.requests.map((q) => q.url)]);

  it("the token is never in the trail, a refusal, an error or a request address", async () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    for (const setup of [
      (r: ReturnType<typeof mailRig>) => void r,
      (r: ReturnType<typeof mailRig>) => void (r.gmail.state.revoked = true),
      (r: ReturnType<typeof mailRig>) => void (r.gmail.state.status = 500),
    ]) {
      const r = mailRig();
      setup(r);
      const out = await applyEmailDraft(r.job, r.deps);
      expect(everything(r, [out])).not.toContain(GMAIL_TOKEN);
    }
    expect(logs.join("\n")).not.toContain(GMAIL_TOKEN);
    vi.restoreAllMocks();
  });

  it("Gmail's answer is never echoed: a failure records the status, not the text", async () => {
    const r = mailRig();
    r.gmail.state.status = 400;
    r.gmail.state.replyBody = { error: { message: "ECHO-ME-IF-YOU-DARE", token: GMAIL_TOKEN } };
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out).toMatchObject({ outcome: "apply_failed", status: 400 });
    expect(everything(r, [out])).not.toContain("ECHO-ME-IF-YOU-DARE");
  });

  it("the subject and the body are not in the trail", async () => {
    const r = mailRig();
    await applyEmailDraft(r.job, r.deps);
    const text = everything(r);
    expect(text).not.toContain(MAIL.subject);
    expect(text).not.toContain("drinks link");
    expect(text).not.toContain(CONTACTS[0]!);
  });

  it("a draft id Gmail returns that is not a plain id is not recorded", async () => {
    const r = mailRig();
    r.gmail.state.status = 200;
    r.gmail.state.replyBody = { id: "../../x\r\nBcc: y" };
    const out = await applyEmailDraft(r.job, r.deps);
    expect(out.outcome).toBe("applied");
    expect(out.ref).toBeUndefined();
  });
});

export type { TrailEntry };
