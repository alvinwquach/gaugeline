/**
 * The AG-09 eval harness through the gateway: an `EvalModel` that sends each case to one tier. With the
 * recorded fake behind the gateway the report is the replay's own; with a live adapter it is a manual run
 * (never in CI, docs/agent-evals.md) that goes through the same size, key, privacy and timeout rules.
 *
 * What is sent is the case's findings (id, check id, severity, title and the evidence as a snippet) and a fixed
 * task template, never the harness's own prompt, which carries every finding whole. A case's page text,
 * page addresses and hosted reads are left out: the gateway sends findings, snippets and ids only (AG-23).
 */
import type { EvalInput, EvalModel } from "../evals/types.js";
import { ModelGatewayError } from "./errors.js";
import type { ModelFinding, ModelInput } from "./privacy.js";
import type { ModelGateway, ModelTier } from "./types.js";

/** What the gateway is sent for one eval case: the findings only (id, severity, title, evidence as a snippet). */
export function evalInputToModelInput(input: EvalInput): ModelInput {
  const findings: ModelFinding[] = input.findings.map((f) => ({
    id: f.id,
    ...(f.severity ? { severity: f.severity } : {}),
    title: f.title,
    ...(f.evidence === "" ? {} : { snippet: f.evidence }),
  }));
  return { task: { template: "answer-as-json" }, findings };
}

export function gatewayEvalModel(gateway: ModelGateway, tier: ModelTier): EvalModel {
  return {
    async complete({ caseId, agentId, input }) {
      if (input === undefined)
        throw new ModelGatewayError(
          "bad-request",
          "The eval case carried no input to send; nothing was sent.",
        );
      const a = await gateway.complete({
        tier,
        agentId,
        callId: caseId,
        input: evalInputToModelInput(input),
      });
      return {
        text: a.text,
        ...(a.toolCalls ? { toolCalls: a.toolCalls } : {}),
        usage: a.usage,
      };
    },
  };
}
