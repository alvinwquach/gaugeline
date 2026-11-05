import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

describe("GitHub Actions supply chain", () => {
  it("every action in .github/workflows is pinned to a full commit SHA with its version in a comment", () => {
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
          if (!m || m[1]?.startsWith("./")) return;
          if (!/@[0-9a-f]{40}$/.test(m[1] ?? "") || !/#\s*v\d+(\.\d+)*/.test(m[2] ?? "")) {
            bad.push(`${f}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(bad).toEqual([]);
  });

  it("CODEOWNERS covers .github/, CLAUDE.md, .mcp.json and package.json", () => {
    const owners = readFileSync(
      fileURLToPath(new URL("../../.github/CODEOWNERS", import.meta.url)),
      "utf8",
    );
    for (const path of ["/.github/", "/CLAUDE.md", "/.mcp.json", "/package.json"]) {
      expect(owners).toMatch(new RegExp(`^${path.replace(/\./g, "\\.")}\\s+@alvinwquach$`, "m"));
    }
  });

  it("dependabot updates npm and github-actions weekly", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../.github/dependabot.yml", import.meta.url)),
      "utf8",
    );
    for (const eco of ["npm", "github-actions"]) {
      expect(text).toMatch(
        new RegExp(
          `package-ecosystem: ${eco}\\n\\s+directory: /\\n\\s+schedule:\\n\\s+interval: weekly`,
        ),
      );
    }
  });
});

describe("forks and the npm token", () => {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  it("the CI workflow never reads a secret and only has read permission", () => {
    const ci = read("ci.yml");
    expect(ci).not.toMatch(/secrets\./);
    expect(ci).toMatch(/permissions:\n\s+contents: read/);
    expect(ci).not.toMatch(/pull_request_target/);
  });

  it("the release workflow runs only on pushes to main and is off unless the owner opts in", () => {
    const release = read("release-pr.yml");
    const on = release.slice(release.indexOf("\non:"), release.indexOf("\npermissions:"));
    expect(on).toMatch(/push:\n\s+branches: \[main\]/);
    expect(on).not.toMatch(/pull_request|tags:|schedule:/);
    expect(release).toContain("if: vars.RELEASE_PR_ENABLED == 'true'");
    expect(release).toContain("vars.PUBLISH_ENABLED == 'true' && 'pnpm run release' || ''");
    expect(release).toMatch(/id-token: write/);
    expect(release).toContain('NPM_CONFIG_PROVENANCE: "true"');
  });
});

describe("K01 publish path, moved into the Release PR workflow by K02", () => {
  it("the old tag-triggered and manual publish workflows are gone; the smoke job runs after a publish", () => {
    const files = readdirSync(dir);
    expect(files).not.toContain("skeleton.yml");
    expect(files).not.toContain("release.yml");
    const release = readFileSync(join(dir, "release-pr.yml"), "utf8");
    expect(release).toContain("if: needs.release.outputs.published == 'true'");
    expect(release).toContain("scripts/smoke-published.sh");
  });
});
