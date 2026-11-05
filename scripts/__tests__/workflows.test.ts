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

  it("the release workflow can only be started by hand on main, and is a dry run unless asked", () => {
    const release = read("release.yml");
    const on = release.slice(release.indexOf("\non:"), release.indexOf("\npermissions:"));
    expect(on).toContain("workflow_dispatch:");
    expect(on).not.toMatch(/pull_request|push:|schedule:/);
    expect(release).toContain("if: github.ref == 'refs/heads/main'");
    expect(release).toContain("--provenance");
    expect(release).toContain("|| '--dry-run'");
    expect(release).toMatch(/id-token: write/);
  });
});

describe("skeleton release workflow", () => {
  const text = readFileSync(join(dir, "skeleton.yml"), "utf8");
  it("runs only on v0.0.* tags, never on pull requests, so a fork cannot reach the npm token", () => {
    const on = text.slice(text.indexOf("\non:"), text.indexOf("\npermissions:"));
    expect(on).toContain('tags: ["v0.0.*"]');
    expect(on).not.toMatch(/pull_request/);
  });

  it("publishing is switched off unless PUBLISH_ENABLED is set, and checks the tag against the version first", () => {
    expect(text).toContain(
      "if: startsWith(github.ref, 'refs/tags/v0.0.') && vars.PUBLISH_ENABLED == 'true'",
    );
    expect(text.indexOf("check-tag-version.ts")).toBeLessThan(text.indexOf("npm publish"));
    expect(text).toContain("--provenance");
  });
});
