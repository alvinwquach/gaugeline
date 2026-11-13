/**
 * The eval sets that ship (AG-11): one entry per agent, each its agent, its cases and the model answers
 * recorded for them. A set is run by `run()`, which builds the replay model from the recordings and nothing
 * else, so no set can reach a network, a key or a clock. There is no live mode: pointing a set at a real
 * model is manual work outside this repository and never in CI (see docs/agent-evals.md).
 */
import { triage } from "./example/triage.js";
import { createReplayModel } from "./replay.js";
import { runEvals } from "./run.js";
import type { EvalAgent, EvalCase, EvalRecording, EvalReport } from "./types.js";

/** What the suite runner needs from a set: the agent's id and a way to run it offline. */
export interface EvalSet {
  readonly agentId: string;
  run(): Promise<EvalReport>;
}

/**
 * An eval set from an agent, its cases and its recordings. The replay model is built when the set runs,
 * so a recording that is not well formed is that agent's problem to report, not a crash at import time.
 */
export function defineEvalSet<O>(parts: {
  agent: EvalAgent<O>;
  cases: readonly EvalCase[];
  recordings: ReadonlyMap<string, EvalRecording>;
}): EvalSet {
  return {
    agentId: parts.agent.id,
    run: () => runEvals(parts.agent, parts.cases, createReplayModel(parts.recordings)),
  };
}

/** Every eval set the command runs, in the order it reports them. AG-12 onward add the real agents here. */
export const EVAL_SETS: readonly EvalSet[] = [defineEvalSet(triage)];
