/**
 * ADR-0010 part 3: the job is a claim. The writer reads the approval row itself and refuses unless the row
 * exists, is an approval, is this job's draft, organisation, site and kind, hashes to this payload, has
 * not been withdrawn and is under 72 hours old. Each refusal has its own test, so removing any one check
 * fails exactly one of them.
 */
import { describe, expect, it } from "vitest";
import { APPROVAL_TTL_MS, applyPullRequest } from "../github/apply.js";
import { KILL_SWITCH_ENV, stopReason } from "../switches.js";
import type { Approval, ApplyJob } from "../types.js";
import {
  DRAFT,
  HOUR,
  NOW,
  OTHER_ORG,
  OTHER_SITE,
  PAYLOAD,
  deps,
  fakeGithub,
  job,
  sha256,
} from "./helpers.js";

/** Run `j` against an approval row with `approval` changed; return the entry and what was sent. */
async function run(
  j: ApplyJob,
  approval: Partial<Approval> | null,
  over: Partial<Parameters<typeof deps>[0]> = {},
) {
  const gh = fakeGithub();
  const d = deps({ send: gh.send, ...over }, j, approval);
  const out = await applyPullRequest(j, d);
  return { out, sent: gh.sent, d };
}

describe("the writer reads the approval row itself (ADR-0010 part 3.2)", () => {
  it("applies when the row matches the job in every field", async () => {
    const { out, sent, d } = await run(job(), {});
    expect(out.outcome).toBe("applied");
    expect(sent.length).toBeGreaterThan(0);
    expect(d.lookups).toEqual(["42"]);
  });

  it("an edited approval is an approval too", async () => {
    expect((await run(job(), { decision: "edited" })).out.outcome).toBe("applied");
  });

  it("refuses a job whose payload hashes to itself but has no approval row (forged job)", async () => {
    // The reviewer's probe: the job carries its own consistent hash, another organisation and a decision
    // id that does not exist.
    const forged = job(
      { ...PAYLOAD, title: "forged by whoever queued it" },
      {
        orgId: "SOME-OTHER-ORG",
        decisionId: "does-not-exist",
      },
    );
    const { out, sent, d } = await run(forged, null);
    expect(out).toMatchObject({ outcome: "refused", reason: "approval" });
    expect(sent).toEqual([]);
    expect(d.log).toEqual([out]);
  });

  it("refuses when the lookup throws (the database is down)", async () => {
    const j = job();
    const gh = fakeGithub();
    const d = deps({ send: gh.send }, j);
    d.approvals = {
      find: async () => {
        throw new Error("connection lost");
      },
    };
    const out = await applyPullRequest(j, d);
    expect(out).toMatchObject({ outcome: "refused", reason: "approval" });
    expect(gh.sent).toEqual([]);
    expect(d.log).toEqual([out]);
  });

  it("refuses a row that is not an approval (a decline, or anything else)", async () => {
    for (const decision of ["declined", "dry_run", "applied", ""]) {
      const { out, sent } = await run(job(), { decision });
      expect(out, decision).toMatchObject({ outcome: "refused", reason: "approval" });
      expect(sent).toEqual([]);
    }
  });

  it("refuses an approval row for another draft", async () => {
    const { out, sent } = await run(job(), { draftId: "a1d10000-0000-4000-8000-0000000000a2" });
    expect(out).toMatchObject({ outcome: "refused", reason: "draft" });
    expect(sent).toEqual([]);
  });

  it("refuses an approval row that is another decision", async () => {
    const { out, sent } = await run(job(), { decisionId: "43" });
    expect(out).toMatchObject({ outcome: "refused", reason: "draft" });
    expect(sent).toEqual([]);
  });

  it("refuses an approval recorded for another organisation", async () => {
    const { out, sent } = await run(job(), { orgId: OTHER_ORG });
    expect(out).toMatchObject({ outcome: "refused", reason: "org" });
    expect(sent).toEqual([]);
  });

  it("refuses a job for another organisation than the worker's, even with a matching approval", async () => {
    const j = job(PAYLOAD, { orgId: OTHER_ORG });
    const { out, sent } = await run(j, {});
    expect(out).toMatchObject({ outcome: "refused", reason: "org" });
    expect(sent).toEqual([]);
  });

  it("refuses an approval recorded for another site", async () => {
    const { out, sent } = await run(job(), { siteId: OTHER_SITE });
    expect(out).toMatchObject({ outcome: "refused", reason: "site" });
    expect(sent).toEqual([]);
  });

  it("refuses a job for another site than the configured target's, even with a matching approval", async () => {
    const j = job(PAYLOAD, { siteId: OTHER_SITE });
    const { out, sent } = await run(j, {});
    expect(out).toMatchObject({ outcome: "refused", reason: "site" });
    expect(sent).toEqual([]);
  });

  it("refuses an approval recorded for another kind", async () => {
    const { out, sent } = await run(job(), { kind: "email" });
    expect(out).toMatchObject({ outcome: "refused", reason: "kind" });
    expect(sent).toEqual([]);
  });

  it("refuses a payload that is not the one approved (the job's text differs from the approved hash)", async () => {
    const swapped = JSON.stringify({ ...PAYLOAD, title: "Swapped" });
    const j = job(PAYLOAD, { payloadText: swapped, payloadSha256: sha256(swapped) });
    // The approval is for the original payload; the job is internally consistent but is not it.
    const { out, sent } = await run(j, { payloadSha256: sha256(JSON.stringify(PAYLOAD)) });
    expect(out).toMatchObject({ outcome: "refused", reason: "hash" });
    expect(sent).toEqual([]);
  });

  it("refuses a job whose own hash field differs from the approval's, though its text matches", async () => {
    const j = job(PAYLOAD, { payloadSha256: sha256("something else") });
    const { out, sent } = await run(j, {});
    expect(out).toMatchObject({ outcome: "refused", reason: "hash" });
    expect(sent).toEqual([]);
  });

  it("a digest in capitals or the wrong length is not equal to the same digest in lower case", async () => {
    const j = job();
    const upper = sha256(j.payloadText).toUpperCase();
    for (const approvalHash of [upper, upper.slice(0, 62), `${sha256(j.payloadText)}00`]) {
      const { out, sent } = await run(
        { ...j, payloadSha256: approvalHash },
        {
          payloadSha256: approvalHash,
        },
      );
      expect(out, approvalHash).toMatchObject({ outcome: "refused", reason: "hash" });
      expect(sent).toEqual([]);
    }
  });

  it("refuses when a decline or a withdrawal was recorded after the approval", async () => {
    for (const later of [["declined"], ["dry_run", "withdrawn"], ["withdrawn", "applied"]]) {
      const { out, sent } = await run(job(), { later });
      expect(out, later.join()).toMatchObject({ outcome: "refused", reason: "withdrawn" });
      expect(sent).toEqual([]);
    }
  });

  it("goes on when only dry runs and failed attempts follow the approval", async () => {
    expect((await run(job(), { later: ["dry_run", "apply_failed"] })).out.outcome).toBe("applied");
  });

  it("only the outcomes the writer itself records may follow an approval: any other word counts as a withdrawal", async () => {
    for (const word of ["Withdrawn", "WITHDRAWN", "expired", "revoked", "Declined", "paused", ""]) {
      const { out, sent } = await run(job(), { later: ["dry_run", word] });
      expect(out, JSON.stringify(word)).toMatchObject({ outcome: "refused", reason: "withdrawn" });
      expect(sent).toEqual([]);
    }
    for (const word of ["dry_run", "apply_failed", "refused", "applied"]) {
      expect((await run(job(), { later: [word] })).out.outcome, word).toBe("applied");
    }
  });

  it("refuses an approval decided in the future, beyond a small clock skew", async () => {
    const future = await run(job(), { decidedAt: new Date(NOW.getTime() + 10 * 60 * 1000) });
    expect(future.out).toMatchObject({ outcome: "refused", reason: "approval" });
    expect(future.sent).toEqual([]);
    const skew = await run(job(), { decidedAt: new Date(NOW.getTime() + 60 * 1000) });
    expect(skew.out.outcome).toBe("applied");
  });

  it("refuses an approval older than 72 hours, and applies one just inside it", async () => {
    expect(APPROVAL_TTL_MS).toBe(72 * HOUR);
    const old = await run(job(), { decidedAt: new Date(NOW.getTime() - 72 * HOUR) });
    expect(old.out).toMatchObject({ outcome: "refused", reason: "expired" });
    expect(old.sent).toEqual([]);
    const fresh = await run(job(), { decidedAt: new Date(NOW.getTime() - 72 * HOUR + 1000) });
    expect(fresh.out.outcome).toBe("applied");
  });

  it("refuses an approval whose own expiry has passed, and never extends the 72 hours", async () => {
    const early = await run(job(), { expiresAt: new Date(NOW.getTime() - 1) });
    expect(early.out).toMatchObject({ outcome: "refused", reason: "expired" });
    const late = await run(job(), {
      decidedAt: new Date(NOW.getTime() - 100 * HOUR),
      expiresAt: new Date(NOW.getTime() + 100 * HOUR),
    });
    expect(late.out).toMatchObject({ outcome: "refused", reason: "expired" });
  });

  it("a dry run needs the approval too", async () => {
    const { out } = await run(job(), null, { mode: "dry-run" });
    expect(out).toMatchObject({ outcome: "refused", reason: "approval" });
  });

  it("every refusal appends exactly one trail entry that refers to the draft and decision", async () => {
    const { out, d } = await run(job(), { orgId: OTHER_ORG });
    expect(d.log).toEqual([
      { draftId: DRAFT, decisionId: "42", outcome: "refused", reason: "org" },
    ]);
    expect(out).toBe(d.log[0]);
  });
});

describe("the configured target is plain names", () => {
  const bad: Record<string, Partial<Parameters<typeof deps>[0]["target"] & object>> = {
    "an owner with a dot": { owner: ".." },
    "an owner with a slash": { owner: "acme/x" },
    "a repo called ..": { repo: ".." },
    "a repo called .": { repo: "." },
    "a repo with a slash": { repo: "a/b" },
    "an empty repo": { repo: "" },
    "a base that climbs": { base: "../../../../user" },
    "a base with a dot segment in the middle": { base: "release/../main" },
    "an empty base": { base: "" },
    "a base that is a full ref": { base: "refs/heads/main" },
    "a base with two dots in a name": { base: "a..b" },
    "a base ending .lock": { base: "main.lock" },
    "a base ending in a dot": { base: "main." },
    "a base with a space": { base: "main branch" },
    "a site that is not a uuid": { siteId: "site-1" },
    "an organisation that is not a uuid": { orgId: "org-1" },
  };
  for (const [name, change] of Object.entries(bad))
    it(`refuses ${name}, in a dry run and in a write, before it reads anything`, async () => {
      for (const mode of ["dry-run", "write"] as const) {
        const gh = fakeGithub();
        const j = job();
        const d = deps({ send: gh.send, mode }, j);
        d.target = { ...d.target, ...change };
        const out = await applyPullRequest(j, d);
        expect(out, name).toMatchObject({ outcome: "refused", reason: "target" });
        expect(gh.sent).toEqual([]);
        expect(d.lookups).toEqual([]);
      }
    });
});

describe("the draft id is a UUID", () => {
  for (const draftId of ["../main", DRAFT.toUpperCase(), `${DRAFT}x`, "", "main"])
    it(`refuses ${JSON.stringify(draftId)}`, async () => {
      // The approval row agrees with the job, so only the shape of the id can refuse it.
      const { out, sent } = await run(job(PAYLOAD, { draftId }), {});
      expect(out).toMatchObject({ outcome: "refused", reason: "kind" });
      expect(sent).toEqual([]);
    });
});

describe("the mode: only the exact word write writes", () => {
  for (const mode of ["Write", "WRITE", "write ", "true", "", undefined, null, 1] as const)
    it(`${JSON.stringify(mode)} is a dry run`, async () => {
      const { out, sent } = await run(job(), {}, { mode: mode as never });
      expect(sent).toEqual([]);
      expect(out.outcome).toBe("dry_run");
    });
});

describe("the kill switches fail closed and read the value strictly", () => {
  const stops = (v: string | undefined) =>
    stopReason({ env: { [KILL_SWITCH_ENV]: v }, orgPaused: async () => false });

  for (const v of ["1", "true", "yes", "false", "off", "no", " 0", "0 ", "00", "stop"])
    it(`${JSON.stringify(v)} stops`, async () => {
      expect(await stops(v)).toBe("kill switch");
    });
  for (const v of [undefined, "", "0"])
    it(`${JSON.stringify(v)} goes on`, async () => {
      expect(await stops(v)).toBeNull();
    });

  it("an unreadable organisation pause stops the job and leaves a trail entry", async () => {
    const j = job();
    const gh = fakeGithub();
    const d = deps(
      {
        send: gh.send,
        orgPaused: async () => {
          throw new Error("db down");
        },
      },
      j,
    );
    const out = await applyPullRequest(j, d);
    expect(out).toMatchObject({ outcome: "refused", reason: "organisation paused" });
    expect(gh.sent).toEqual([]);
    expect(d.log).toEqual([out]);
  });

  it("a pause that cannot be read in the middle of a job stops it there, with a trail entry", async () => {
    const j = job();
    const gh = fakeGithub();
    let calls = 0;
    const d = deps(
      {
        send: gh.send,
        orgPaused: async () => {
          if (++calls > 2) throw new Error("db down");
          return false;
        },
      },
      j,
    );
    const out = await applyPullRequest(j, d);
    expect(gh.sent.map((r) => r.endpoint)).toEqual(["getRef"]);
    expect(out).toMatchObject({ outcome: "refused", reason: "organisation paused" });
    expect(d.log).toEqual([out]);
  });

  it("a pause that answers with anything but false stops", async () => {
    const r = await stopReason({ env: {}, orgPaused: (async () => undefined) as never });
    expect(r).toBe("organisation paused");
  });
});
