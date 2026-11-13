import type { EvalRecording } from "../../evals/types.js";
import { createGateway } from "../gateway.js";
import type { AdapterCall, GatewayOptions, ModelAdapter, GatewayConfig } from "../types.js";

/** Key-shaped test values are built from pieces so no key-looking literal sits in the repository. */
export const KEY_NAME = "EXAMPLE_PROVIDER_API_KEY";
/** An invented key value that no pattern matches: it can only be found by comparing with it. */
export const PLAIN_KEY = ["demo", "value", "A1b2C3d4E5f6G7h8I9j0"].join("-");
/** An invented value with the characters that a URL, a header and JSON each write differently. */
export const ODD_KEY = "demo+value/with=chars1234";
/** An invented value in the shape of a payment secret key. */
export const SHAPED_KEY = ["sk", "live", "q".repeat(24)].join("_");

export const CONFIG: GatewayConfig = {
  provider: "test",
  keyEnv: KEY_NAME,
  tiers: { fast: "small-model", strong: "large-model" },
  timeoutMs: 5_000,
  maxInputChars: 100_000,
  maxOutputTokens: 1_024,
};

export const ANSWER: EvalRecording = {
  text: '{"groups":[]}',
  usage: { inputTokens: 40, outputTokens: 10, costMicros: 1_200, latencyMs: 300 },
};

/** An adapter that records what it was called with and answers with `answer` (or runs `run`). */
export function testAdapter(run?: (call: AdapterCall) => Promise<unknown>) {
  const calls: AdapterCall[] = [];
  const adapter: ModelAdapter = {
    provider: "test",
    needsKey: true,
    async complete(call) {
      calls.push(call);
      return run ? run(call) : { ...ANSWER };
    },
  };
  return { adapter, calls };
}

export const REQUEST = {
  tier: "fast",
  agentId: "triage",
  callId: "call-1",
  prompt: "Group these findings by cause.",
} as const;

/** A gateway over a test adapter, with the key set in a mutable environment. */
export function setup(
  opts: {
    run?: (call: AdapterCall) => Promise<unknown>;
    config?: Partial<GatewayConfig>;
    env?: Record<string, string | undefined>;
    budget?: GatewayOptions["budget"];
  } = {},
) {
  const env: Record<string, string | undefined> = opts.env ?? { [KEY_NAME]: PLAIN_KEY };
  let reads = 0;
  const { adapter, calls } = testAdapter(opts.run);
  const gateway = createGateway({
    config: { ...CONFIG, ...opts.config },
    adapters: [adapter],
    env: () => {
      reads += 1;
      return env;
    },
    ...(opts.budget ? { budget: opts.budget } : {}),
  });
  return { gateway, calls, env, reads: () => reads };
}
