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
