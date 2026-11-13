/**
 * The model gateway (AG-19). One call goes through the same steps whatever the provider: the tier is chosen,
 * the size is checked, the key is read from the environment now, the prompt loses anything secret, the budget
 * is asked, the adapter is called with a timeout, and the answer is checked before anyone sees it. Nothing
 * here opens a connection, reads the process environment, logs, or reads a clock: the adapter sends, the
 * caller hands the environment in, and the timeout is a timer.
 */
import { redactForTrace } from "../agent-trace.js";
import { parseRecording } from "../evals/replay.js";
import { parseGatewayConfig } from "./config.js";
import { ModelGatewayError, type GatewayErrorCode } from "./errors.js";
import { ApiKey } from "./key.js";
import {
  MAX_ANSWER_CHARS,
  MAX_PROMPT_CHARS,
  MODEL_TIERS,
  type BudgetDecision,
  type BudgetEstimate,
  type BudgetHooks,
  type GatewayOptions,
  type ModelAdapter,
  type ModelAnswer,
  type ModelGateway,
  type ModelRequest,
  type ModelTier,
} from "./types.js";

/** The default budget: every call is allowed and nothing is counted. `createBudgetLedger` (AG-22) is the one with ceilings. */
export const NO_BUDGET: BudgetHooks = Object.freeze({
  before: () => ({ allowed: true }) as const,
  after: () => undefined,
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A key is one line of printable characters, without spaces. */
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;
/** Four characters to a token is the usual rough count; it is an estimate and a whole number. */
const CHARS_PER_TOKEN = 4;

const fail = (code: GatewayErrorCode, message: string, secrets: readonly string[] = []): never => {
  throw new ModelGatewayError(code, message, secrets);
};

/** The decision, if it is exactly a yes or a no with its reason; anything else is a refusal. */
function decision(d: unknown): BudgetDecision {
  if (d !== null && typeof d === "object") {
    const x = d as { allowed?: unknown; reason?: unknown };
    if (x.allowed === true) return { allowed: true };
    if (x.allowed === false && typeof x.reason === "string" && x.reason !== "")
      return { allowed: false, reason: x.reason };
  }
  return { allowed: false, reason: "the budget check gave no clear answer" };
}

export function createGateway(options: GatewayOptions): ModelGateway {
  const parsed = parseGatewayConfig(options.config);
  if (!parsed.ok)
    return fail("bad-config", `The model config is not valid: ${parsed.problems.join("; ")}`);
  const config = parsed.config;
  const providers = new Map<string, ModelAdapter>();
  for (const a of options.adapters) {
    if (providers.has(a.provider)) fail("bad-config", `Two adapters are named "${a.provider}".`);
    providers.set(a.provider, a);
  }
  const adapter = providers.get(config.provider);
  if (!adapter)
    return fail("unknown-provider", `There is no adapter for the provider "${config.provider}".`);
  if (adapter.needsKey && config.keyEnv === undefined)
    return fail(
      "bad-config",
      "This provider needs keyEnv: the name of the variable that holds the key.",
    );
  const budget = options.budget ?? NO_BUDGET;
  const maxChars = Math.min(config.maxInputChars, MAX_PROMPT_CHARS);

  /** Reads the key now, from the environment the caller hands in. Never kept. */
  function readKey(): ApiKey | undefined {
    if (!adapter!.needsKey) return undefined;
    const name = config.keyEnv!;
    let value: string | undefined;
    try {
      value = options.env()[name];
    } catch {
      return fail("missing-key", "The environment could not be read.");
    }
    if (value === undefined || value.trim() === "")
      return fail("missing-key", `The environment variable ${name} is not set.`);
    if (!KEY_SHAPE.test(value))
      return fail(
        "bad-key",
        `The value of ${name} cannot be a key: it has a space, a line break or a control character.`,
      );
    return new ApiKey(value);
  }

  async function call(request: ModelRequest): Promise<ModelAnswer> {
    if (request === null || typeof request !== "object")
      return fail("bad-request", "The request must be an object.");
    const tier = request.tier as unknown;
    if (typeof tier !== "string" || !(MODEL_TIERS as readonly string[]).includes(tier))
      return fail("unknown-tier", `The tier is not one of ${MODEL_TIERS.join(" and ")}.`);
    const model = config.tiers[tier as ModelTier];
    if (model === undefined)
      return fail("tier-not-configured", `The config names no model for the ${tier} tier.`);
    for (const [what, v] of [
      ["agentId", request.agentId],
      ["callId", request.callId],
    ] as const)
      if (typeof v !== "string" || !ID.test(v))
        return fail("bad-request", `${what} must be an id.`);
    const prompt: unknown = request.prompt;
    if (typeof prompt !== "string" || prompt === "")
      return fail("bad-request", "The prompt must be text and not empty.");
    if (prompt.length > maxChars)
      return fail(
        "input-too-large",
        `The prompt is over the ${maxChars} character limit; nothing was sent.`,
      );

    const key = readKey();
    const secret = key?.reveal();
    if (secret !== undefined && prompt.includes(secret))
      return fail("key-in-prompt", "The prompt holds the key; nothing was sent.");
    const sent = redactForTrace(prompt);

    const estimate: BudgetEstimate = {
      agentId: request.agentId,
      callId: request.callId,
      tier: tier as ModelTier,
      provider: config.provider,
      model,
      inputTokens: Math.ceil(sent.length / CHARS_PER_TOKEN),
      maxOutputTokens: config.maxOutputTokens,
    };
    let allowed: BudgetDecision;
    try {
      allowed = decision(await budget.before(estimate));
    } catch {
      allowed = { allowed: false, reason: "the budget check failed" };
    }
    if (!allowed.allowed)
      return fail(
        "budget",
        `The budget stopped the call: ${allowed.reason}.`,
        secret ? [secret] : [],
      );

    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: unknown;
    try {
      raw = await Promise.race([
        adapter!.complete({
          model,
          prompt: sent,
          callId: request.callId,
          maxOutputTokens: config.maxOutputTokens,
          signal: abort.signal,
          key,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(
              new ModelGatewayError(
                "timeout",
                `The provider did not answer within ${config.timeoutMs / 1000} seconds.`,
              ),
            );
          }, config.timeoutMs);
        }),
      ]);
    } catch (err) {
      const secrets = secret ? [secret] : [];
      if (err instanceof ModelGatewayError)
        throw new ModelGatewayError(err.code, err.message, secrets);
      const said = err instanceof Error ? err.message : "no message";
      return fail("provider-error", `The ${config.provider} adapter failed: ${said}`, secrets);
    } finally {
      clearTimeout(timer);
    }

    const rec = parseRecording(raw);
    if (!rec || rec.text.length > MAX_ANSWER_CHARS)
      return fail(
        "bad-answer",
        "The provider's answer is not in the expected shape, or is too long.",
      );
    try {
      await budget.after({ ...estimate, usage: rec.usage });
    } catch {
      // The call is made and paid for; failing here would lose the answer and undo nothing.
    }
    return {
      ...rec,
      provider: config.provider,
      model,
      tier: tier as ModelTier,
      advisory: true,
      redacted: sent !== prompt,
    };
  }

  return { provider: config.provider, complete: call };
}
