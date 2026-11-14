import { describe, expect, it } from "vitest";
import { attributionProblems } from "../lib/commit-attribution.js";

describe("attributionProblems", () => {
  it("accepts an ordinary message", () => {
    expect(attributionProblems("fix: a thing\n\nWhy it matters.")).toEqual([]);
  });

  it.each([
    ["Co-authored-by: A Person <name-at-example>", "Co-authored-by"],
    ["co-authored-by: lower case", "Co-authored-by"],
    ["CO-AUTHORED-BY: shouting", "Co-authored-by"],
    ["  Co-Authored-By: Someone", "Co-authored-by"],
    ["🤖 Generated with [Claude Code](https://example.test)", "Generated with"],
    ["generated WITH a tool", "Generated with"],
    ["Claude-Session: https://example.test/session_1", "Claude-Session"],
    ["claude-session: x", "Claude-Session"],
  ])("rejects %s", (line, what) => {
    const problems = attributionProblems(`subject\n\nbody\n\n${line}`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(what);
  });

  it("names every problem when there are several", () => {
    const msg = "s\n\nCo-authored-by: x\nGenerated with y\nClaude-Session: z";
    expect(attributionProblems(msg)).toHaveLength(3);
  });

  it("does not trip on the words inside a sentence about the rule", () => {
    expect(attributionProblems("chore: the hook rejects Generated with lines")).toEqual([]);
    expect(attributionProblems("docs: say who co-authored the work in the changelog")).toEqual([]);
  });
});
