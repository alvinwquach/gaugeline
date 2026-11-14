/**
 * The regression watcher's descriptor (core) matches the hosted registry it will be registered in (AG-13):
 * its scope is one the registry knows, and it asks for no draft scope.
 */
import { REGRESSION_WATCHER_AGENT } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { AGENT_SCOPES } from "../../agents/registry.js";

describe("the regression watcher and the hosted registry", () => {
  it("asks only for scopes the registry has, and no draft scope", () => {
    for (const s of REGRESSION_WATCHER_AGENT.scopes) expect(AGENT_SCOPES).toContain(s);
    expect(REGRESSION_WATCHER_AGENT.scopes.some((s) => s.startsWith("draft:"))).toBe(false);
  });
});
