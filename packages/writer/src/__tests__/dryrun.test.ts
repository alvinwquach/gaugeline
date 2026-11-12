/**
 * ADR-0010 part 5: a dry run builds the exact requests and validates them against the registry. The
 * registry's checkRequest is wrapped (it still does its real work) so the test can see what it was asked
 * and make it refuse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPullRequest } from "../github/apply.js";
import * as endpoints from "../github/endpoints.js";
import { deps, fakeGithub, job } from "./helpers.js";

vi.mock("../github/endpoints.js", async (importOriginal) => {
  const real = await importOriginal<typeof endpoints>();
  return { ...real, checkRequest: vi.fn(real.checkRequest) };
});

const check = vi.mocked(endpoints.checkRequest);
const real = check.getMockImplementation()!;

beforeEach(() => {
  check.mockReset();
  check.mockImplementation(real);
});

describe("a dry run validates its whole plan against the registry", () => {
  it("asks the registry about every request it would make, with the base commit shown as a placeholder", async () => {
    const gh = fakeGithub();
    const j = job();
    const out = await applyPullRequest(j, deps({ send: gh.send, mode: "dry-run" }, j));
    expect(out.outcome).toBe("dry_run");
    expect(gh.sent).toEqual([]);
    const asked = check.mock.calls.map(([r]) => r.endpoint);
    expect(asked).toEqual(["getRef", "listPulls", "createRef", "putContent", "createPull"]);
    const createRef = check.mock.calls.find(([r]) => r.endpoint === "createRef")![0];
    expect(createRef.body).toMatchObject({ sha: "0".repeat(40) });
    // The placeholder is a well-formed sha, not an empty string the registry would refuse.
    expect(() => real(createRef)).not.toThrow();
  });

  it("refuses, with a trail entry and nothing sent, when the registry refuses a planned request", async () => {
    check.mockImplementation((r) => {
      if (r.endpoint === "createPull")
        throw new endpoints.RegistryError("refused createPull: test");
      real(r);
    });
    const gh = fakeGithub();
    const j = job();
    const d = deps({ send: gh.send, mode: "dry-run" }, j);
    const out = await applyPullRequest(j, d);
    expect(out).toMatchObject({ outcome: "refused", reason: "registry" });
    expect(d.log).toEqual([out]);
    expect(gh.sent).toEqual([]);
  });

  it("a write is refused the same way, before the first request", async () => {
    check.mockImplementation((r) => {
      if (r.endpoint === "putContent")
        throw new endpoints.RegistryError("refused putContent: test");
      real(r);
    });
    const gh = fakeGithub();
    const j = job();
    const out = await applyPullRequest(j, deps({ send: gh.send }, j));
    expect(out).toMatchObject({ outcome: "refused", reason: "registry" });
    expect(gh.sent).toEqual([]);
  });

  it("a request the sender's registry refuses in the middle of a write ends the job with a trail entry", async () => {
    const j = job();
    const d = deps(
      {
        send: async (r) => {
          if (r.endpoint === "createRef") throw new endpoints.RegistryError("refused createRef");
          return { status: 200, json: { object: { sha: "b".repeat(40) } } };
        },
      },
      j,
    );
    const out = await applyPullRequest(j, d);
    expect(out).toMatchObject({ outcome: "refused", reason: "registry" });
    expect(d.log).toEqual([out]);
  });

  it("an error that is not the registry's is not swallowed", async () => {
    check.mockImplementation(() => {
      throw new TypeError("boom");
    });
    const j = job();
    await expect(
      applyPullRequest(j, deps({ send: fakeGithub().send, mode: "dry-run" }, j)),
    ).rejects.toThrow("boom");
  });
});
