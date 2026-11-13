/**
 * The check an answer must pass before the router accepts it. A check is plain code: the same answer gives the
 * same verdict. For an agent built on the AG-09 harness, `agentAnswerCheck` runs the same schema, cited-id,
 * invented-number and write-call assertions the eval set runs, on a live answer.
 */
import { checkCitedIds, checkNoInventedNumbers, checkNoWriteCall } from "../evals/assertions.js";
import type { EvalAgent, EvalAssertionResult, EvalInput } from "../evals/types.js";
import { sanitise } from "../untrusted.js";
import type { ModelAnswer } from "./types.js";

export type CheckVerdict<O> = { ok: true; value: O } | { ok: false; issues: readonly string[] };
export type AnswerCheck<O> = (answer: ModelAnswer) => CheckVerdict<O> | Promise<CheckVerdict<O>>;

/** The fixed reasons the router and the agent check give when they have nothing more specific. */
export const AGENT_ANSWER_ISSUES = Object.freeze({
  notJson: "schema: the answer is not valid JSON",
  checkFailed: "the check could not run on this answer",
});

const say = (r: EvalAssertionResult): string =>
  `${r.id}: ${sanitise(r.detail ?? "failed", 120).text}`;

/** The check for an AG-09 agent and the input it was asked about. */
export function agentAnswerCheck<O>(agent: EvalAgent<O>, input: EvalInput): AnswerCheck<O> {
  return (answer) => {
    let json: unknown;
    try {
      json = JSON.parse(answer.text);
    } catch {
      return { ok: false, issues: [AGENT_ANSWER_ISSUES.notJson] };
    }
    const parsed = agent.parse(json);
    if (!parsed.ok)
      return { ok: false, issues: parsed.issues.map((i) => `schema: ${sanitise(i, 120).text}`) };
    const out = parsed.value;
    const cited = agent.citedIds(out);
    const failed = [
      checkCitedIds(input, cited),
      checkNoInventedNumbers(
        input,
        agent.prose(out),
        agent.derivedNumbers?.(input, out) ?? [],
        cited,
      ),
      checkNoWriteCall(agent.tools, answer.toolCalls ?? []),
    ].filter((r) => r.status === "fail");
    return failed.length > 0 ? { ok: false, issues: failed.map(say) } : { ok: true, value: out };
  };
}
