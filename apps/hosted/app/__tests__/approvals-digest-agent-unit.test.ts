/**
 * The digest agent's descriptor (core) matches the hosted registry it will be registered in (AG-14): its
 * scope is one the registry knows, and the draft kinds the digest counts are the inbox's own.
 */
import { APPROVALS_DIGEST_AGENT, APPROVALS_DIGEST_KINDS } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { AGENT_SCOPES } from "../../agents/registry.js";
import { DRAFT_KINDS } from "../../inbox/kinds.js";

describe("the digest agent and the hosted registry", () => {
  it("asks only for scopes the registry has, and no draft scope", () => {
    for (const s of APPROVALS_DIGEST_AGENT.scopes) expect(AGENT_SCOPES).toContain(s);
    expect(APPROVALS_DIGEST_AGENT.scopes.some((s) => s.startsWith("draft:"))).toBe(false);
  });
  it("counts the inbox's draft kinds, in the same order", () => {
    expect([...APPROVALS_DIGEST_KINDS]).toEqual([...DRAFT_KINDS]);
  });
});
