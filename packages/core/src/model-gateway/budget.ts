/**
 * Budgets and estimates (AG-22, ADR-0014 T7 "runaway cost"): the ceilings the gateway's budget hooks enforce.
 * Per run, per UTC day and per workspace, each checked BEFORE a call against the worst the call can cost
 * (every input token plus every output token it may produce), so a call that could pass a ceiling is never
 * sent. After the answer the worst case is replaced by what the answer cost, worked out from its recorded
 * token counts and the config's prices, never from a figure the provider reports about itself.
 *
 * Deterministic code: no model decides a budget, nothing here reads a clock (the caller hands one in) or the
 * environment, opens a connection or logs. Integers only: tokens, and cost in micro-units (10^6 to the unit).
 * The books are in memory, so they start again when the process does; a durable ledger for the hosted worker
 * is a table and is not part of this change (docs/model-budgets.md says so).
 */
import { MAX_COST_MICROS } from "../agent-policy.js";
import {
  parseBudgetConfig,
  type BudgetConfig,
  type BudgetConfigInput,
  type ModelPrice,
} from "./budget-config.js";
import { ModelGatewayError } from "./errors.js";
import type { BudgetDecision, BudgetEstimate, BudgetHooks, ModelTier } from "./types.js";

/** Four characters to a token is the gateway's rough count; an estimate, and a whole number. */
export const CHARS_PER_TOKEN = 4;
const DAY_MS = 86_400_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PENDING_PER_RUN = 64;
const MAX_WORKSPACES = 1_024;
const MILLION = 1_000_000n;

/** The tokens the gateway will count for a prompt of this many characters. */
export function estimateInputTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * What these tokens cost at this model's price, in whole micro-units, rounded up so an estimate is never
 * low. BigInt inside so a large count cannot lose precision; capped at the largest ceiling, which no
 * ceiling can exceed.
 */
export function callCostMicros(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  const micros =
    (BigInt(inputTokens) * BigInt(price.inputMicrosPerMTok) +
      BigInt(outputTokens) * BigInt(price.outputMicrosPerMTok) +
      (MILLION - 1n)) /
    MILLION;
  return micros > BigInt(MAX_COST_MICROS) ? MAX_COST_MICROS : Number(micros);
}

/** What a call spent: the fields the trace record holds besides the ones it already has (`tokens`, `costMicros`). */
export interface SpendEntry {
  agentId: string;
  callId: string;
  tier: ModelTier;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costMicros: number;
}
/** The two numbers of `SpendEntry` that go into an agent trace record (AG-05), and so onto the scorecard (AG-07). */
export const traceFieldsOf = (e: SpendEntry) => ({
  tokens: e.tokens,
  costMicros: e.costMicros,
});

export interface BudgetSnapshot {
  /** The UTC day the daily total is for, `YYYY-MM-DD`. */
  day: string;
  /** Spent today in every workspace, plus what calls still waiting for an answer may cost. */
  dayMicros: number;
  /** Spent in this workspace since the ledger began, plus what waiting calls may cost. */
  workspaceMicros: number;
}

/** The hooks for one run (hand them to `createGateway` as `budget`), and what the run holds. */
export interface RunBudget extends BudgetHooks {
  /** Spent in this run, plus what calls still waiting for an answer may cost. */
  committedMicros(): number;
  /** True once a ceiling has stopped the run: every later call is refused. */
  stopped(): boolean;
}

export interface BudgetLedgerOptions {
  config: BudgetConfigInput;
  /** Milliseconds since the epoch. Required: a ledger has no clock of its own. */
  now: () => number;
  /** Told what each answered call spent, for the trace. A sink that throws changes nothing. */
  onSpend?: (entry: SpendEntry) => void;
  /** The most workspaces the ledger keeps books for (default 1024). A larger number is refused, not forgotten. */
  maxWorkspaces?: number;
}

export interface BudgetLedger {
  /** The hooks for one run in one workspace. Make one for each run: the run's own ceiling starts at zero. */
  forRun(workspaceId: string): RunBudget;
  /** Whether a run could start: its whole estimate against every ceiling and what is already spent. Reserves nothing. */
  canStart(workspaceId: string, estimate: RunEstimate): BudgetDecision;
  snapshot(workspaceId: string): BudgetSnapshot;
}

interface Held {
  reserved: number;
  /** The UTC day number when it was held: an answer that comes after midnight cannot take it back from the new day. */
  day: number;
}

const no = (reason: string): BudgetDecision => ({ allowed: false, reason });
const dayLabel = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

function parsed(raw: unknown): BudgetConfig {
  const r = parseBudgetConfig(raw);
  if (!r.ok)
    throw new ModelGatewayError(
      "bad-config",
      `The budget config is not valid: ${r.problems.join("; ")}`,
    );
  return r.config;
}

export function createBudgetLedger(options: BudgetLedgerOptions): BudgetLedger {
  const config = parsed(options.config);
  const { ceilings } = config;
  const maxWorkspaces = options.maxWorkspaces ?? MAX_WORKSPACES;
  const workspaces = new Map<string, number>();
  let dayNumber = -1;
  let dayMicros = 0;

  /** The UTC day number now, or null when the clock is no use. The day never goes back, whatever the clock does. */
  function today(): number | null {
    let t: number;
    try {
      t = options.now();
    } catch {
      return null;
    }
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return null;
    const d = Math.floor(t / DAY_MS);
    if (d > dayNumber) {
      dayNumber = d;
      dayMicros = 0;
    }
    return dayNumber;
  }
  const workspaceId = (id: unknown): string => {
    if (typeof id !== "string" || !ID.test(id))
      throw new ModelGatewayError("bad-request", "The workspace must be an id.");
    return id;
  };
  const room = (spent: number, add: number, ceiling: number) => spent + add <= ceiling;

  function forRun(workspace: string): RunBudget {
    const ws = workspaceId(workspace);
    if (!workspaces.has(ws)) {
      if (workspaces.size >= maxWorkspaces)
        throw new ModelGatewayError("budget", "The ledger keeps books for no more workspaces.");
      workspaces.set(ws, 0);
    }
    let runMicros = 0;
    let stop = false;
    const held = new Map<string, Held[]>();
    let heldCount = 0;

    function before(estimate: BudgetEstimate): BudgetDecision {
      if (stop) return no("the run was already stopped by a ceiling");
      const price = config.prices.get(estimate.model);
      if (!price) return no("no price is set for the model");
      const day = today();
      if (day === null) return no("the clock gave no usable time");
      if (heldCount >= MAX_PENDING_PER_RUN) return no("too many calls are waiting for an answer");
      const worst = callCostMicros(price, estimate.inputTokens, estimate.maxOutputTokens);
      const wsMicros = workspaces.get(ws) ?? 0;
      const books: readonly (readonly [string, number, number])[] = [
        ["per-run", runMicros, ceilings.perRunMicros],
        ["per-day", dayMicros, ceilings.perDayMicros],
        ["per-workspace", wsMicros, ceilings.perWorkspaceMicros],
      ];
      const over = books.find(([, spent, ceiling]) => !room(spent, worst, ceiling));
      if (over) {
        stop = true;
        return no(`the ${over[0]} ceiling of ${over[2]} micro-units would be passed`);
      }
      runMicros += worst;
      dayMicros += worst;
      workspaces.set(ws, wsMicros + worst);
      const list = held.get(estimate.callId) ?? [];
      list.push({ reserved: worst, day });
      held.set(estimate.callId, list);
      heldCount += 1;
      return { allowed: true };
    }

    function after(
      spend: BudgetEstimate & { usage: { inputTokens: number; outputTokens: number } },
    ) {
      const price = config.prices.get(spend.model);
      const list = held.get(spend.callId);
      const was = list?.shift();
      if (list && list.length === 0) held.delete(spend.callId);
      if (was) heldCount -= 1;
      // `before` refused a model with no price, so a missing price here means `after` was called on its own:
      // keep what was held, never less.
      const actual = price
        ? callCostMicros(price, spend.usage.inputTokens, spend.usage.outputTokens)
        : (was?.reserved ?? 0);
      const day = today();
      const reserved = was?.reserved ?? 0;
      runMicros += actual - reserved;
      workspaces.set(ws, Math.max(0, (workspaces.get(ws) ?? 0) + actual - reserved));
      // An answer that came after midnight: the new day's total never held the reservation, so it only takes the cost.
      if (day !== null && was && was.day === day)
        dayMicros = Math.max(0, dayMicros + actual - reserved);
      else if (day !== null) dayMicros += actual;
      if (options.onSpend) {
        try {
          options.onSpend({
            agentId: spend.agentId,
            callId: spend.callId,
            tier: spend.tier,
            provider: spend.provider,
            model: spend.model,
            inputTokens: spend.usage.inputTokens,
            outputTokens: spend.usage.outputTokens,
            tokens: spend.usage.inputTokens + spend.usage.outputTokens,
            costMicros: actual,
          });
        } catch {
          // The call is made and paid for; a trace sink that fails must not lose the answer.
        }
      }
    }

    return { before, after, committedMicros: () => runMicros, stopped: () => stop };
  }

  function canStart(workspace: string, estimate: RunEstimate): BudgetDecision {
    const ws = workspaceId(workspace);
    if (!estimate.ok) return no("the estimate has a model with no price");
    const cost = estimate.costMicros;
    if (cost > ceilings.perRunMicros)
      return no(
        `the per-run ceiling of ${ceilings.perRunMicros} micro-units is below the estimate of ${cost}`,
      );
    if (today() === null) return no("the clock gave no usable time");
    if (!room(dayMicros, cost, ceilings.perDayMicros))
      return no(`the per-day ceiling of ${ceilings.perDayMicros} micro-units would be passed`);
    if (!room(workspaces.get(ws) ?? 0, cost, ceilings.perWorkspaceMicros))
      return no(
        `the per-workspace ceiling of ${ceilings.perWorkspaceMicros} micro-units would be passed`,
      );
    return { allowed: true };
  }

  function snapshot(workspace: string): BudgetSnapshot {
    const ws = workspaceId(workspace);
    const day = today();
    return {
      day: dayLabel(day ?? Math.max(dayNumber, 0)),
      dayMicros: day === null ? 0 : dayMicros,
      workspaceMicros: workspaces.get(ws) ?? 0,
    };
  }

  return { forRun, canStart, snapshot };
}

/** One call a run plans to make: the payload's size, not the payload. */
export interface PlannedCall {
  readonly tier: ModelTier;
  readonly model: string;
  /** Characters of prompt. */
  readonly inputChars: number;
  readonly maxOutputTokens: number;
}
export interface CallEstimate {
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  /** The most the call can cost. */
  costMicros: number;
}
export type RunEstimate =
  | {
      ok: true;
      calls: CallEstimate[];
      inputTokens: number;
      outputTokens: number;
      /** The most the whole run can cost. */
      costMicros: number;
    }
  | { ok: false; unpriced: string[] };

/**
 * What a run could cost at most, from the size of what it plans to send and the most it may get back, before
 * anything is sent. A model with no price gives no number: the run is named as unpriced instead of costing 0.
 */
export function estimateRun(
  rawConfig: BudgetConfigInput,
  plan: readonly PlannedCall[],
): RunEstimate {
  const config = parsed(rawConfig);
  const unpriced = new Set<string>();
  const calls: CallEstimate[] = [];
  for (const p of plan) {
    if (!Number.isSafeInteger(p.inputChars) || p.inputChars < 0)
      throw new ModelGatewayError(
        "bad-request",
        "A planned call's size must be a whole number of characters.",
      );
    if (!Number.isSafeInteger(p.maxOutputTokens) || p.maxOutputTokens < 0)
      throw new ModelGatewayError(
        "bad-request",
        "A planned call's output limit must be a whole number of tokens.",
      );
    const price = config.prices.get(p.model);
    if (!price) {
      unpriced.add(p.model);
      continue;
    }
    const inputTokens = estimateInputTokens(p.inputChars);
    calls.push({
      model: p.model,
      inputTokens,
      maxOutputTokens: p.maxOutputTokens,
      costMicros: callCostMicros(price, inputTokens, p.maxOutputTokens),
    });
  }
  if (unpriced.size > 0) return { ok: false, unpriced: [...unpriced] };
  return {
    ok: true,
    calls,
    inputTokens: calls.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: calls.reduce((n, c) => n + c.maxOutputTokens, 0),
    costMicros: Math.min(
      calls.reduce((n, c) => n + c.costMicros, 0),
      MAX_COST_MICROS,
    ),
  };
}
