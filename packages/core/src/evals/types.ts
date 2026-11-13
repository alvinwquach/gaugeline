/**
 * The eval harness's shapes (AG-09, ADR-0014 "evals that fail closed"). An agent is judged offline: its
 * model sits behind `EvalModel`, and in the normal test run that is a recorded fake keyed by case id.
 * Integers only: tokens, cost in micro-units (10^6 to the unit) and time in milliseconds.
 */
import type { AgentDenyReason, AgentLimits } from "../agent-policy.js";

/** The most characters of input one case may carry. Over it, the model is never called. */
export const MAX_EVAL_INPUT_CHARS = 100_000;
/** The tool name the policy sees for the model call itself. */
export const EVAL_MODEL_TOOL = "model:complete";
/** The fixed "now" the policy is asked at, so no eval reads the real clock. */
export const EVAL_EPOCH_MS = Date.UTC(2026, 10, 13, 12, 0, 0);

/** The assertions, in the order a result lists them. */
export const EVAL_ASSERTIONS = [
  "schema",
  "cited-ids",
  "no-write-call",
  "no-invented-numbers",
  "limits",
  "must-cite",
] as const;
export type EvalAssertionId = (typeof EVAL_ASSERTIONS)[number];

/** One finding the agent is shown. Every string here is data, page-derived or not. */
export interface EvalFinding {
  id: string;
  checkId: string;
  title: string;
  evidence: string;
  /** For agents that rank by urgency (AG-12). Absent in earlier sets. */
  severity?: "high" | "medium" | "low";
  /** The address the finding is about, for agents that count pages. */
  url?: string;
}
export interface EvalInput {
  findings: readonly EvalFinding[];
  /** Text lifted from a checked page: untrusted data, never an instruction. */
  pageText?: string;
  /**
   * What a read of the hosted app returned (AG-12: the pending-approvals page for one site), as the API sent
   * it. Untrusted data like the rest, and counted by `inputChars`. Absent for agents that read nothing.
   */
  pending?: unknown;
}

export interface EvalToolCall {
  tool: string;
}
export interface EvalUsage {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
}
/** What a model answered: text, the tool calls it tried to make, and what it cost. */
export interface EvalRecording {
  text: string;
  toolCalls?: readonly EvalToolCall[];
  usage: EvalUsage;
}
export interface EvalModelRequest {
  caseId: string;
  agentId: string;
  prompt: string;
}
/** The one way an agent reaches a model. The fake replays; a live one is manual and never in CI (AG-11). */
export interface EvalModel {
  complete(request: EvalModelRequest): Promise<EvalRecording>;
}

export type EvalParse<O> = { ok: true; value: O } | { ok: false; issues: string[] };

/** What the harness needs to know about an agent. */
export interface EvalAgent<O> {
  id: string;
  /** Every tool the agent may call, besides the model. Nothing that writes. */
  tools: readonly string[];
  limits: AgentLimits;
  buildPrompt(input: EvalInput): string;
  /** The output schema: take the parsed JSON, return the typed output or the reasons it is refused. */
  parse(raw: unknown): EvalParse<O>;
  citedIds(output: O): readonly string[];
  /** The free text of the output, scanned for numbers. */
  prose(output: O): readonly string[];
  /** Whole numbers the agent computes itself (a count), allowed in prose besides the input's own. */
  derivedNumbers?(input: EvalInput, output: O): readonly number[];
}

interface CaseBase {
  /** Also the key of the recording. Unique within a set. */
  id: string;
  title: string;
  input: EvalInput;
}
export interface GoldenCase extends CaseBase {
  kind: "golden";
  /** Finding ids the output must cite. */
  mustCite?: readonly string[];
}
export interface KnownBadCase extends CaseBase {
  kind: "known-bad";
  /** The assertions that must fail for this case to count as caught. */
  catches: readonly EvalAssertionId[];
}
export type EvalCase = GoldenCase | KnownBadCase;

export type AssertionStatus = "pass" | "fail" | "skipped";
export interface EvalAssertionResult {
  id: EvalAssertionId;
  status: AssertionStatus;
  detail?: string;
}
/** A model-judged opinion. There is no "pass" here, by design. */
export type JudgedVerdict = "advisory" | "unsure";
export interface EvalJudgement {
  verdict: JudgedVerdict;
  note?: string;
}
export type EvalJudge = (request: {
  caseId: string;
  input: EvalInput;
  output: unknown;
}) => Promise<EvalJudgement> | EvalJudgement;

export interface EvalCaseResult {
  caseId: string;
  kind: EvalCase["kind"];
  /** golden: pass or fail. known-bad: caught or missed. error: the case could not run. */
  status: "pass" | "fail" | "caught" | "missed" | "error";
  assertions: EvalAssertionResult[];
  costMicros: number;
  latencyMs: number;
  /** Advisory only: never changes the status. */
  judged?: EvalJudgement;
  detail?: string;
}
export interface EvalReport {
  agentId: string;
  results: EvalCaseResult[];
  /** Why the set was not run, if it was not. */
  problems: string[];
  golden: { total: number; passed: number };
  knownBad: { total: number; caught: number };
  costMicros: number;
  ok: boolean;
}

export type { AgentDenyReason };
