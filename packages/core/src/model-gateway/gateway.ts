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
import { shownProvider } from "./known.js";
import { ApiKey, isUsableKey } from "./key.js";
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

/** The gateways `createGateway` has made. A router accepts only these: an object built by hand could say it has a budget and spend none. */
const MADE = new WeakSet<object>();
export const isMadeGateway = (g: unknown): g is ModelGateway =>
  typeof g === "object" && g !== null && MADE.has(g);

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
    return fail(
      "unknown-provider",
      `There is no adapter for the provider ${shownProvider(config.provider)}.`,
    );
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
    if (!isUsableKey(value))
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

    const own: unknown = request.timeoutMs;
    if (own !== undefined && (typeof own !== "number" || !Number.isSafeInteger(own) || own < 1))
      return fail("bad-request", "timeoutMs must be a whole number of milliseconds, 1 or more.");
    const outer: unknown = request.signal;
    if (outer !== undefined && !(outer instanceof AbortSignal))
      return fail("bad-request", "signal must be an AbortSignal.");
    const limitMs = Math.min(config.timeoutMs, (own as number | undefined) ?? config.timeoutMs);

    // The call's clock starts here, before the budget check: a check that takes the whole limit leaves nothing
    // for the adapter, and once the call is aborted (by the limit or by the caller) nothing is ever sent.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), limitMs);
    const onOuter = () => abort.abort();
    if (outer?.aborted) abort.abort();
    else outer?.addEventListener("abort", onOuter, { once: true });
    const timedOut = () =>
      new ModelGatewayError(
        "timeout",
        `The provider did not answer within ${limitMs / 1000} seconds.`,
      );
    const expired = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(timedOut());
      else abort.signal.addEventListener("abort", () => reject(timedOut()), { once: true });
    });
    expired.catch(() => undefined); // it may never be raced: it is not an unhandled rejection
    const stopIfAborted = () => {
      if (abort.signal.aborted) throw timedOut();
    };

    let secret: string | undefined;
    let sent = "";
    let estimate: BudgetEstimate;
    let raw: unknown;
    try {
      stopIfAborted();
      const key = readKey();
      secret = key?.reveal();
      if (secret !== undefined && prompt.includes(secret))
        return fail("key-in-prompt", "The prompt holds the key; nothing was sent.");
      sent = redactForTrace(prompt);

      estimate = {
        agentId: request.agentId,
        callId: request.callId,
        tier: tier as ModelTier,
        provider: config.provider,
        model,
        inputTokens: Math.ceil(sent.length / CHARS_PER_TOKEN),
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: limitMs,
      };
      let allowed: BudgetDecision;
      try {
        allowed = decision(await Promise.race([Promise.resolve(budget.before(estimate)), expired]));
      } catch {
        // The call's own time ran out while the check was still running: that is a timeout, not a refusal.
        if (abort.signal.aborted) throw timedOut();
        allowed = { allowed: false, reason: "the budget check failed" };
      }
      // After every await: a call that has been aborted never reaches the adapter, however the check ended.
      stopIfAborted();
      if (!allowed.allowed)
        return fail(
          "budget",
          `The budget stopped the call: ${allowed.reason}.`,
          secret ? [secret] : [],
        );

      raw = await Promise.race([
        adapter!.complete({
          model,
          prompt: sent,
          callId: request.callId,
          maxOutputTokens: config.maxOutputTokens,
          signal: abort.signal,
          key,
        }),
        expired,
      ]);
    } catch (err) {
      const secrets = secret ? [secret] : [];
      // The class is the adapter's: kept, never worked out from the message. A plain Error has none.
      if (err instanceof ModelGatewayError)
        throw new ModelGatewayError(err.code, err.message, secrets, err.failure);
      const said = err instanceof Error ? err.message : "no message";
      return fail("provider-error", `The ${config.provider} adapter failed: ${said}`, secrets);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
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

  // Frozen, with the budget it was given: `complete` and `budget` cannot be assigned, redefined or deleted, so a
  // made gateway cannot be turned into one that skips its ceilings.
  if (options.budget) Object.freeze(options.budget);
  const gateway: ModelGateway = Object.freeze({
    provider: config.provider,
    budget,
    complete: call,
  });
  MADE.add(gateway);
  return gateway;
}
