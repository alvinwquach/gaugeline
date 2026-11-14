/**
 * The field-findings miner (AG-15) and the house-rules compiler (AG-17) match the hosted registry they are
 * registered in: each descriptor names a scope the registry's closed list has, the scope is the tool it
 * calls, no draft scope or write is asked for, and the policy's tool list does not yet hold either scope
 * (deny by default: a later reviewed change adds them).
 */
import { FIELD_FINDINGS_MINER_AGENT, HOUSE_RULES_AGENT } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { AGENT_SCOPES, SCOPES_NOT_YET_IN_POLICY } from "../../agents/registry.js";

const AGENTS = [FIELD_FINDINGS_MINER_AGENT, HOUSE_RULES_AGENT];

describe("the miner, the compiler and the hosted registry", () => {
  it("each asks for exactly one scope, on the registry's list, and it is its one read tool", () => {
    expect(FIELD_FINDINGS_MINER_AGENT.scopes).toEqual(["read:notes"]);
    expect(HOUSE_RULES_AGENT.scopes).toEqual(["read:rules-file"]);
    for (const a of AGENTS) {
      expect([...a.scopes]).toEqual([...a.tools]);
      for (const s of a.scopes) expect(AGENT_SCOPES).toContain(s);
      expect(a.scopes.some((s) => s.startsWith("draft:"))).toBe(false);
    }
  });

  it("the policy does not list either scope yet, so a call with it is refused", () => {
    expect([...SCOPES_NOT_YET_IN_POLICY]).toEqual(["read:notes", "read:rules-file"]);
    for (const s of SCOPES_NOT_YET_IN_POLICY) expect(AGENT_SCOPES).toContain(s);
  });

  it("failing fixture: no scope outside the closed list slips in beside them", () => {
    for (const bad of ["read:notes ", "read:rules_file", "read:rule-file", "write:notes", "read:*"])
      expect(AGENT_SCOPES as readonly string[]).not.toContain(bad);
    expect(AGENT_SCOPES).toHaveLength(7);
  });
});
