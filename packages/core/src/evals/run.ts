/**
 * The eval runner (AG-09). It takes an agent, its cases and a model, and returns a report. Offline by
 * construction: the model is whatever it is handed (a recorded fake in the test run), the policy is asked at
 * a fixed time with an empty environment, and there is no process exit. A model-judged opinion is recorded
 * as advisory or unsure and never changes a status.
 */
import { createAgentPolicy, type AgentDenyReason } from "../agent-policy.js";
import { sanitise } from "../untrusted.js";
import {
  checkCitedIds,
  checkLimits,
  checkNoInventedNumbers,
  checkNoWriteCall,
  inputChars,
  isWriteTool,
} from "./assertions.js";
import { parseRecording } from "./replay.js";
import {
  EVAL_ASSERTIONS,
  EVAL_EPOCH_MS,
  EVAL_MODEL_TOOL,
  MAX_EVAL_INPUT_CHARS,
  type EvalAssertionResult,
  type EvalAgent,
  type EvalCase,
  type EvalCaseResult,
  type EvalJudge,
  type EvalJudgement,
  type EvalModel,
  type EvalRecording,
  type EvalReport,
  type EvalParse,
} from "./types.js";

const text = (v: unknown, max = 160): string => sanitise(String(v), max).text;
const skipped = (): EvalAssertionResult[] =>
  EVAL_ASSERTIONS.map((id) => ({ id, status: "skipped" as const }));

function agentPolicy<O>(agent: EvalAgent<O>) {
  const tools = [EVAL_MODEL_TOOL, ...agent.tools];
  return createAgentPolicy({
    tools,
    agents: new Map([[agent.id, { status: "active", tools, limits: agent.limits }]]),
    env: {}, // the operator's environment never reaches an eval
    now: () => EVAL_EPOCH_MS,
  });
}

/** Problems with the agent or its cases that stop a set from running. Empty when it is sound. */
export function validateEvalSet<O>(agent: EvalAgent<O>, cases: readonly EvalCase[]): string[] {
  const out: string[] = [];
  for (const t of agent.tools)
    if (isWriteTool(t))
      out.push(`The agent's tool "${text(t)}" is a write tool; agents only draft.`);
  try {
    agentPolicy(agent);
  } catch (err) {
    out.push(`The agent's limits are not valid: ${text(err instanceof Error ? err.message : err)}`);
  }
  if (!cases.some((c) => c.kind === "golden")) out.push("The set has no golden case.");
  if (!cases.some((c) => c.kind === "known-bad")) out.push("The set has no known-bad case.");
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) out.push(`duplicate case id "${text(c.id)}"`);
    seen.add(c.id);
    const ids = c.input.findings.map((f) => f.id);
    if (new Set(ids).size !== ids.length) out.push(`Case "${text(c.id)}" repeats a finding id.`);
    if (c.kind === "known-bad") {
      if (c.catches.length === 0)
        out.push(`Known-bad case "${text(c.id)}" names no assertion it catches.`);
      for (const a of c.catches)
        if (!(EVAL_ASSERTIONS as readonly string[]).includes(a))
          out.push(`Case "${text(c.id)}" names an unknown assertion "${text(a)}".`);
    } else
      for (const m of c.mustCite ?? [])
        if (!ids.includes(m))
          out.push(
            `Case "${text(c.id)}" must cite "${text(m)}", which is not an input finding id.`,
          );
  }
  return out;
}

/** The policy's refusal for the model call and the allowed tool calls the recording made, or null. */
function policyDenial<O>(agent: EvalAgent<O>, rec: EvalRecording): AgentDenyReason | null {
  const policy = agentPolicy(agent);
  const first = policy.decide({
    agentId: agent.id,
    tool: EVAL_MODEL_TOOL,
    costMicros: rec.usage.costMicros,
    receivedAtMs: EVAL_EPOCH_MS - rec.usage.latencyMs,
  });
  if (!first.allowed) return first.reason;
  for (const call of rec.toolCalls ?? []) {
    // A write or an unlisted tool is the no-write-call assertion's business, not a rate to count.
    if (isWriteTool(call.tool) || !agent.tools.includes(call.tool)) continue;
    const d = policy.decide({ agentId: agent.id, tool: call.tool, costMicros: 0 });
    if (!d.allowed) return d.reason;
  }
  return null;
}

async function judged(judge: EvalJudge, req: Parameters<EvalJudge>[0]): Promise<EvalJudgement> {
  try {
    const j = (await judge(req)) as Partial<EvalJudgement> | null;
    if (j && (j.verdict === "advisory" || j.verdict === "unsure"))
      return {
        verdict: j.verdict,
        ...(typeof j.note === "string" ? { note: text(j.note, 200) } : {}),
      };
    return {
      verdict: "unsure",
      note: "The judge gave a verdict that is neither advisory nor unsure.",
    };
  } catch {
    return { verdict: "unsure", note: "The judge did not answer." };
  }
}

async function runCase<O>(
  agent: EvalAgent<O>,
  c: EvalCase,
  model: EvalModel,
  judge: EvalJudge | undefined,
): Promise<EvalCaseResult> {
  const base = { caseId: c.id, kind: c.kind, costMicros: 0, latencyMs: 0 };
  const verdict = (assertions: EvalAssertionResult[]): EvalCaseResult["status"] => {
    const failed = new Set(assertions.filter((a) => a.status === "fail").map((a) => a.id));
    if (c.kind === "golden") return assertions.every((a) => a.status === "pass") ? "pass" : "fail";
    return c.catches.every((id) => failed.has(id)) ? "caught" : "missed";
  };
  try {
    const chars = inputChars(c.input);
    if (chars > MAX_EVAL_INPUT_CHARS) {
      // Fail closed before a prompt is built: an oversized input never reaches the model.
      const assertions = skipped().map((a) => (a.id === "limits" ? checkLimits(chars, null) : a));
      return { ...base, status: verdict(assertions), assertions };
    }
    const answer = await model.complete({
      caseId: c.id,
      agentId: agent.id,
      prompt: agent.buildPrompt(c.input),
      input: c.input,
    });
    const rec = parseRecording(answer);
    if (!rec)
      return {
        ...base,
        status: "error",
        assertions: skipped(),
        detail: "The model's answer is not well formed.",
      };

    let parsed: EvalParse<O>;
    try {
      parsed = agent.parse(JSON.parse(rec.text));
    } catch {
      parsed = { ok: false, issues: ["the output is not valid JSON"] };
    }
    const calls = rec.toolCalls ?? [];
    const out = parsed.ok ? parsed.value : undefined;
    const cited = out === undefined ? [] : agent.citedIds(out);
    const mustCite = c.kind === "golden" ? (c.mustCite ?? []) : [];
    const lacking = mustCite.filter((id) => !cited.includes(id));
    const assertions: EvalAssertionResult[] =
      out === undefined
        ? [
            {
              id: "schema",
              status: "fail",
              detail: parsed.ok
                ? ""
                : parsed.issues
                    .slice(0, 3)
                    .map((i) => text(i, 80))
                    .join("; "),
            },
            { id: "cited-ids", status: "skipped" },
            checkNoWriteCall(agent.tools, calls),
            { id: "no-invented-numbers", status: "skipped" },
            checkLimits(chars, policyDenial(agent, rec)),
            { id: "must-cite", status: "skipped" },
          ]
        : [
            { id: "schema", status: "pass" },
            checkCitedIds(c.input, cited),
            checkNoWriteCall(agent.tools, calls),
            checkNoInventedNumbers(
              c.input,
              agent.prose(out),
              agent.derivedNumbers?.(c.input, out) ?? [],
              cited,
            ),
            checkLimits(chars, policyDenial(agent, rec)),
            lacking.length
              ? {
                  id: "must-cite",
                  status: "fail",
                  detail: `does not cite ${lacking.map((i) => text(i, 40)).join(", ")}`,
                }
              : { id: "must-cite", status: "pass" },
          ];
    const result: EvalCaseResult = {
      ...base,
      costMicros: rec.usage.costMicros,
      latencyMs: rec.usage.latencyMs,
      status: verdict(assertions),
      assertions,
    };
    if (judge && out !== undefined)
      result.judged = await judged(judge, { caseId: c.id, input: c.input, output: out });
    return result;
  } catch (err) {
    return {
      ...base,
      status: "error",
      assertions: skipped(),
      detail: text(err instanceof Error ? err.message : err),
    };
  }
}

/** Runs every case, in order, one at a time. Never throws for a bad case: that case is an error result. */
export async function runEvals<O>(
  agent: EvalAgent<O>,
  cases: readonly EvalCase[],
  model: EvalModel,
  opts: { judge?: EvalJudge } = {},
): Promise<EvalReport> {
  const problems = validateEvalSet(agent, cases);
  const results: EvalCaseResult[] = [];
  if (problems.length === 0)
    for (const c of cases) results.push(await runCase(agent, c, model, opts.judge));
  const count = (kind: EvalCase["kind"]) => cases.filter((c) => c.kind === kind).length;
  const n = (status: EvalCaseResult["status"]) => results.filter((r) => r.status === status).length;
  return {
    agentId: agent.id,
    results,
    problems,
    golden: { total: count("golden"), passed: n("pass") },
    knownBad: { total: count("known-bad"), caught: n("caught") },
    costMicros: results.reduce((sum, r) => sum + r.costMicros, 0),
    ok: problems.length === 0 && results.every((r) => r.status === "pass" || r.status === "caught"),
  };
}

/** The report as plain ASCII lines: what a person reads in a terminal or on a docs page. */
export function formatEvalReport(report: EvalReport): string {
  const width = Math.max(0, ...report.results.map((r) => r.caseId.length));
  const lines = [
    `agent ${report.agentId}: ${report.golden.total} golden, ${report.knownBad.total} known-bad`,
  ];
  for (const p of report.problems) lines.push(`problem: ${p}`);
  for (const r of report.results) {
    const failed = r.assertions.filter((a) => a.status === "fail").map((a) => a.id);
    const outcome =
      r.status === "pass" || r.status === "caught"
        ? r.status === "caught"
          ? `caught (${failed.join(", ")})`
          : "pass"
        : r.status === "error"
          ? `error: ${r.detail ?? ""}`
          : r.status === "missed"
            ? "MISSED: no assertion caught it"
            : `FAIL (${failed.join(", ")})`;
    lines.push(`${r.kind.padEnd(9)}  ${r.caseId.padEnd(width)}  ${outcome}`);
  }
  lines.push(
    report.problems.length
      ? "not run: fix the problems above"
      : `golden ${report.golden.passed}/${report.golden.total} pass; known-bad ${report.knownBad.caught}/${report.knownBad.total} caught; cost ${report.costMicros} micro-units`,
  );
  return lines.join("\n");
}
