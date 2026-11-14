/**
 * The agent scorecard without a database (AG-07): the rates and costs from counts, integers only, and blank
 * when nothing was measured; the markup escapes what a person wrote.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scoreOf, type AgentCounts, percent, perApproved } from "../../lib/web/scorecard.js";
import { scorecardBody } from "../../lib/web/scorecard-view.js";

const counts = (over: Partial<AgentCounts> = {}): AgentCounts => ({
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

/** The fixed example on docs/hosted/agent-scorecard.md (invented numbers; the page shows this markup). */
export const EXAMPLE: AgentCounts[] = [
  counts({
    name: "Menu fixer",
    calls: 12,
    denies: 3,
    approved: 4,
    edited: 1,
    declined: 2,
    declineReasons: [
      { reason: "Wrong opening hours", count: 1 },
      { reason: "(no reason given)", count: 1 },
    ],
  }),
  counts({
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Booking page watcher",
    prefix: "5e6f7a8b",
    calls: 3,
  }),
];

describe("the numbers", () => {
  it("percent rounds half up with integers and is blank with nothing to divide by", () => {
    expect(percent(2, 3)).toBe(67);
    expect(percent(1, 8)).toBe(13);
    expect(percent(1, 200)).toBe(1);
    expect(percent(0, 5)).toBe(0);
    expect(percent(0, 0)).toBeNull();
  });

  it("cost per approved draft is whole micro-units, blank before the first approval", () => {
    expect(perApproved(0, 4)).toBe(0);
    expect(perApproved(10, 4)).toBe(3);
    expect(perApproved(7, 0)).toBeNull();
  });

  it("an agent with decisions: approval rate, edit-before-approve rate, cost; errors are never measured", () => {
    expect(scoreOf(EXAMPLE[0]!)).toEqual({
      runs: 12,
      approvalRate: 67,
      editRate: 25,
      costPerApproved: 0,
      denies: 3,
      errors: null,
      declineReasons: EXAMPLE[0]!.declineReasons,
    });
  });

  it("an agent with no decision yet: rates and cost blank, never 0", () => {
    expect(scoreOf(EXAMPLE[1]!)).toMatchObject({
      runs: 3,
      approvalRate: null,
      editRate: null,
      costPerApproved: null,
      errors: null,
    });
  });

  it("refuses counts that are not whole numbers (no NaN, no fraction, no negative reaches the page)", () => {
    for (const bad of [Number.NaN, -1, 0.5, Infinity])
      expect(() => scoreOf(counts({ calls: bad }))).toThrow(/whole/);
  });
});

describe("the markup", () => {
  it("blank cells say so in words, and a reason a person typed is escaped", () => {
    const html = scorecardBody(
      [
        counts({
          name: "Bar <b>bot</b>",
          calls: 1,
          declined: 1,
          declineReasons: [{ reason: "<script>alert(1)</script>", count: 1 }],
        }),
      ],
      "owner",
    ).toString();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bot");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<td class="num blank">not measured</td>');
    expect(html).toContain("0%");
  });

  it("a member or a client viewer is told who can see it; nothing else is shown", () => {
    for (const role of ["member", "client"] as const) {
      const html = scorecardBody(EXAMPLE, role).toString();
      expect(html).toContain("Only owners and admins");
      expect(html).not.toContain("Menu fixer");
    }
  });

  it("no agent yet: a notice, not an empty table", () => {
    expect(scorecardBody([], "admin").toString()).toContain("No agent is registered");
  });

  it("the docs page shows the markup this example renders, exactly", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../../../../docs/hosted/agent-scorecard.md", import.meta.url)),
      "utf8",
    );
    const block = /```text title=agents.html\n([\s\S]*?)```/.exec(doc)?.[1] ?? "";
    expect(block.trim()).toBe(scorecardBody(EXAMPLE, "owner").toString().trim());
  });
});
