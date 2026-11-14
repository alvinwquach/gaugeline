/**
 * AG-10, the writer's half of the red-team suite (ADR-0014): an approval is replayed, an approved draft is
 * edited, the switch is thrown. Each case asserts the worker FAILS CLOSED: it refuses, sends no request, and
 * leaves one trail entry. Test-only; the controls are listed in docs/hosted/agent-red-team.md. A fixed clock.
 */
import { describe, expect, it } from "vitest";
import { applyPullRequest } from "../github/apply.js";
import { KILL_SWITCH_ENV } from "../switches.js";
import type { Approval, ApplyJob } from "../types.js";
import { HOUR, NOW, PAYLOAD, deps, fakeGithub, job, sha256 } from "./helpers.js";

async function run(
  j: ApplyJob,
  approval: Partial<Approval> | null = {},
  over: Partial<Parameters<typeof deps>[0]> = {},
  github: Parameters<typeof fakeGithub>[0] = {},
) {
  const gh = fakeGithub(github);
  const d = deps({ send: gh.send, ...over }, j, approval);
  const out = await applyPullRequest(j, d);
  return { out, sent: gh.sent.map((r) => r.endpoint), log: d.log };
}
const WRITES = ["createRef", "putContent", "createPull"];

describe("red team: the writer (T3, T5, T7, T12)", () => {
  it("passing fixture: an approval that matches its job opens the pull request", async () => {
    const { out, sent } = await run(job());
    expect(out.outcome).toBe("applied");
    expect(sent).toEqual(expect.arrayContaining(WRITES));
  });

  // T3. Control: the approval row is read by the worker and expires after 72 hours.
  it("replayed approval (old): an approval from three days ago is refused, and nothing is sent", async () => {
    const { out, sent, log } = await run(job(), { decidedAt: new Date(NOW.getTime() - 72 * HOUR) });
    expect(out).toMatchObject({ outcome: "refused", reason: "expired" });
    expect([sent, log]).toEqual([[], [out]]);
  });

  // T3. Control: anything recorded after an approval but the writer's own outcomes ends it.
  it("replayed approval (withdrawn): an approval followed by a decline or a withdrawal is refused", async () => {
    for (const later of [["declined"], ["withdrawn"], ["applied", "declined"]]) {
      const { out, sent } = await run(job(), { later });
      expect(out, later.join()).toMatchObject({ outcome: "refused", reason: "withdrawn" });
      expect(sent).toEqual([]);
    }
  });

  // T3. Control: the draft's branch is looked up (open or closed) before a pull request is opened.
  it("replayed approval (applied): the same job sent again opens no second pull request", async () => {
    const again = await run(job(), { later: ["applied"] }, {}, { closedPull: true });
    expect(again.out).toMatchObject({ outcome: "applied", ref: expect.stringContaining("/pull/") });
    expect(again.sent.filter((e) => WRITES.includes(e))).toEqual([]);
  });

  // T5. Control: the job's text must hash to the approved hash, constant-time compared.
  it("approval of an edited draft: a payload changed after approval is refused, even with a hash to match", async () => {
    const edited = JSON.stringify({ ...PAYLOAD, title: "Edited after review" });
    for (const j of [
      job(PAYLOAD, { payloadText: edited, payloadSha256: sha256(edited) }),
      job(PAYLOAD, { payloadText: edited }),
      job(PAYLOAD, { payloadSha256: sha256(edited) }),
    ]) {
      const { out, sent, log } = await run(j, { payloadSha256: sha256(JSON.stringify(PAYLOAD)) });
      expect(out).toMatchObject({ outcome: "refused", reason: "hash" });
      expect([sent, log]).toEqual([[], [out]]);
    }
  });

  // T6. Control: the job's organisation and site must be the worker's own, and the approval's.
  it("cross-tenant job: another organisation's approval or site is refused", async () => {
    for (const over of [
      { orgId: "0b000000-0000-4000-8000-00000000000b" },
      { siteId: "5e000000-0000-4000-8000-0000000000e6" },
    ]) {
      const j = job(PAYLOAD, over);
      const { out, sent } = await run(j);
      expect(out).toMatchObject({ outcome: "refused" });
      expect(sent).toEqual([]);
    }
  });

  // T7, T12. Control: the stop switch is read before each request; an unreadable pause stops.
  it("kill switch: the worker's stop switch, and a pause that cannot be read, stop the job before any request", async () => {
    for (const v of ["1", "true", "off", "garbage"]) {
      const { out, sent } = await run(job(), {}, { env: { [KILL_SWITCH_ENV]: v } });
      expect(out, v).toMatchObject({ outcome: "refused", reason: "kill switch" });
      expect(sent).toEqual([]);
    }
    const down = await run(
      job(),
      {},
      { orgPaused: async () => Promise.reject(new Error("db down")) },
    );
    expect(down.out).toMatchObject({ outcome: "refused", reason: "organisation paused" });
    expect(down.sent).toEqual([]);
  });
});
