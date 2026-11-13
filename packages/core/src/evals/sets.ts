/**
 * What the suite runner needs from an eval set (AG-11): an agent's id and a way to run its cases offline.
 * The model comes from a factory that is called when the set runs, so a recording that is not well formed
 * is that agent's problem to report, not a crash at import time. There is no live mode: pointing a set at
 * a real model is manual work outside this repository and never in CI (see docs/agent-evals.md).
 */
import { runEvals } from "./run.js";
import type { EvalAgent, EvalCase, EvalModel, EvalReport } from "./types.js";

export interface EvalSet {
  readonly agentId: string;
  run(): Promise<EvalReport>;
}

/** An eval set from an agent, its cases and the offline model that answers them (a replay, or the agent's own code). */
export function defineEvalSet<O>(parts: {
  agent: EvalAgent<O>;
  cases: readonly EvalCase[];
  model: () => EvalModel;
}): EvalSet {
  return {
    agentId: parts.agent.id,
    run: () => runEvals(parts.agent, parts.cases, parts.model()),
  };
}
