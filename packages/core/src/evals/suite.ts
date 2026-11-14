/**
 * The eval suite report (AG-11): what `gaugeline evals` prints and writes. It runs each eval set offline
 * and boils each agent's report down to whole numbers: pass rate, refusal rate and cost from the recorded
 * cases only. Nothing is invented: a rate with nothing to divide is null, and a cost with no recorded case
 * is "not measured". No model opinion is part of it, so nothing here can say pass on a model's word. Core
 * never exits the process: the CLI turns `ok` into an exit code.
 */
import { ConfigError } from "../errors.js";
import { sanitise } from "../untrusted.js";
import type { EvalSet } from "./sets.js";
import type { EvalAssertionId, EvalCase, EvalCaseResult, EvalReport } from "./types.js";

export const EVAL_SUITE_SCHEMA = 1;

/** An answer the harness stopped by one of the fail-closed guards. The other assertions are about content. */
export const REFUSAL_ASSERTIONS: readonly EvalAssertionId[] = ["schema", "limits", "no-write-call"];

export interface EvalCaseRow {
  caseId: string;
  kind: EvalCase["kind"];
  status: EvalCaseResult["status"];
  /** The assertions that failed: for a known-bad case, the ones that caught it. */
  failed: EvalAssertionId[];
  /** One of REFUSAL_ASSERTIONS failed, or the input was refused before the model was asked. */
  refused: boolean;
  /** Recorded cost in micro-units; null when no model answer was recorded for the case. */
  costMicros: number | null;
  latencyMs: number | null;
  detail?: string;
}

export interface EvalAgentSummary {
  agentId: string;
  ok: boolean;
  /** Why the set was not run (an invalid set, a recording not well formed). Empty when it ran. */
  problems: string[];
  /** passed = golden cases that passed + known-bad cases that were caught. */
  cases: { total: number; passed: number };
  golden: { total: number; passed: number };
  knownBad: { total: number; caught: number };
  /** Whole percent, rounded; null when the set did not run. */
  passRatePercent: number | null;
  refused: number;
  refusalRatePercent: number | null;
  /** From the cases a model answered. `micros` is null (not measured) when none did. */
  cost: { measured: boolean; micros: number | null; cases: number };
  results: EvalCaseRow[];
}

export interface EvalSuiteReport {
  schema: typeof EVAL_SUITE_SCHEMA;
  ok: boolean;
  agents: EvalAgentSummary[];
}

const text = (v: unknown, max = 200): string => sanitise(String(v), max).text;
const percent = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((100 * part) / whole);

/** A case was answered by the model when its schema assertion ran: skipped means the model never answered. */
const answered = (r: EvalCaseResult): boolean =>
  r.assertions.some((a) => a.id === "schema" && a.status !== "skipped");

function row(r: EvalCaseResult): EvalCaseRow {
  const failed = r.assertions.filter((a) => a.status === "fail").map((a) => a.id);
  const ok = answered(r);
  return {
    caseId: r.caseId,
    kind: r.kind,
    status: r.status,
    failed,
    refused: r.status !== "error" && failed.some((id) => REFUSAL_ASSERTIONS.includes(id)),
    costMicros: ok ? r.costMicros : null,
    latencyMs: ok ? r.latencyMs : null,
    ...(r.detail ? { detail: text(r.detail) } : {}),
  };
}

/** The numbers of one agent's report. Pure: whole numbers in, whole numbers out. */
export function summariseEval(report: EvalReport): EvalAgentSummary {
  const ran = report.problems.length === 0;
  const results = report.results.map(row);
  const total = report.golden.total + report.knownBad.total;
  const passed = report.golden.passed + report.knownBad.caught;
  const refused = results.filter((r) => r.refused).length;
  const costed = results.filter((r) => r.costMicros !== null);
  return {
    agentId: report.agentId,
    ok: report.ok,
    problems: report.problems.map((p) => text(p)),
    cases: { total, passed },
    golden: { ...report.golden },
    knownBad: { ...report.knownBad },
    passRatePercent: ran ? percent(passed, total) : null,
    refused,
    refusalRatePercent: ran ? percent(refused, total) : null,
    cost: {
      measured: costed.length > 0,
      micros: costed.length > 0 ? costed.reduce((n, r) => n + (r.costMicros ?? 0), 0) : null,
      cases: costed.length,
    },
    results,
  };
}

/**
 * Runs the sets (or the ones named in `agents`) one after another and summarises each. A set that throws
 * is that agent's problem, never a crash of the others. No sets, an unknown id, or two sets for one agent
 * are a ConfigError: a suite with nothing to run must not look green.
 */
export async function runEvalSets(
  sets: readonly EvalSet[],
  opts: { agents?: readonly string[] } = {},
): Promise<EvalSuiteReport> {
  const known = sets.map((s) => s.agentId);
  if (known.length === 0)
    throw new ConfigError("There are no eval sets to run.", {
      hint: "Eval sets ship with Gaugeline's agents; a build with none has nothing to prove.",
    });
  const dup = known.find((id, i) => known.indexOf(id) !== i);
  if (dup !== undefined)
    throw new ConfigError(`There is more than one eval set for agent "${text(dup, 80)}".`);
  for (const id of opts.agents ?? [])
    if (!known.includes(id))
      throw new ConfigError(`There is no eval set for agent "${text(id, 80)}".`, {
        hint: `The agents with eval sets are: ${known.join(", ")}.`,
      });
  const chosen = opts.agents ? sets.filter((s) => opts.agents?.includes(s.agentId)) : sets;
  const agents: EvalAgentSummary[] = [];
  for (const set of chosen) {
    try {
      agents.push(summariseEval(await set.run()));
    } catch (err) {
      agents.push(
        summariseEval({
          agentId: set.agentId,
          results: [],
          problems: [err instanceof Error ? err.message : String(err)],
          golden: { total: 0, passed: 0 },
          knownBad: { total: 0, caught: 0 },
          costMicros: 0,
          ok: false,
        }),
      );
    }
  }
  return { schema: EVAL_SUITE_SCHEMA, ok: agents.every((a) => a.ok), agents };
}

interface Failures {
  golden: number;
  missed: number;
  errors: number;
  problems: number;
}
function failures(a: EvalAgentSummary): Failures {
  const n = (f: (r: EvalCaseRow) => boolean) => a.results.filter(f).length;
  return {
    golden: n((r) => r.status === "fail"),
    missed: n((r) => r.status === "missed"),
    errors: n((r) => r.status === "error"),
    problems: a.problems.length,
  };
}

/** How many things are wrong across the suite: a golden case failed, a known-bad case missed, an error, a problem. */
export function evalFailureCount(suite: EvalSuiteReport): number {
  return suite.agents.reduce((sum, a) => {
    const f = failures(a);
    return sum + f.golden + f.missed + f.errors + f.problems;
  }, 0);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The suite as plain ASCII lines: what a person reads in a terminal or on a docs page. */
export function formatEvalSuite(suite: EvalSuiteReport): string {
  const lines: string[] = [];
  const total: Failures = { golden: 0, missed: 0, errors: 0, problems: 0 };
  for (const a of suite.agents) {
    lines.push(`agent ${a.agentId}`);
    for (const p of a.problems) lines.push(`  problem: ${p}`);
    for (const r of a.results) {
      if (r.status === "fail")
        lines.push(`  FAILED  ${r.caseId}: ${r.failed.join(", ") || "an assertion failed"}`);
      else if (r.status === "missed") lines.push(`  MISSED  ${r.caseId}: no assertion caught it`);
      else if (r.status === "error") lines.push(`  ERROR   ${r.caseId}: ${r.detail ?? ""}`);
    }
    const ran = a.problems.length === 0;
    lines.push(
      ran && a.passRatePercent !== null
        ? `  pass rate     ${a.cases.passed} of ${a.cases.total} cases (${a.passRatePercent}%): golden ${a.golden.passed} of ${a.golden.total} pass, known-bad ${a.knownBad.caught} of ${a.knownBad.total} caught`
        : "  pass rate     not measured: the set was not run",
      ran && a.refusalRatePercent !== null
        ? `  refusal rate  ${a.refused} of ${a.cases.total} cases (${a.refusalRatePercent}%): the answer was stopped by schema, limits or no-write-call`
        : "  refusal rate  not measured: the set was not run",
      a.cost.measured
        ? `  cost          ${a.cost.micros} micro-units over ${plural(a.cost.cases, "case")} with a recorded answer`
        : "  cost          not measured: no case has a recorded answer",
    );
    lines.push("");
    const f = failures(a);
    total.golden += f.golden;
    total.missed += f.missed;
    total.errors += f.errors;
    total.problems += f.problems;
  }
  const count = evalFailureCount(suite);
  const parts = [
    total.golden ? `${plural(total.golden, "golden case")} failed` : "",
    total.missed ? `${plural(total.missed, "known-bad case")} not caught` : "",
    total.errors ? plural(total.errors, "error") : "",
    total.problems ? plural(total.problems, "set problem") : "",
  ].filter(Boolean);
  lines.push(
    count === 0
      ? "Result: every golden case passed and every known-bad case was caught."
      : `Result: FAILED (${plural(count, "problem")}: ${parts.join(", ")}).`,
  );
  return lines.join("\n");
}
