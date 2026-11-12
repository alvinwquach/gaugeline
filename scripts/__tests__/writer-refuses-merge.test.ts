/**
 * ADR-0010 part 7, owner decision 4: no way to merge, approve, force or delete, asserted on requests.
 * It lives here and not in packages/writer because writer-no-merge.test.ts refuses the word in any file of
 * that package (tests included), by design.
 */
import { describe, expect, it } from "vitest";
import { applyPullRequest } from "../../packages/writer/src/github/apply.js";
import {
  checkRequest,
  ENDPOINTS,
  type EndpointId,
} from "../../packages/writer/src/github/endpoints.js";
import { DRAFT, deps, fakeGithub, job } from "../../packages/writer/src/__tests__/helpers.js";

const R = "/repos/northgate-studio/tidewater-bar";

describe("the writer's registry refuses every way to merge, update, review or protect", () => {
  const paths = [
    `${R}/pulls/7/merge`,
    `${R}/pulls/7/update-branch`,
    `${R}/pulls/7/reviews`,
    `${R}/pulls/7/reviews/1/events`,
    `${R}/merges`,
    `${R}/git/refs/heads/main`,
    `${R}/git/refs`,
    `${R}/branches/main/protection`,
    `${R}/pulls/7`,
    `${R}/issues/7`,
    `${R}/actions/workflows/ci.yml/dispatches`,
    "/graphql",
  ];
  const bodies = [
    undefined,
    {},
    { merge_method: "squash" },
    { auto_merge: true },
    { message: "m", content: "", branch: `gaugeline/${DRAFT}` },
    { event: "APPROVE" },
    { enabled: true },
  ];

  it("no registered endpoint accepts any of them, with any body", () => {
    for (const endpoint of Object.keys(ENDPOINTS) as EndpointId[])
      for (const path of paths)
        for (const body of bodies) {
          expect(
            () => checkRequest({ endpoint, path, ...(body ? { body } : {}) }),
            `${endpoint} ${path} ${JSON.stringify(body)}`,
          ).toThrow(/refused/);
        }
  });

  it("an endpoint called merge, or any other name outside the six, is not registered", () => {
    for (const endpoint of ["merge", "mergePull", "enableAutoMerge", "approve", "deleteRef"])
      expect(() =>
        checkRequest({ endpoint: endpoint as EndpointId, path: `${R}/pulls/7/merge` }),
      ).toThrow(/not a registered endpoint/);
  });

  it("a full apply sends none of them", async () => {
    const gh = fakeGithub();
    const j = job();
    expect((await applyPullRequest(j, deps({ send: gh.send }, j))).outcome).toBe("applied");
    for (const r of gh.sent) expect(r.path).not.toMatch(/merge|reviews|protection|dispatches/);
    expect(
      gh.sent.filter((r) => ENDPOINTS[r.endpoint].method !== "GET").map((r) => r.endpoint),
    ).toEqual(["createRef", "putContent", "createPull"]);
  });
});
