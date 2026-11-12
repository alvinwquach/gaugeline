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

  it("an empty url or a bad fail-on fails with a sentence, before anything is requested", async () => {
    const notes: string[] = [];
    const a = await run({ INPUT_URL: "" }, { log: (l) => notes.push(l) });
    const b = await run(
      { INPUT_URL: "https://a.example/", INPUT_FAIL_ON: "sometimes" },
      { log: (l) => notes.push(l) },
    );
    expect([a.failed, b.failed]).toEqual([true, true]);
    expect(notes.join("\n")).toContain('fail-on accepts high, medium or never, not "sometimes"');
  });
});
