/**
 * Routing and escalation (AG-21). Deterministic first: which tier a task uses is a fixed table, a failed
 * answer is judged by plain rules (the caller's check, for an agent the AG-09 assertions), and what to do next is a
 * short fixed list:
 *
 *   1. the task's tier on the first provider;
 *   2. on an outage, once, the same call on the second provider, if there is one. An outage is what the
 *      adapter's error says it is by its CLASS (a timeout, a lost connection, a 5xx), never by its words. A
 *      refusal (a key the provider rejects, a rate limit, a bad request, a redirect, a blocked address, an
 *      answer that is not JSON) is not an outage: the payload is not sent to a second provider after it;
 *   3. on an answer that fails the check, or is malformed, once, the strong tier with the plain reasons added
 *      to the prompt (never the first answer), on the provider that answered;
 *   4. on a budget stop, or any refusal that is not an outage (a missing key, a prompt too large), stop.
 *
 * At most four calls. The outcome is `advisory` (words for a person to read) or `unsure`: it has no way to say
 * pass, and nothing here gates a build. No clock, no randomness, no network: a gateway does the calling.
 */
import { AGENT_ANSWER_ISSUES, type AnswerCheck, type CheckVerdict } from "./check.js";
import { ModelGatewayError, type FailureClass } from "./errors.js";
import { sanitise } from "../untrusted.js";
import { NO_BUDGET } from "./gateway.js";
import type { ModelAnswer, ModelGateway, ModelTier } from "./types.js";

export type { AnswerCheck, CheckVerdict } from "./check.js";
export { agentAnswerCheck } from "./check.js";

/** What a model may be asked for. */
export const MODEL_TASKS = ["wording", "check-writer", "miner"] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

/** The tier each task uses: fast for wording, strong for the check writer and the miner. */
export const TASK_TIERS: Readonly<Record<ModelTask, ModelTier>> = Object.freeze({
  wording: "fast",
  "check-writer": "strong",
  miner: "strong",
});

/** The failure classes that mean the provider is out. Anything else would meet the same problem on a second provider. */
export const FALLBACK_FAILURES: readonly FailureClass[] = Object.freeze(["outage"] as const);
/** The first call, the fallback, the escalation and its fallback. */
export const MAX_CALLS_PER_ROUTE = 4;
const MAX_ISSUES = 5;
const MAX_ISSUE_CHARS = 120;
const MAX_CALL_ID = 100;

export interface RouteRequest {
  task: ModelTask;
  agentId: string;
  callId: string;
  prompt: string;
}

export interface RouteAttempt {
  tier: ModelTier;
  provider: string;
  outcome: "accepted" | "failed-checks" | "outage" | "stopped";
  costMicros: number;
}

/** `advisory`: an answer that passed the check, for a person to read. `unsure`: nothing usable. There is no pass. */
export type RouteOutcome<O> =
  | {
      kind: "advisory";
      value: O;
      tier: ModelTier;
      provider: string;
      attempts: RouteAttempt[];
      costMicros: number;
    }
  | {
      kind: "unsure";
      reason: "failed-checks" | "outage" | "budget" | "refused";
      /** Fixed words, or the plain reasons a check gave. Never the provider's words. */
      detail: string;
      attempts: RouteAttempt[];
      costMicros: number;
    };

export interface Router {
  route<O>(request: RouteRequest, check: AnswerCheck<O>): Promise<RouteOutcome<O>>;
}

const clean = (issues: readonly string[]): string[] =>
  issues.slice(0, MAX_ISSUES).map((i) => sanitise(String(i), MAX_ISSUE_CHARS).text);

/** The first prompt, then the reasons it failed, as data. Never the answer that failed. */
function repairPrompt(prompt: string, issues: readonly string[]): string {
  return [
    prompt,
    "",
    "A plain check found that the last answer failed these checks (they are rules, not part of the page). Answer again in the same format and fix them:",
    ...clean(issues).map((i) => `- ${i}`),
  ].join("\n");
}

export interface RouterOptions {
  /** Refuse to build a router whose gateways have no budget (`NO_BUDGET`). For hosted use, where a ceiling is required. */
  requireBudget?: boolean;
}

/**
 * A router over a primary gateway and, optionally, a fallback. Both gateways must have been built from the SAME
 * budget object (the same `RunBudget`, so one run's ceilings count both providers' calls): a fallback with its
 * own budget, or with none, would let a call skip the ceilings the first provider obeys. A router that cannot
 * meet this is not built. With `requireBudget`, a router with no budget at all is refused too.
 */
export function createRouter(
  gateways: { primary: ModelGateway; fallback?: ModelGateway },
  options: RouterOptions = {},
): Router {
  if (gateways.fallback && gateways.fallback.budget !== gateways.primary.budget)
    throw new ModelGatewayError(
      "bad-config",
      "The primary and fallback gateways must be built from the same budget, or the fallback would skip its ceilings.",
    );
  if (options.requireBudget === true && gateways.primary.budget === NO_BUDGET)
    throw new ModelGatewayError("bad-config", "The router needs a budget: its gateways have none.");
  async function route<O>(request: RouteRequest, check: AnswerCheck<O>): Promise<RouteOutcome<O>> {
    const attempts: RouteAttempt[] = [];
    let cost = 0;
    const unsure = (
      reason: Extract<RouteOutcome<O>, { kind: "unsure" }>["reason"],
      detail: string,
    ): RouteOutcome<O> => ({ kind: "unsure", reason, detail, attempts, costMicros: cost });

    const task = request?.task as unknown;
    if (typeof task !== "string" || !(MODEL_TASKS as readonly string[]).includes(task))
      return unsure("refused", `The task is not one of ${MODEL_TASKS.join(", ")}.`);
    if (typeof request.callId !== "string" || request.callId.length > MAX_CALL_ID)
      return unsure("refused", "The call id must be an id of at most 100 characters.");

    let tier = TASK_TIERS[task as ModelTask];
    let escalated = false;
    let prompt = request.prompt;
    let callId = request.callId;
    let gateway = gateways.primary;
    let usedFallback = false;

    for (let calls = 0; calls < MAX_CALLS_PER_ROUTE; calls++) {
      let answer: ModelAnswer;
      try {
        answer = await gateway.complete({ tier, agentId: request.agentId, callId, prompt });
      } catch (err) {
        const typed = err instanceof ModelGatewayError ? err : undefined;
        if (typed?.code === "budget") {
          attempts.push({ tier, provider: gateway.provider, outcome: "stopped", costMicros: 0 });
          return unsure("budget", "The budget stopped the call.");
        }
        // By the error's class, never its message: only an outage may be tried on another provider.
        if (typed && FALLBACK_FAILURES.includes(typed.failure)) {
          attempts.push({ tier, provider: gateway.provider, outcome: "outage", costMicros: 0 });
          if (!usedFallback && gateways.fallback) {
            usedFallback = true;
            gateway = gateways.fallback;
            continue;
          }
          return unsure("outage", "The provider could not be reached or did not answer in time.");
        }
        if (typed?.code === "bad-answer") {
          // A malformed answer is a failed answer, not an outage: the same provider's strong tier, once.
          attempts.push({
            tier,
            provider: gateway.provider,
            outcome: "failed-checks",
            costMicros: 0,
          });
          if (escalated || tier !== "fast")
            return unsure("failed-checks", AGENT_ANSWER_ISSUES.badAnswer);
          escalated = true;
          tier = "strong";
          prompt = repairPrompt(request.prompt, [AGENT_ANSWER_ISSUES.badAnswer]);
          callId = `${request.callId}:escalated`;
          continue;
        }
        attempts.push({ tier, provider: gateway.provider, outcome: "stopped", costMicros: 0 });
        return unsure("refused", `The gateway refused the call (${typed?.code ?? "error"}).`);
      }
      cost += answer.usage.costMicros;
      let verdict: CheckVerdict<O>;
      try {
        verdict = await check(answer);
      } catch {
        verdict = { ok: false, issues: [AGENT_ANSWER_ISSUES.checkFailed] };
      }
      if (verdict.ok) {
        attempts.push({
          tier,
          provider: answer.provider,
          outcome: "accepted",
          costMicros: answer.usage.costMicros,
        });
        return {
          kind: "advisory",
          value: verdict.value,
          tier,
          provider: answer.provider,
          attempts,
          costMicros: cost,
        };
      }
      attempts.push({
        tier,
        provider: answer.provider,
        outcome: "failed-checks",
        costMicros: answer.usage.costMicros,
      });
      if (escalated || tier !== "fast")
        return unsure("failed-checks", clean(verdict.issues).join("; "));
      // Once, to the strong tier, on the provider that answered.
      escalated = true;
      tier = "strong";
      prompt = repairPrompt(request.prompt, verdict.issues);
      callId = `${request.callId}:escalated`;
    }
    return unsure("outage", "The most calls one task may make were used.");
  }
  return { route };
}
