/**
 * gaugeline evals (AG-11): the recorded eval sets run offline, the numbers are printed and written to a
 * file, and the exit code says whether a golden case failed or a known-bad case got through. Unit and
 * integration tests drive `main` with stand-in sets; the end-to-end ones run the built command.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_ASSERTIONS,
  EVAL_SETS,
  formatEvalSuite,
  runEvalSets,
  type EvalAssertionId,
  type EvalCaseResult,
  type EvalReport,
  type EvalSet,
} from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { nodeFs, type ScaffoldFs } from "../scaffold-write.js";
import { runBin } from "./helpers/bin.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const options = readFileSync(join(root, "docs/options.md"), "utf8");
// A key-shaped value, built at run time so no key-shaped string sits in the repository.
const SECRET = ["sk", "live", "0123456789abcdef0123456789abcdef"].join("-");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-evals-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

interface Deps {
  evalSets?: readonly EvalSet[];
  evalsFs?: ScaffoldFs;
}
async function run(
  argv: string[],
  deps: Deps = {},
  env: Record<string, string | undefined> = { NO_COLOR: "1" },
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const fetches: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env,
    },
    {
      cwd: dir,
      ...deps,
      // Offline: any request at all fails the test.
      fetcher: new Proxy({} as never, {
        get: (_t, p) => () => {
          fetches.push(String(p));
          throw new Error("no request may be made");
        },
      }),
    },
  );
  expect(fetches).toEqual([]);
  return { code, out: out.join(""), err: err.join("") };
}

const result = (
  caseId: string,
  kind: EvalCaseResult["kind"],
  status: EvalCaseResult["status"],
  failed: EvalAssertionId[] = [],
  detail?: string,
): EvalCaseResult => ({
  caseId,
  kind,
  status,
  costMicros: 4000,
  latencyMs: 100,
  assertions: EVAL_ASSERTIONS.map((id) => ({
    id,
    status: status === "error" ? "skipped" : failed.includes(id) ? "fail" : "pass",
  })),
  ...(detail ? { detail } : {}),
});
/** A stand-in set whose report is exactly `results`. `calls` counts how often it was run. */
function stand(agentId: string, results: EvalCaseResult[], calls = { n: 0 }): EvalSet {
  const n = (s: EvalCaseResult["status"]) => results.filter((r) => r.status === s).length;
  const kind = (k: EvalCaseResult["kind"]) => results.filter((r) => r.kind === k).length;
  const report: EvalReport = {
    agentId,
    results,
    problems: [],
    golden: { total: kind("golden"), passed: n("pass") },
    knownBad: { total: kind("known-bad"), caught: n("caught") },
    costMicros: results.reduce((s, r) => s + r.costMicros, 0),
    ok: results.every((r) => r.status === "pass" || r.status === "caught"),
  };
  return {
    agentId,
    run: async () => {
      calls.n += 1;
      return report;
    },
  };
}
const GOOD = [result("g1", "golden", "pass"), result("b1", "known-bad", "caught", ["cited-ids"])];

describe("gaugeline evals: a green run (exit 0)", () => {
  it("prints each agent's pass rate, refusal rate and cost, and writes the same numbers to a file", async () => {
    const r = await run(["evals"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${formatEvalSuite(await runEvalSets(EVAL_SETS))}\n`);
    expect(r.out).toContain("pass rate     11 of 11 cases (100%)");
    expect(r.out).toContain("refusal rate  6 of 11 cases (55%)");
    expect(r.out).toContain("cost          1008000 micro-units over 10 cases");
    expect(r.err).toBe("Report written to gaugeline-evals.json\n");
    const file = readFileSync(join(dir, "gaugeline-evals.json"), "utf8");
    expect(file).toBe(`${JSON.stringify(await runEvalSets(EVAL_SETS), null, 2)}\n`);
    const parsed = JSON.parse(file);
    expect(parsed.ok).toBe(true);
    expect(parsed.agents[0]).toMatchObject({
      agentId: "triage",
      passRatePercent: 100,
      refusalRatePercent: 55,
      cost: { measured: true, micros: 1_008_000, cases: 10 },
    });
    // No clock, no machine: nothing in the file changes from run to run or from computer to computer.
    expect(file).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(file).not.toContain(dir);
  });

  it("makes no request and reads no key: a key in the environment never reaches the screen or the file", async () => {
    const r = await run(
      ["evals"],
      {},
      {
        NO_COLOR: "1",
        OPENAI_API_KEY: SECRET,
        GAUGELINE_MODEL_KEY: SECRET,
      },
    );
    expect(r.code).toBe(0);
    const file = readFileSync(join(dir, "gaugeline-evals.json"), "utf8");
    for (const text of [r.out, r.err, file]) expect(text).not.toContain(SECRET);
  });

  it("--out names the file, and makes the folder it is in", async () => {
    const r = await run(["evals", "--out", "reports/ci/evals.json"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("Report written to reports/ci/evals.json\n");
    expect(JSON.parse(readFileSync(join(dir, "reports/ci/evals.json"), "utf8")).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["reports"]);
  });

  it("--quiet prints the results and no note about the file; the file is still written", async () => {
    const r = await run(["evals", "--quiet"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("pass rate");
    expect(readdirSync(dir)).toEqual(["gaugeline-evals.json"]);
  });

  it("--agent runs one agent's set; the others are not run", async () => {
    const a = { n: 0 };
    const b = { n: 0 };
    const r = await run(["evals", "--agent", "triage"], {
      evalSets: [stand("digest", GOOD, a), stand("triage", GOOD, b)],
    });
    expect(r.code).toBe(0);
    expect([a.n, b.n]).toEqual([0, 1]);
    expect(r.out).toContain("agent triage");
    expect(r.out).not.toContain("agent digest");
    expect(JSON.parse(readFileSync(join(dir, "gaugeline-evals.json"), "utf8")).agents).toHaveLength(
      1,
    );
  });

  it("two agents are reported one after the other, each with its own numbers", async () => {
    const r = await run(["evals"], {
      evalSets: [
        stand("digest", GOOD),
        stand("triage", [...GOOD, result("b2", "known-bad", "caught", ["limits"])]),
      ],
    });
    expect(r.code).toBe(0);
    expect(r.out.indexOf("agent digest")).toBeLessThan(r.out.indexOf("agent triage"));
    expect(r.out).toContain("pass rate     2 of 2 cases (100%)");
    expect(r.out).toContain("pass rate     3 of 3 cases (100%)");
  });
});

describe("gaugeline evals: a red run (exit 1), and the report is still written", () => {
  it("a known-bad case nothing caught", async () => {
    const r = await run(["evals"], {
      evalSets: [stand("triage", [...GOOD, result("b2", "known-bad", "missed")])],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("  MISSED  b2: no assertion caught it");
    expect(r.out).toContain("Result: FAILED (1 problem: 1 known-bad case not caught).");
    const file = JSON.parse(readFileSync(join(dir, "gaugeline-evals.json"), "utf8"));
    expect(file.ok).toBe(false);
    expect(file.agents[0].knownBad).toEqual({ total: 2, caught: 1 });
  });

  it("a golden case that failed", async () => {
    const r = await run(["evals"], {
      evalSets: [stand("triage", [result("g2", "golden", "fail", ["cited-ids"]), ...GOOD])],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("  FAILED  g2: cited-ids");
    expect(JSON.parse(readFileSync(join(dir, "gaugeline-evals.json"), "utf8")).ok).toBe(false);
  });

  it("a missing recording is an error, never a pass", async () => {
    const r = await run(["evals"], {
      evalSets: [
        stand("triage", [
          ...GOOD,
          result("g3", "golden", "error", [], 'No recording for case "g3".'),
        ]),
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('  ERROR   g3: No recording for case "g3".');
    const row = JSON.parse(readFileSync(join(dir, "gaugeline-evals.json"), "utf8")).agents[0]
      .results[2];
    expect(row).toMatchObject({ caseId: "g3", status: "error", costMicros: null });
  });

  it("one red agent makes the whole run red, and the green one is still reported", async () => {
    const r = await run(["evals"], {
      evalSets: [
        stand("digest", GOOD),
        stand("triage", [result("g2", "golden", "fail", ["schema"])]),
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("agent digest");
    expect(r.out).toContain("pass rate     0 of 1 cases (0%)");
  });
});

describe("gaugeline evals: it never overwrites a file without --force", () => {
  it("a second run is refused (exit 2), the first report is untouched, and nothing is run", async () => {
    expect((await run(["evals"])).code).toBe(0);
    const before = readFileSync(join(dir, "gaugeline-evals.json"), "utf8");
    const calls = { n: 0 };
    const r = await run(["evals"], { evalSets: [stand("triage", GOOD, calls)] });
    expect(r.code).toBe(2);
    expect(r.err).toContain('"gaugeline-evals.json" already exists, so nothing was written.');
    expect(r.err).toContain("--force");
    expect(r.out).toBe("");
    expect(calls.n).toBe(0);
    expect(readFileSync(join(dir, "gaugeline-evals.json"), "utf8")).toBe(before);
  });

  it("--force replaces a file, and only a file", async () => {
    writeFileSync(join(dir, "gaugeline-evals.json"), "old\n");
    const r = await run(["evals", "--force"], { evalSets: [stand("triage", GOOD)] });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "gaugeline-evals.json"), "utf8")).ok).toBe(true);
    mkdirSync(join(dir, "folder"));
    const folder = await run(["evals", "--force", "--out", "folder"]);
    expect(folder.code).toBe(2);
    expect(folder.err).toContain("is a folder, not a file");
  });
});

describe("gaugeline evals: edge cases (exit 2, nothing written)", () => {
  const nothingWritten = () => expect(readdirSync(dir).filter((n) => n !== "keep")).toEqual([]);

  it("no eval sets: refused, not passed", async () => {
    const r = await run(["evals"], { evalSets: [] });
    expect(r.code).toBe(2);
    expect(r.err).toContain("There are no eval sets to run.");
    expect(r.out).toBe("");
    nothingWritten();
  });

  it("an agent with no eval set names the ones that have one", async () => {
    const r = await run(["evals", "--agent", "nobody"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('There is no eval set for agent "nobody".');
    expect(r.err).toContain("The agents with eval sets are: triage.");
    nothingWritten();
  });

  it("--out outside the folder, with a NUL, or a folder's name is refused before anything runs", async () => {
    mkdirSync(join(dir, "reports"));
    const calls = { n: 0 };
    const sets = [stand("triage", GOOD, calls)];
    for (const out of ["../evals.json", "/tmp/evals.json", "a\0b.json", "reports", "."]) {
      const r = await run(["evals", "--out", out], { evalSets: sets });
      expect(r.code, out).toBe(2);
      expect(r.out, out).toBe("");
    }
    expect(calls.n).toBe(0);
  });

  it("--out under a file, not a folder, is refused", async () => {
    writeFileSync(join(dir, "keep"), "x");
    const r = await run(["evals", "--out", "keep/evals.json"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("is not a folder");
    expect(readFileSync(join(dir, "keep"), "utf8")).toBe("x");
  });

  it("an output that cannot be written: the results are shown, exit 2, and nothing is left behind", async () => {
    const fs: ScaffoldFs = {
      ...nodeFs,
      writeFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    };
    const r = await run(["evals", "--out", "locked/evals.json"], { evalsFs: fs });
    expect(r.code).toBe(2);
    expect(r.out).toContain("pass rate     11 of 11 cases (100%)");
    expect(r.err).toContain('Could not write "locked/evals.json" (EACCES). Nothing was written.');
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an unwritable output does not hide a red run: still non-zero", async () => {
    const fs: ScaffoldFs = {
      ...nodeFs,
      writeFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    };
    const r = await run(["evals"], {
      evalsFs: fs,
      evalSets: [stand("triage", [result("b2", "known-bad", "missed"), ...GOOD])],
    });
    expect(r.code).not.toBe(0);
  });

  it("an argument, or a flag the command does not take, is refused", async () => {
    expect((await run(["evals", "triage"])).code).toBe(2);
    const flag = await run(["evals", "--allow-private"]);
    expect(flag.code).toBe(2);
    expect(flag.err).toContain("--allow-private");
    expect((await run(["evals", "--agent"])).code).toBe(2);
    expect((await run(["evals", "--agent", ""])).code).toBe(2);
    expect((await run(["evals", "--out", ""])).code).toBe(2);
    nothingWritten();
  });

  it("parses the flags into one shape", () => {
    expect(parseCliArgs(["evals"])).toMatchObject({
      kind: "evals",
      out: "gaugeline-evals.json",
      force: false,
    });
    expect(
      parseCliArgs(["evals", "--agent", "triage", "--out", "x.json", "--force"]),
    ).toMatchObject({
      kind: "evals",
      agent: "triage",
      out: "x.json",
      force: true,
    });
  });
});

describe("gaugeline evals: the built command", () => {
  it("runs on its own: exit 0, the same text as the library, a file in the folder it ran in", async () => {
    const r = await runBin(["evals"], { OPENAI_API_KEY: SECRET, NO_COLOR: "1" }, { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${formatEvalSuite(await runEvalSets(EVAL_SETS))}\n`);
    expect(r.stderr).toBe("Report written to gaugeline-evals.json\n");
    const file = readFileSync(join(dir, "gaugeline-evals.json"), "utf8");
    expect(file).toBe(`${JSON.stringify(await runEvalSets(EVAL_SETS), null, 2)}\n`);
    for (const text of [r.stdout, r.stderr, file]) expect(text).not.toContain(SECRET);
  });

  it("never overwrites: the second run exits 2, with --force it exits 0", async () => {
    expect((await runBin(["evals"], {}, { cwd: dir })).status).toBe(0);
    const again = await runBin(["evals"], {}, { cwd: dir });
    expect(again.status).toBe(2);
    expect(again.stderr).toContain("already exists");
    expect((await runBin(["evals", "--force"], {}, { cwd: dir })).status).toBe(0);
  });

  it("a bad path exits 2 and writes nothing", async () => {
    const r = await runBin(["evals", "--out", "../escape.json"], {}, { cwd: dir });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("is not a file inside the folder you ran the command in");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an unknown agent exits 2", async () => {
    const r = await runBin(["evals", "--agent", "nobody"], {}, { cwd: dir });
    expect(r.status).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("gaugeline evals --help and docs/options.md list the same flags", () => {
  const flagsIn = (text: string): string[] =>
    [...text.matchAll(/^ {2}(?:-\w, )?(?: {4})?--([a-z-]+)/gm)].map((m) => m[1] ?? "").sort();

  it("prints the help the options page shows", async () => {
    const r = await runBin(["evals", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.evals);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The evals command"));
  });

  it("every flag the command takes is in --help, in the options page's help block and in its flag table, and no other is", () => {
    const names = flagsFor(FLAGS, "evals")
      .filter((f) => !f.hidden)
      .map((f) => f.name)
      .sort();
    expect(names).toEqual(["agent", "force", "help", "out", "quiet", "verbose", "version"]);
    expect(flagsIn(HELP.evals ?? "")).toEqual(names);
    expect(flagsIn(expectedOutput("options", "The evals command"))).toEqual(names);
    for (const name of names) {
      expect(options, `--${name} in the flag table`).toMatch(
        new RegExp(`^\\| (?:\`-\\w\`, )?\`--${name}[ \`]`, "m"),
      );
    }
    // The table's words for the flags that name evals say so.
    for (const name of ["agent", "out", "force"])
      expect(
        options.split("\n").find((l) => l.startsWith(`| \`--${name}`)),
        name,
      ).toContain("evals");
  });

  it("says in its help that there is no live mode, and what the exit codes are", () => {
    expect(HELP.evals).toContain("recorded");
    expect(HELP.evals).toContain("no key");
    expect(HELP.evals).toContain("Exit codes: 0 ");
  });
});
