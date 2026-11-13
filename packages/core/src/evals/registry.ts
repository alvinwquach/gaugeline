/**
 * The eval sets that ship (AG-11): one entry per agent, in the order `gaugeline evals` reports them. Each
 * agent's own eval module supplies its cases and an offline model (a replay of recorded answers, or the
 * agent's plain code), so no set can reach a network, a key or a clock. A new agent adds its set here.
 * This file is not exported from `evals/index.ts`: the agents import that index, and this one imports them.
 */
import { triageEvalAgent, triageEvalCases, createTriageEvalModel } from "../agents/triage/evals.js";
import {
  approvalsDigestAgent,
  approvalsDigestCases,
  createApprovalsDigestModel,
} from "../approvals-digest/evals.js";
import { defineEvalSet, type EvalSet } from "./sets.js";

export const EVAL_SETS: readonly EvalSet[] = [
  defineEvalSet({
    agent: approvalsDigestAgent,
    cases: approvalsDigestCases,
    model: createApprovalsDigestModel,
  }),
  defineEvalSet({
    agent: triageEvalAgent,
    cases: triageEvalCases,
    model: () => createTriageEvalModel(),
  }),
];
