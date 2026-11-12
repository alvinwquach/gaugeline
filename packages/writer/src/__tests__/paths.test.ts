/**
 * The path policy. The draft's branch is in the customer's own repository, so a pull request from it can
 * start CI that reads the repository's secrets: the writer never writes a file that defines or hooks
 * automation, at any depth, in any letter case. And a site can name the only folders it accepts.
 */
import { describe, expect, it } from "vitest";
import { applyPullRequest } from "../github/apply.js";
import { checkRequest } from "../github/endpoints.js";
import { checkDraftPayload, isAllowedPath, isSafeRepoPath } from "../kinds.js";
import { DRAFT, PAYLOAD, deps, fakeGithub, job } from "./helpers.js";

describe("isSafeRepoPath: what a draft may name", () => {
  const allowed = [
    "app/menu/links.ts",
    "content/menu.md",
    "public/robots.txt",
    "next.config.js",
    "src/pages/[slug].tsx",
    "docs/guide@v2/notes.md",
    "a.b/c.d",
    "README.md",
    "lib/shell.ts",
    "scripts-notes.md",
  ];
  for (const p of allowed)
    it(`allows ${p}`, () => {
      expect(isSafeRepoPath(p)).toBe(true);
    });

  const denied: [string, string][] = [
    // Shape.
    ["a climbing path", "../etc/x"],
    ["a dot segment", "a/./b"],
    ["a dot-dot segment in the middle", "a/../b"],
    ["an absolute path", "/app/x.ts"],
    ["a leading dash", "-rf"],
    ["a segment with a leading dash", "a/-b"],
    ["an empty segment", "a//b"],
    ["a trailing slash", "a/"],
    ["a backslash", "a\\b.ts"],
    ["an encoded dot", "x%2f.."],
    ["a non-ASCII name", "café.ts"],
    ["301 characters", "a".repeat(301)],
    ["nothing", ""],
    // The deny-list, top level and nested, in any case.
    ["the git folder", ".git/config"],
    ["a nested git folder", "x/.git/config"],
    ["the git folder in capitals", ".GIT/config"],
    ["a workflow", ".github/workflows/x.yml"],
    ["a workflow in capitals", ".GITHUB/workflows/x.yml"],
    ["a nested .github", "docs/.github/x.yml"],
    ["the .github folder itself", ".github"],
    [".gitmodules", ".gitmodules"],
    [".gitattributes", ".gitattributes"],
    [".gitignore", ".gitignore"],
    [".gitlab-ci.yml", ".gitlab-ci.yml"],
    [".husky hooks", ".husky/pre-commit"],
    [".circleci config", ".circleci/config.yml"],
    [".devcontainer", ".devcontainer/devcontainer.json"],
    [".vscode tasks", ".vscode/tasks.json"],
    ["CODEOWNERS at the top", "CODEOWNERS"],
    ["CODEOWNERS in a folder", "docs/CODEOWNERS"],
    ["codeowners in lower case", "docs/codeowners"],
    ["package.json", "package.json"],
    ["a nested package.json", "apps/web/package.json"],
    ["package-lock.json", "package-lock.json"],
    ["yarn.lock", "yarn.lock"],
    ["pnpm-lock.yaml", "pnpm-lock.yaml"],
    ["any .lock file", "vendor/Gemfile.lock"],
    ["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
    ["Makefile", "Makefile"],
    ["a nested makefile", "sub/makefile"],
    ["Dockerfile", "Dockerfile"],
    ["Dockerfile.prod", "docker/Dockerfile.prod"],
    ["docker-compose.yml", "docker-compose.yml"],
    ["Jenkinsfile", "Jenkinsfile"],
    [".npmrc", ".npmrc"],
    [".yarnrc", ".yarnrc"],
    [".yarnrc.yml", ".yarnrc.yml"],
    ["the .yarn folder", ".yarn/plugins/x.cjs"],
    ["a .sh script", "scripts/deploy.sh"],
    ["a .SH script in capitals", "scripts/DEPLOY.SH"],
    ["a .ps1 script", "tools/x.ps1"],
    ["a .bat script", "tools/x.bat"],
    ["a .cmd script", "tools/x.cmd"],
    ["azure-pipelines.yml", "azure-pipelines.yml"],
    ["bitbucket-pipelines.yml", "bitbucket-pipelines.yml"],
    [".travis.yml", ".travis.yml"],
    [".pre-commit-config.yaml", ".pre-commit-config.yaml"],
  ];
  for (const [name, p] of denied)
    it(`refuses ${name}`, () => {
      expect(isSafeRepoPath(p), p).toBe(false);
    });
});

describe("the same policy stands in the payload schema and in the registry", () => {
  for (const path of [
    ".husky/pre-commit",
    "package.json",
    "x/.git/config",
    "docs/CODEOWNERS",
    "Makefile",
  ]) {
    it(`${path}: the schema refuses the payload`, () => {
      const r = checkDraftPayload("pull_request", { ...PAYLOAD, files: [{ path, content: "x" }] });
      expect(r.ok).toBe(false);
    });
    it(`${path}: the registry refuses the request`, () => {
      expect(() =>
        checkRequest({
          endpoint: "putContent",
          path: `/repos/a/b/contents/${path}`,
          body: { message: "m", content: "", branch: `gaugeline/${DRAFT}` },
        }),
      ).toThrow(/file path not allowed/);
    });
  }
});

describe("isAllowedPath: a site's own prefixes", () => {
  it("allows everything when the site names none (only the deny-list applies)", () => {
    expect(isAllowedPath("anything/at/all.ts", undefined)).toBe(true);
  });
  it("a folder prefix allows what is inside it and nothing else", () => {
    const p = ["content/"];
    expect(isAllowedPath("content/menu.md", p)).toBe(true);
    expect(isAllowedPath("content/a/b.md", p)).toBe(true);
    expect(isAllowedPath("contents/menu.md", p)).toBe(false);
    expect(isAllowedPath("app/content/menu.md", p)).toBe(false);
    expect(isAllowedPath("content", p)).toBe(false);
  });
  it("a prefix without a slash is that one file", () => {
    const p = ["docs/menu.md"];
    expect(isAllowedPath("docs/menu.md", p)).toBe(true);
    expect(isAllowedPath("docs/menu.md.bak", p)).toBe(false);
    expect(isAllowedPath("docs/menu.mdx", p)).toBe(false);
  });
  it("letter case does not step outside a folder", () => {
    expect(isAllowedPath("CONTENT/menu.md", ["content/"])).toBe(true);
    expect(isAllowedPath("Src/x.ts", ["content/"])).toBe(false);
  });
  it("an empty list allows nothing", () => {
    expect(isAllowedPath("content/menu.md", [])).toBe(false);
  });
});

describe("the writer enforces the site's prefixes", () => {
  const files = (...paths: string[]) => ({
    ...PAYLOAD,
    files: paths.map((path) => ({ path, content: "x" })),
  });

  it("applies a draft whose files are all inside the prefixes", async () => {
    const gh = fakeGithub();
    const j = job(files("content/menu.md", "content/hours.md"));
    const d = deps({ send: gh.send }, j);
    d.target = { ...d.target, allowedPrefixes: ["content/"] };
    expect((await applyPullRequest(j, d)).outcome).toBe("applied");
  });

  it("refuses a draft with one file outside them, before sending anything, in a dry run too", async () => {
    for (const mode of ["dry-run", "write"] as const) {
      const gh = fakeGithub();
      const j = job(files("content/menu.md", "app/menu/links.ts"));
      const d = deps({ send: gh.send, mode }, j);
      d.target = { ...d.target, allowedPrefixes: ["content/"] };
      const out = await applyPullRequest(j, d);
      expect(out).toMatchObject({ outcome: "refused", reason: "path" });
      expect(d.log).toEqual([out]);
      expect(gh.sent).toEqual([]);
    }
  });

  it("without prefixes configured the same draft applies", async () => {
    const gh = fakeGithub();
    const j = job(files("content/menu.md", "app/menu/links.ts"));
    expect((await applyPullRequest(j, deps({ send: gh.send }, j))).outcome).toBe("applied");
  });
});
