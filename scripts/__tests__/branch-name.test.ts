import { describe, expect, it } from "vitest";
import { branchNameProblem } from "../lib/branch-name.js";

describe("branchNameProblem", () => {
  it.each([
    "main",
    "feat/g31-mcp-server",
    "feat/c-11-drupal-adapter",
    "fix/218-adr-test-paths",
    "chore/attribution-off",
    "ci/219-pr-diet",
    "docs/adr-0010-approve-then-act",
    "test/runner-lists",
    "refactor/split-fetcher",
    "release/v1.0.0",
  ])("allows %s", (name) => {
    expect(branchNameProblem(name)).toBeUndefined();
  });

  it.each([
    "claude/relaxed-brown-7yxex4",
    "dependabot/github_actions/actions/checkout-7.0.1",
    "feat/Upper-Case",
    "feat/with_underscore",
    "feat/",
    "feat/-leading-hyphen",
    "feature/g31",
    "feat/g31/extra-slash",
    "Main",
    "06/mcp-server",
    "",
  ])("rejects %s", (name) => {
    expect(branchNameProblem(name)).toContain("does not match");
  });
});
