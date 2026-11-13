/**
 * The AG-09 eval harness through the gateway: an `EvalModel` that sends each case to one tier. With the
 * recorded fake behind the gateway the report is the replay's own; with a live adapter it is a manual run
 * (never in CI, docs/agent-evals.md) that goes through the same size, key, redaction and timeout rules.
 */
import type { EvalModel } from "../evals/types.js";
import type { ModelGateway, ModelTier } from "./types.js";

export function gatewayEvalModel(gateway: ModelGateway, tier: ModelTier): EvalModel {
  return {
    async complete({ caseId, agentId, prompt }) {
      const a = await gateway.complete({ tier, agentId, callId: caseId, prompt });
      return {
        text: a.text,
        ...(a.toolCalls ? { toolCalls: a.toolCalls } : {}),
        usage: a.usage,
      };
    },
  };
}
