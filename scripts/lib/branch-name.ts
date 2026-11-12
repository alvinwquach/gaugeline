/**
 * Branch names are type/id-short-description, lowercase, hyphens: feat/g31-mcp-server, fix/218-adr-test-paths,
 * chore/attribution-off, ci/219-pr-diet, docs/adr-0010-approve-then-act, test/, refactor/, release/v1.0.0.
 * The other names that may be pushed are main and Dependabot's own dependabot/<ecosystem>/<package>-<version> branches. Pure, so a test can cover it.
 */
export const DEPENDABOT_BRANCH = /^dependabot\/[a-z0-9][a-zA-Z0-9._/-]*$/;
export const BRANCH_NAME = /^(feat|fix|chore|ci|docs|test|refactor|release)\/[a-z0-9][a-z0-9.-]*$/;

/** What is wrong with a branch name being pushed (without refs/heads/), or undefined when it is allowed. */
export function branchNameProblem(name: string): string | undefined {
  if (name === "main" || BRANCH_NAME.test(name) || DEPENDABOT_BRANCH.test(name)) return undefined;
  return `branch "${name}" does not match type/id-short-description (feat|fix|chore|ci|docs|test|refactor|release, then lowercase letters, digits, dots and hyphens), for example feat/g31-mcp-server`;
}
