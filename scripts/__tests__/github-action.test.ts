import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { decide, run, summarise } from "../action/gaugeline-action.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = join(root, "packages/cli/dist/index.js");
const dir = mkdtempSync(join(tmpdir(), "gaugeline-action-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** A SARIF log with just what the action reads: levels and suppressions. */
const result = (level: string, muted = false) => ({
  ruleId: "x",
  level,
  message: { text: "t" },
  ...(muted ? { suppressions: [{ kind: "external" }] } : {}),
});
const sarif = (...results: object[]) =>
  JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "Gaugeline" } }, results }],
  });

describe("whether the job fails", () => {
  const s = (high: number, medium: number) => ({ high, medium, low: 0, total: high + medium });
  it("high: only Fix this first. medium: also Fix soon. never: no finding fails it", () => {
    expect(decide({ exit: 1, failOn: "high", summary: s(1, 0) }).fail).toBe(true);
    expect(decide({ exit: 0, failOn: "high", summary: s(0, 3) }).fail).toBe(false);
    expect(decide({ exit: 0, failOn: "medium", summary: s(0, 3) }).fail).toBe(true);
    expect(decide({ exit: 0, failOn: "never", summary: s(5, 5) }).fail).toBe(false);
  });
  it("a check that could not run (exit 2, or no SARIF) always fails, whatever fail-on says", () => {
    expect(decide({ exit: 2, failOn: "never", summary: s(0, 0) }).fail).toBe(true);
    expect(decide({ exit: 0, failOn: "never", summary: undefined }).fail).toBe(true);
  });
  it("counts what the SARIF holds, and leaves muted findings out", () => {
    const log = sarif(result("error"), result("error", true), result("warning"), result("note"));
    expect(summarise(log)).toEqual({ high: 1, medium: 1, low: 1, total: 3 });
  });
});

describe("action.yml", () => {
  const text = readFileSync(join(root, "action.yml"), "utf8");
  const action = parse(text) as {
    inputs: Record<string, { default?: string; required?: boolean }>;
    runs: { using: string; steps: { run?: string; uses?: string }[] };
  };
  it("takes url and fail-on, with the defaults the docs state, and has no comment input", () => {
    expect(action.inputs.url?.required).toBe(true);
    // The release is the user's choice: no default, never "latest".
    expect(action.inputs.version?.required).toBe(true);
    expect(action.inputs.version).not.toHaveProperty("default");
    expect(action.inputs.category?.default).toBe("gaugeline");
    expect(action.inputs["fail-on"]?.default).toBe("high");
    expect(action.inputs["upload-sarif"]?.default).toBe("true");
    expect(action.inputs).not.toHaveProperty("comment");
    expect(action.inputs).not.toHaveProperty("github-token");
    expect(action.runs.using).toBe("composite");
  });
  it("pins every action it uses by a 40-character commit, with the version beside it", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const m of uses) {
      expect(m[1], m[0]).toMatch(/@[0-9a-f]{40}$/);
      expect(m[2], m[0]).toMatch(/# v\d/);
    }
    // The only thing that talks to GitHub is the official upload step.
    expect(uses.map((m) => m[1]?.split("@")[0])).toEqual(["github/codeql-action/upload-sarif"]);
  });
  it("fork: the upload step cannot turn a fork pull request's job red (its token is read-only)", () => {
    const upload = action.runs.steps.find((st) => st.uses?.startsWith("github/codeql-action/"));
    const step = upload as unknown as Record<string, string>;
    expect(step.name).toBe("Upload SARIF");
    expect(String(step["continue-on-error"])).toContain("github.event.pull_request.head.repo.fork");
    expect(String(step.with ? JSON.stringify(step.with) : "")).toContain("inputs.category");
    // The job fails from the check's own result, never from the upload's.
    const last = action.runs.steps.at(-1) as unknown as Record<string, string>;
    expect(last.if).toContain("steps.check.outputs.failed");
    expect(last.if).not.toContain("upload");
  });
  it("never puts an input into a script, and never reads a token", () => {
    for (const step of action.runs.steps) expect(step.run ?? "").not.toMatch(/\$\{\{/);
    expect(text).not.toMatch(/GITHUB_TOKEN|github\.token|github-token|pull-requests/);
  });
});

describe("the action script makes no request of its own", () => {
  const source = readFileSync(join(root, "scripts/action/gaugeline-action.mjs"), "utf8");
  it("has no network code: no fetch, no http module, no GitHub API address, no token", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\b|node:https?|node:net|node:dns|XMLHttpRequest|WebSocket/);
    expect(code).not.toMatch(/api\.github\.com|GITHUB_TOKEN|Authorization|issues\/|comments/i);
  });
  it("imports only node:child_process and node:fs", () => {
    expect([...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort()).toEqual([
      "node:child_process",
      "node:fs",
    ]);
  });
});

describe("the action against a fixture (the built CLI)", () => {
  let site: Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async () => {
    site = await startFixture("deploy-preview-dentist");
  });
  afterAll(async () => {
    await site.close();
  });

  const base = (name: string, over: Record<string, string> = {}) => {
    const out = join(dir, `${name}-output.txt`);
    writeFileSync(out, "");
    return {
      out,
      env: {
        INPUT_URL: `${site.origin}/`,
        INPUT_ALLOW_PRIVATE: "true",
        INPUT_SARIF_FILE: join(dir, `${name}.sarif`),
        GITHUB_OUTPUT: out,
        GAUGELINE_ACTION_BIN: JSON.stringify([process.execPath, bin]),
        NO_COLOR: "1",
        ...over,
      } as Record<string, string>,
    };
  };

  it("fails on a high finding, writes the SARIF and the outputs, and asks GitHub for nothing", async () => {
    const calls = vi.fn();
    const realFetch = globalThis.fetch;
    // Any request to GitHub (or anywhere) from this process would come through fetch.
    globalThis.fetch = ((...a: unknown[]) => {
      calls(...a);
      throw new Error("the action must not make a request");
    }) as unknown as typeof fetch;
    try {
      const { env, out } = base("high", {
        GITHUB_TOKEN: "not-a-real-token",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "studio/brightside",
      });
      const r = await run(env, { log: () => undefined });
      expect(r.failed).toBe(true);
      expect(JSON.parse(readFileSync(env.INPUT_SARIF_FILE as string, "utf8")).version).toBe(
        "2.1.0",
      );
      expect(readFileSync(out, "utf8")).toMatch(
        /failed=true\nsarif-file=.*\.sarif\nhigh=[1-9]\d*\n/,
      );
      expect(calls).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 60000);

  it("fail-on never: the same findings, the job passes", async () => {
    const { env } = base("never", { INPUT_FAIL_ON: "never" });
    expect((await run(env, { log: () => undefined })).failed).toBe(false);
  }, 60000);

  it("a pull request from a fork needs nothing different: no token is used, and the check still reports", async () => {
    const { env } = base("fork", { GITHUB_EVENT_NAME: "pull_request" });
    const r = await run(env, { log: () => undefined });
    expect(r.failed).toBe(true);
  }, 60000);

  it("version: only an exact release number runs; every other form is refused with a fixed message, before anything runs", async () => {
    const refused = [
      "",
      "latest",
      "next",
      "^1.0.0",
      "~1.2.3",
      ">=1.0.0",
      "1",
      "1.2",
      "v1.2.3",
      "npm:other@1.0.0",
      "other@1.0.0",
      "https://evil.example/pkg.tgz",
      "file:../pkg",
      "git+https://evil.example/pkg.git",
      "1.2.3 --registry=https://evil.example",
      "1.2.3\n::error::injected",
      "1.2.3; rm -rf /",
    ];
    for (const version of refused) {
      const notes: string[] = [];
      const out = join(dir, `version-${Math.random().toString(36).slice(2)}.txt`);
      writeFileSync(out, "");
      // No GAUGELINE_ACTION_BIN and an empty PATH: if the check were not refused first, the run
      // would try to start npx and report "could not run" instead of this message.
      const r = await run(
        { INPUT_URL: "https://a.example/", INPUT_VERSION: version, PATH: "", GITHUB_OUTPUT: out },
        { log: (l) => notes.push(l) },
      );
      expect(r.failed, JSON.stringify(version)).toBe(true);
      expect(r.message).toBe(
        "The version input must be an exact release number such as 1.2.3 (the release you pin), not a tag, a range, a URL or another package.",
      );
      expect(notes.join("\n")).not.toContain("injected");
      expect(readFileSync(out, "utf8")).toContain("sarif-file=\n");
    }
  });
  it("version: exact releases and pre-releases pass the check (and then try to run)", async () => {
    for (const version of ["1.2.3", "0.1.0", "10.20.30", "1.0.0-rc.1", "2.0.0-beta-2"]) {
      const r = await run(
        { INPUT_URL: "https://a.example/", INPUT_VERSION: version, PATH: "" },
        { log: () => undefined },
      );
      expect(r.message).toBe("Gaugeline could not run the check.");
    }
  });
  it("the url goes after -- so it can never be read as a flag", async () => {
    const stub = join(dir, "stub.mjs");
    const seen = join(dir, "argv.json");
    writeFileSync(
      stub,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(sarif())});`,
    );
    const { env } = base("argv", {
      INPUT_URL: "--owner-consent",
      GAUGELINE_ACTION_BIN: JSON.stringify([process.execPath, stub]),
    });
    await run(env, { log: () => undefined });
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual([
      "--format",
      "sarif",
      "--ci",
      "--allow-private",
      "--",
      "--owner-consent",
    ]);
  });
  it("never passes a probing flag, whatever the inputs say", async () => {
    const stub = join(dir, "stub2.mjs");
    const seen = join(dir, "argv2.json");
    writeFileSync(
      stub,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(sarif())});`,
    );
    const { env } = base("probe", {
      INPUT_OWNER_CONSENT: "true",
      INPUT_ROUTES: "app/**",
      GAUGELINE_ACTION_BIN: JSON.stringify([process.execPath, stub]),
    });
    await run(env, { log: () => undefined });
    const argv = JSON.parse(readFileSync(seen, "utf8")) as string[];
    expect(argv.join(" ")).not.toMatch(/owner-consent|routes|probe/);
  });
  it("an empty url or a bad fail-on fails with a sentence, before anything is requested", async () => {
    const notes: string[] = [];
    const a = await run({ INPUT_URL: "" }, { log: (l) => notes.push(l) });
    const b = await run(
      { INPUT_URL: "https://a.example/", INPUT_FAIL_ON: "sometimes" },
      { log: (l) => notes.push(l) },
    );
    expect([a.failed, b.failed]).toEqual([true, true]);
    expect(notes.join("\n")).toContain("fail-on accepts high, medium or never.");
    // What the user typed is never echoed into a workflow command line (::error::, ::set-output).
    const c: string[] = [];
    await run(
      { INPUT_URL: "https://a.example/", INPUT_FAIL_ON: "high\n::set-output name=x::y" },
      { log: (l) => c.push(l) },
    );
    expect(c.join("\n")).not.toContain("set-output");
    expect(c).toHaveLength(1);
  });
});
