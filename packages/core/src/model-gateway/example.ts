/**
 * The program shown on docs/model-gateway.md. A test runs it and compares what it returns with the page, word
 * for word, and checks that every line of the page's code is a line of this file.
 */
import {
  ModelGatewayError,
  createGateway,
  createRecordedAdapter,
  shownModelId,
  shownProvider,
} from "./index.js";

export async function runExample(): Promise<string> {
  // What a config file holds: a provider and a model id per tier. Never a key, never a host.
  const config = {
    provider: "recorded",
    tiers: { fast: "recorded-small", strong: "recorded-large" },
  };
  // One answer a model gave once, recorded under the id of the call that asked for it.
  const answers = new Map([
    [
      "reword-1",
      {
        text: "The menu link on the pop-up page is broken. Point it at the live menu page.",
        usage: { inputTokens: 52, outputTokens: 14, costMicros: 800, latencyMs: 410 },
      },
    ],
  ]);
  const gateway = createGateway({
    config,
    adapters: [createRecordedAdapter(answers)],
    env: () => ({}),
  });
  const out: string[] = [];

  const answer = await gateway.complete({
    tier: "fast",
    agentId: "triage",
    callId: "reword-1",
    prompt: `Reword for the owner: the menu link gives a 404. Reply to ${["baker", "example.test"].join("@")}`,
  });
  out.push(
    `tier ${answer.tier} -> model ${shownModelId(answer.provider, answer.model)} (provider ${shownProvider(answer.provider)})`,
  );
  out.push(`text: ${answer.text}`);
  out.push(
    `usage: ${answer.usage.inputTokens} in, ${answer.usage.outputTokens} out, ${answer.usage.costMicros} micro-units`,
  );
  out.push(`advisory: ${answer.advisory}, redacted: ${answer.redacted}`);

  for (const [what, request] of [
    ["unknown tier", { tier: "ultra", agentId: "triage", callId: "reword-1", prompt: "Hi" }],
    [
      "oversized prompt",
      { tier: "fast", agentId: "triage", callId: "reword-1", prompt: "a".repeat(100_001) },
    ],
  ] as const) {
    try {
      await gateway.complete(request as never);
    } catch (err) {
      if (!(err instanceof ModelGatewayError)) throw err;
      out.push(`${what}: refused (${err.code})`);
    }
  }
  return out.join("\n");
}
