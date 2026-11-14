import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_ONE_PAGER_RUN, formatOnePager, type Result } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../args.js";
import { renderHelp, FLAGS } from "../flags.js";
import { main } from "../main.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gaugeline-one-pager-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd: dir },
  );
  return { code, out: out.join(""), err: err.join("") };
}

const save = (name: string, run: unknown) =>
  writeFileSync(join(dir, name), JSON.stringify(run), "utf8");

describe("--format one-pager: gaugeline view", () => {
  it("prints the page for a saved run, the same words as the library, and nothing else", async () => {
    save("run.json", EXAMPLE_ONE_PAGER_RUN);
    const r = await cli(["view", "run.json", "--format", "one-pager"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(formatOnePager(EXAMPLE_ONE_PAGER_RUN));
    expect(r.err).toBe("");
  });

  it("makes no request: every network call fails the test", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("a request was made");
    });
    vi.stubGlobal("fetch", fetchSpy);
    save("run.json", EXAMPLE_ONE_PAGER_RUN);
    expect((await cli(["view", "run.json", "--format", "one-pager"])).code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a file that is not a saved run is exit 2, and so is one that does not exist", async () => {
    save("run.json", { hello: "world" });
    expect((await cli(["view", "run.json", "--format", "one-pager"])).code).toBe(2);
    expect((await cli(["view", "missing.json", "--format", "one-pager"])).code).toBe(2);
  });

  it("a run file over 10 MB is refused unread", async () => {
    const big: Result = {
      ...EXAMPLE_ONE_PAGER_RUN,
      findings: [{ ...EXAMPLE_ONE_PAGER_RUN.findings[0]!, evidence: "e".repeat(11 * 1024 * 1024) }],
    };
    save("big.json", big);
    const r = await cli(["view", "big.json", "--format", "one-pager"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("too large");
  });

  it("view takes only one-pager: another format is exit 2 and names it", async () => {
    save("run.json", EXAMPLE_ONE_PAGER_RUN);
    const r = await cli(["view", "run.json", "--format", "sarif"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("one-pager");
  });
});

describe("--format one-pager: a page check", () => {
  it("is a view of the run, like sarif: stdout is the page and no report file is written", async () => {
    const site = await startFixture("deploy-preview-dentist");
    try {
      const r = await cli([site.origin, "--allow-private", "--no-open", "--format", "one-pager"]);
      expect(r.code).toBe(0);
      expect(r.out.startsWith("# Gaugeline one-pager: ")).toBe(true);
      expect(r.out).toContain("## Fix this first");
      expect(r.out).toContain("## Not checked");
      // Every listed fix names its check.
      expect(r.out).toMatch(/Source: check `[a-z0-9-]+`/);
    } finally {
      await site.close();
    }
  });

  it("--ci still exits 1 on a Fix this first finding", async () => {
    const site = await startFixture("deploy-preview-dentist");
    try {
      const r = await cli([
        site.origin,
        "--allow-private",
        "--no-open",
        "--format",
        "one-pager",
        "--ci",
      ]);
      expect(r.code).toBe(1);
    } finally {
      await site.close();
    }
  });

  it("a mail-record check left out without --dns is named as left out, not as failed", async () => {
    const site = await startFixture("clean");
    try {
      const r = await cli([site.origin, "--allow-private", "--no-open", "--format", "one-pager"]);
      expect(r.out).toContain("Left out of this run on purpose:");
      expect(r.out).not.toContain("These checks could not run");
    } finally {
      await site.close();
    }
  });
});

describe("--format one-pager: arguments and --help", () => {
  it("is accepted with json, sarif and junit as the choices, and the message lists all four", () => {
    const bad = parseCliArgs(["example.com", "--format", "pdf"]);
    expect(bad.kind).toBe("error");
    if (bad.kind === "error") expect(bad.message).toContain("json, sarif, junit or one-pager");
  });

  it("--json with --format one-pager disagree: exit 2", () => {
    expect(parseCliArgs(["example.com", "--json", "--format", "one-pager"]).kind).toBe("error");
  });

  it("--help for a page check and for view both list the choice", () => {
    expect(renderHelp(FLAGS, "check", { usage: "u", summary: "s" })).toContain("one-pager");
    expect(renderHelp(FLAGS, "view", { usage: "u", summary: "s" })).toContain("one-pager");
  });
});
