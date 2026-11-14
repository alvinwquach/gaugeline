/**
 * The model gateway's shapes (AG-19, ADR-0005 as amended, ADR-0014). One provider-neutral interface with two
 * named tiers. A model only words a draft: every answer is `advisory` and there is no way to say "pass". The
 * recorded fake and the replay are the AG-09 ones (`../evals`); a provider is an adapter behind `ModelAdapter`.
 * Integers only: tokens, cost in micro-units (10^6 to the unit) and time in milliseconds.
 */
import type { EvalRecording, EvalUsage } from "../evals/types.js";
import type { ApiKey } from "./key.js";
import type { GatedPayload } from "./gated.js";
import type { ModelInput, PrivacyRecord } from "./privacy.js";

/** `fast` is for wording a draft, `strong` for the check writer and the miner (AG-21 chooses between them). */
export const MODEL_TIERS = ["fast", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The most characters one prompt may hold. A config can lower this, never raise it. */
export const MAX_PROMPT_CHARS = 100_000;
/** The most characters one answer may hold. */
export const MAX_ANSWER_CHARS = 100_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

/**
 * What a config file holds: a provider, a model id per tier, the NAME of the environment variable that holds
 * the key (never the key), and limits. It has no host, address or switch: the hosts a provider can reach are
 * kept in the one sending module (ADR-0005).
 */
export interface GatewayConfig {
  provider: string;
  keyEnv?: string;
  tiers: Partial<Record<ModelTier, string>>;
  timeoutMs: number;
  maxInputChars: number;
  maxOutputTokens: number;
}

/** A config as a person writes it: the limits may be left out and get their defaults. */
export type GatewayConfigInput = Omit<
  GatewayConfig,
  "timeoutMs" | "maxInputChars" | "maxOutputTokens"
> &
  Partial<Pick<GatewayConfig, "timeoutMs" | "maxInputChars" | "maxOutputTokens">>;

/**
 * One call. `callId` is also the key of a recording; an agent's own id and call id are ids, never text. What
 * the call carries is a typed `input` (a task, findings, snippets and ids), never a prompt: the privacy gate
 * (./privacy.ts, AG-23) checks it, redacts it and builds the only text an adapter is handed.
 */
export interface ModelRequest {
  tier: ModelTier;
  agentId: string;
  callId: string;
  input: ModelInput;
  /** A time limit for this call alone, in whole milliseconds. It can shorten the config's limit, never lengthen it. */
  timeoutMs?: number;
  /** Aborted by the caller (the router at its deadline): the call stops, and nothing is sent once it is aborted. */
  signal?: AbortSignal;
}

/** What a model answered. `advisory` is always true: an answer is words for a person to read, never a verdict. */
export interface ModelAnswer extends EvalRecording {
  provider: string;
  model: string;
  tier: ModelTier;
  advisory: true;
  /** True when a secret or personal data was replaced before the call (the counts are in `privacy`). */
  redacted: boolean;
  /** What the privacy gate did: what was sent in numbers, and what it redacted by kind and count. Never a value. */
  privacy: PrivacyRecord;
}

/** What a provider adapter is handed. The key is wrapped: it shows as "[redacted key]" anywhere it is printed. */
export interface AdapterCall {
  model: string;
  /** What the privacy gate built. An adapter sends this and nothing else: a plain string is not a payload and does not compile. */
  prompt: GatedPayload;
  callId: string;
  maxOutputTokens: number;
  /** Aborted at the timeout. An adapter passes it on to whatever it calls. */
  signal: AbortSignal;
  key: ApiKey | undefined;
}

/** A provider. It answers with the recorded shape (text, tool calls it tried, usage) or throws. */
export interface ModelAdapter {
  readonly provider: string;
  /** False only for the recorded fake. */
  readonly needsKey: boolean;
  complete(call: AdapterCall): Promise<unknown>;
}

/** What a budget is asked before a call. Whole numbers: the token count is an estimate (4 characters each). */
export interface BudgetEstimate {
  agentId: string;
  /** The call's id: the same one is handed to `after`, so a budget can settle what it held for this call. */
  callId: string;
  tier: ModelTier;
  provider: string;
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  /** The time the call has, this budget check included, in milliseconds. A check that outlasts it ends the call. */
  timeoutMs?: number;
}
export type BudgetDecision = { allowed: true } | { allowed: false; reason: string };

/** The seam AG-22 fills in with ceilings (`createBudgetLedger`, ./budget.ts). The default, `NO_BUDGET`, is a no-op. */
export interface BudgetHooks {
  /** Before anything is sent. Anything but an explicit yes stops the call. */
  before(estimate: BudgetEstimate): BudgetDecision | Promise<BudgetDecision>;
  /** After an answer. It cannot undo the call, so an error here is ignored. */
  after(spend: BudgetEstimate & { usage: EvalUsage }): void | Promise<void>;
}

export interface GatewayOptions {
  config: GatewayConfigInput;
  adapters: readonly ModelAdapter[];
  /** The environment, read at each call and never kept. The caller hands it in; this module never reads the process environment. */
  env: () => Readonly<Record<string, string | undefined>>;
  budget?: BudgetHooks;
}

/** The one way an agent reaches a model. */
export interface ModelGateway {
  readonly provider: string;
  /** The budget this gateway asks before every call (`NO_BUDGET` when it was built with none). A router compares them. */
  readonly budget: BudgetHooks;
  complete(request: ModelRequest): Promise<ModelAnswer>;
}
