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

  it("the example workflows are pinned the same way; the weekly one checks daily and sends only with secrets", () => {
    const examples = fileURLToPath(new URL("../../examples/workflows/", import.meta.url));
    const text = readFileSync(join(examples, "weekly.yml"), "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
      if (!m) continue;
      expect(`${i + 1}: ${m[1] ?? ""}`).toMatch(/@[0-9a-f]{40}$/);
      expect(m[2] ?? "").toMatch(/#\s*v\d+(\.\d+)*/);
    }
    expect(text).toContain('cron: "0 15 * * *"');
    expect(text).toContain("permissions:\n  contents: read\n  actions: read");
    expect(text).toContain("npx --yes gaugeline digest --runs all --time-zone America/Los_Angeles");
    // Sending comes only from secrets; no address or key is written in the file.
    for (const name of [
      "GAUGELINE_EMAIL",
      "RESEND_API_KEY",
      "GAUGELINE_EMAIL_FROM",
      "GAUGELINE_WEBHOOK",
    ])
      expect(text).toContain(`${name}: \${{ secrets.${name} }}`);
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

describe("docs workflow", () => {
  const text = readFileSync(join(dir, "docs.yml"), "utf8");
  it("a pull request from a fork still builds and uploads, and the preview deploy is skipped without failing", () => {
    expect(text).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(text.slice(text.indexOf("  build:"), text.indexOf("  preview:"))).not.toMatch(
      /secrets\./,
    );
    expect(text).toContain("upload-artifact");
  });

  it("deploys are switched off unless DOCS_DEPLOY_ENABLED is set, and the host lives in one script", () => {
    expect(text.match(/vars\.DOCS_DEPLOY_ENABLED == 'true'/g)).toHaveLength(2);
    expect(text.match(/scripts\/deploy-docs\.sh/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("faster pull request runs", () => {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");

  // The two JSON strings the CI matrix chooses between, read out of the workflow file itself.
  function matrices(): { pullRequest: unknown; main: unknown } {
    const m = /fromJSON\(github\.event_name == 'pull_request' && '(.*?)' \|\| '(.*?)'\)/.exec(
      read("ci.yml"),
    );
    if (!m) throw new Error("ci.yml does not choose its matrix from the event");
    return { pullRequest: JSON.parse(m[1] ?? ""), main: JSON.parse(m[2] ?? "") };
  }

  it("a pull request runs Linux on Node 22 and 24 and Windows on Node 24, nothing else", () => {
    expect(matrices().pullRequest).toEqual({
      include: [
        { os: "ubuntu-latest", node: "22" },
        { os: "ubuntu-latest", node: "24" },
        { os: "windows-latest", node: "24" },
      ],
    });
  });

  it("main runs the full matrix: three systems on Node 22 and 24", () => {
    expect(matrices().main).toEqual({
      os: ["ubuntu-latest", "windows-latest", "macos-latest"],
      node: ["22", "24"],
    });
  });

  it("a new push cancels the older pull request run and never cancels a run on main", () => {
    for (const f of ["ci.yml", "docs.yml"]) {
      const text = read(f);
      expect(text).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
      expect(text).toMatch(
        /concurrency:\n\s+group: .*\$\{\{ github\.head_ref \|\| github\.sha \}\}/,
      );
    }
  });

  it("every job has a timeout of at most 15 minutes (the release wait for the full matrix is the one longer job)", () => {
    const problems: string[] = [];
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const lines = read(f).split("\n");
      const start = lines.findIndex((l) => l === "jobs:");
      let job = "";
      let timeout: number | undefined;
      const flush = () => {
        if (!job) return;
        const allowed = f === "release-pr.yml" && job === "ci-gate" ? 60 : 15;
        if (timeout === undefined) problems.push(`${f}: ${job} has no timeout-minutes`);
        else if (timeout > allowed)
          problems.push(`${f}: ${job} has ${timeout} minutes (max ${allowed})`);
      };
      for (const l of lines.slice(start + 1)) {
        const j = /^ {2}([a-z][\w-]*):\s*$/.exec(l);
        if (j) {
          flush();
          job = j[1] ?? "";
          timeout = undefined;
          continue;
        }
        const m = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(l);
        if (m) timeout = Number(m[1]);
      }
      flush();
    }
    expect(problems).toEqual([]);
  });

  it("the pull request checks cancel an older run of the same branch", () => {
    for (const f of ["pr-gate.yml", "pr-body.yml"]) {
      expect(read(f), f).toMatch(
        /concurrency:\n {2}group: [\w-]+-\$\{\{ github\.head_ref \}\}\n {2}cancel-in-progress: true/,
      );
    }
  });

  it("the release workflow waits for the full matrix of its own commit before it does anything", () => {
    const text = read("release-pr.yml");
    expect(text).toContain("ci-gate:");
    expect(text).toContain("actions/workflows/ci.yml/runs?head_sha=$SHA&event=push");
    expect(text).toMatch(/release:\n\s+needs: ci-gate/);
  });

  it("the browser tests run only on the decision of scripts/needs-browser-tests.sh", () => {
    const text = read("docs.yml");
    expect(text).toContain("bash scripts/needs-browser-tests.sh");
    for (const step of ["playwright install --with-deps chromium", "pnpm docs:e2e"]) {
      expect(text).toMatch(
        new RegExp(
          `- if: steps\\.browser\\.outputs\\.run == 'true'\\n\\s+run: pnpm (exec )?${step.replace(/^pnpm /, "").replace(/[.]/g, "\\.")}`,
        ),
      );
    }
  });
});
