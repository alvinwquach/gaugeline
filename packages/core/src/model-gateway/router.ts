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
 * At most three calls (the first, one fallback, one escalation: no order of failures makes a fourth), and a
 * deadline on the time all of them take together. The outcome is `advisory` (words for
 * a person to read) or `unsure`: it has no way to say pass, and nothing here gates a build. No randomness and no
 * network: a gateway does the calling. The only clock is a monotonic reading handed in (`now`), used for the
 * deadline, which holds inside a call too: each call gets the time left as its own limit, the router stops waiting
 * at the deadline, and a late answer is not used.
 */
import { AGENT_ANSWER_ISSUES, type AnswerCheck, type CheckVerdict } from "./check.js";
import { ModelGatewayError, type FailureClass } from "./errors.js";
import { sanitise } from "../untrusted.js";
import { NO_BUDGET, isMadeGateway } from "./gateway.js";
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
/**
 * The first call, one fallback and one escalation. The worst case is an escalation that meets an outage, or an
 * outage whose fallback then fails the check: three calls, and a test runs every script of up to three steps per
 * provider to show there is no fourth.
 */
export const MAX_CALLS_PER_ROUTE = 3;
/** The time all the calls of one task may take together, from the start of the task. A call in flight still has its own timeout. */
export const DEFAULT_ROUTE_DEADLINE_MS = 120_000;
const MIN_DEADLINE_MS = 1_000;
/** What `within` rejects with when the time is up. Never leaves this module. */
const OUT_OF_TIME = Symbol("out of time");
const MAX_DEADLINE_MS = 600_000;
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
      reason: "failed-checks" | "outage" | "budget" | "refused" | "deadline" | "calls";
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
  /**
   * Say the router has no budget. Allowed only when no gateway has one; refused when any budget is configured.
   * Without it a router needs a budget: a model call with no ceiling is something a person must ask for.
   */
  unmetered?: boolean;
  /** The most calls for one task, 1 to 3 (default 3). It can be lowered, never raised. */
  maxCalls?: number;
  /** The most time all the calls of one task may take together, in whole milliseconds, 1000 to 600000 (default 120000). */
  deadlineMs?: number;
  /** A monotonic reading in milliseconds (default `performance.now`). Tests hand one in. */
  now?: () => number;
}

/**
 * A router over a primary gateway and, optionally, a fallback. Three things must hold, or it is not built:
 * both gateways were made by `createGateway` (an object built by hand could claim a budget and spend none);
 * they share the SAME budget object (the same `RunBudget`, so one run's ceilings count both providers' calls: a
 * fallback with its own budget, or none, would let a call skip the ceilings the first provider obeys); and there
 * is a budget at all, unless `unmetered: true` says otherwise, which is itself refused when any budget exists.
 */
export function createRouter(
  gateways: { primary: ModelGateway; fallback?: ModelGateway },
  options: RouterOptions = {},
): Router {
  for (const g of [gateways.primary, gateways.fallback])
    if (g !== undefined && !isMadeGateway(g))
      throw new ModelGatewayError(
        "bad-config",
        "The router takes only gateways made by createGateway: one built by hand could skip the budget.",
      );
  if (gateways.fallback && gateways.fallback.budget !== gateways.primary.budget)
    throw new ModelGatewayError(
      "bad-config",
      "The primary and fallback gateways must be built from the same budget, or the fallback would skip its ceilings.",
    );
  const budgeted = gateways.primary.budget !== NO_BUDGET;
  if (options.unmetered === true && budgeted)
    throw new ModelGatewayError(
      "bad-config",
      "The router cannot be unmetered when a budget is configured: drop unmetered, or drop the budget.",
    );
  if (options.unmetered !== true && !budgeted)
    throw new ModelGatewayError(
      "bad-config",
      "The router needs a budget: its gateways have none. Build them with one, or say unmetered: true.",
    );
  const maxCalls = options.maxCalls ?? MAX_CALLS_PER_ROUTE;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_CALLS_PER_ROUTE)
    throw new ModelGatewayError(
      "bad-config",
      `maxCalls must be a whole number from 1 to ${MAX_CALLS_PER_ROUTE}.`,
    );
  const deadlineMs = options.deadlineMs ?? DEFAULT_ROUTE_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < MIN_DEADLINE_MS || deadlineMs > MAX_DEADLINE_MS)
    throw new ModelGatewayError(
      "bad-config",
      `deadlineMs must be a whole number from ${MIN_DEADLINE_MS} to ${MAX_DEADLINE_MS}.`,
    );
  const now = options.now ?? (() => performance.now());
  /** The call's answer, or OUT_OF_TIME when `ms` pass first. The timer is always cleared. */
  async function within<T>(call: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(OUT_OF_TIME), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // A call that lost the race may still reject later: nothing is left waiting on it.
      call.catch(() => undefined);
    }
  }

  /** The clock now, or null when it gives nothing usable. */
  function reading(): number | null {
    try {
      const t = now();
      return typeof t === "number" && Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

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

    const started = reading();
    let last = started;
    for (let calls = 0; calls < maxCalls; calls++) {
      // Before every call: has the task had its time? A clock that gives nothing usable, or goes back, is no time left.
      const at = reading();
      if (
        at === null ||
        started === null ||
        last === null ||
        at < last ||
        at - started >= deadlineMs
      )
        return unsure("deadline", "The time one task may take was used.");
      last = at;
      // The time left is the call's own limit (the gateway, and so the sender, uses the shorter of that and
      // its own), and the router stops waiting at it too, whatever the gateway does.
      const left = deadlineMs - (at - started);
      let answer: ModelAnswer;
      try {
        answer = await within(
          gateway.complete({
            tier,
            agentId: request.agentId,
            callId,
            prompt,
            timeoutMs: Math.max(1, Math.floor(left)),
          }),
          left,
        );
      } catch (err) {
        if (err === OUT_OF_TIME) {
          attempts.push({ tier, provider: gateway.provider, outcome: "stopped", costMicros: 0 });
          return unsure("deadline", "The time one task may take was used.");
        }
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
      // An answer that came after the deadline is not used (it is paid for, so its cost stays).
      const arrived = reading();
      if (arrived === null || arrived < at || arrived - started > deadlineMs) {
        attempts.push({
          tier,
          provider: answer.provider,
          outcome: "stopped",
          costMicros: answer.usage.costMicros,
        });
        return unsure("deadline", "The time one task may take was used.");
      }
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
    return unsure("calls", "The most calls this router may make for one task were used.");
  }
  return { route };
}
