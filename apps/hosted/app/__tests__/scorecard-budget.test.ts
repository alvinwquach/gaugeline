/**
 * Cost per approved draft on the agent scorecard (AG-22): the cost a model call's budget records goes into the
 * trace as whole micro-units, and the scorecard's existing figure divides it by the approved drafts. Read-only:
 * no SQL, no new column. A figure with nothing to measure stays blank.
 */
import { createBudgetLedger, traceFieldsOf, type SpendEntry } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { scoreOf, type AgentCounts } from "../../lib/web/scorecard.js";
import { scorecardBody } from "../../lib/web/scorecard-view.js";

const counts = (over: Partial<AgentCounts>): AgentCounts => ({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Menu fixer",
  status: "active",
  prefix: "1a2b3c4d",
  calls: 0,
  denies: 0,
  approved: 0,
  edited: 0,
  declined: 0,
  costMicros: 0,
  declineReasons: [],
  ...over,
});

/** Three answered calls, each 1800 tokens in and 200 out at an invented price: 700 micro-units each. */
function spendOfThreeCalls(): SpendEntry[] {
  const spent: SpendEntry[] = [];
  const ledger = createBudgetLedger({
    config: {
      ceilings: { perRunMicros: 10_000, perDayMicros: 10_000, perWorkspaceMicros: 10_000 },
      prices: { "word-small": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 } },
    },
    now: () => Date.UTC(2026, 10, 13, 12, 0, 0),
    onSpend: (e) => spent.push(e),
  });
  const run = ledger.forRun("workspace-a");
  for (const callId of ["a", "b", "c"]) {
    const call = {
      agentId: "triage",
      callId,
      tier: "fast" as const,
      provider: "recorded",
      model: "word-small",
      inputTokens: 2_000,
      maxOutputTokens: 1_000,
    };
    run.before(call);
    run.after({
      ...call,
      usage: { inputTokens: 1_800, outputTokens: 200, costMicros: 0, latencyMs: 1 },
    });
  }
  return spent;
}

describe("cost per approved draft, from what the budget recorded", () => {
  const cost = spendOfThreeCalls()
    .map((e) => traceFieldsOf(e).costMicros)
    .reduce((a, b) => a + b, 0);

  it("is the trace's total cost divided by the approved drafts, in whole micro-units", () => {
    expect(cost).toBe(2_100);
    expect(scoreOf(counts({ calls: 3, approved: 2, costMicros: cost })).costPerApproved).toBe(
      1_050,
    );
    expect(scoreOf(counts({ calls: 3, approved: 4, costMicros: cost })).costPerApproved).toBe(525);
  });

  it("is blank before the first approval, however much was spent", () => {
    const s = scoreOf(counts({ calls: 3, costMicros: cost }));
    expect(s.costPerApproved).toBeNull();
    const html = scorecardBody([counts({ calls: 3, costMicros: cost })], "owner").toString();
    expect(html).toContain('<td class="num blank">none yet</td>');
    expect(html).not.toContain(`>${cost}<`);
  });

  it("shows on the page as a number once there is an approval", () => {
    const html = scorecardBody(
      [counts({ calls: 3, approved: 2, costMicros: cost })],
      "owner",
    ).toString();
    expect(html).toContain('<td class="num">1050</td>');
  });
});
