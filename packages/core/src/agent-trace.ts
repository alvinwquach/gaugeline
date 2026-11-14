/**
 * The agent trace record (AG-05, ADR-0014 "every agent call is traced"): the one shape the MCP server's trace
 * writes (one JSON line per tool call on stderr, packages/mcp/src/trace.ts). The hosted database's
 * `agent_trace` (migration 0015) holds the same facts as columns, but the two are not identical:
 *   both:          agent id, tool, input and output SHA-256, latency (ms), tokens, cost (micro-units),
 *                  decision, deny reason, approver id, draft id, time
 *   this record:   `v` (the shape's version) and `error` (an allowed call that ended in an error); no org
 *   database row:  `org_id` and its own `id`; no `v` and no `error` (a call that raises there is undone)
 * It holds ids, SHA-256 hashes, integers and closed-list codes, never the input or the output of a call.
 *
 * Pure and deterministic: no I/O, no model call, no clock (the time is handed in). Hashing streams a
 * canonical form into SHA-256 without building it as one string, after redacting secrets and personal data
 * from every string with the existing core helpers, so a hash is never taken over a raw secret.
 */
import { createHash, type Hash } from "node:crypto";
import { AGENT_DENY_REASONS, MAX_COST_MICROS, type AgentDenyReason } from "./agent-policy.js";
import { DETECTORS } from "./checks/leaks/detectors.js";
import { redact } from "./redact.js";
import { keyPatterns } from "./secrets.js";

export const AGENT_TRACE_DECISIONS = ["allowed", "denied", "approved", "declined"] as const;
export type AgentTraceDecision = (typeof AGENT_TRACE_DECISIONS)[number];

/** A string longer than this (UTF-16 units) is hashed as its length only: never redacted or read whole. */
export const MAX_TRACE_STRING = 100_000;

export interface AgentTraceRecord {
  /** The shape's version. */
  readonly v: 1;
  readonly at: string;
  /** The registry id; the MCP server's calls use its stand-in id, `gaugeline-mcp`. */
  readonly agentId: string;
  /** A tool name (a code, never free text), or null when the call named none the server knows. */
  readonly tool: string | null;
  readonly inputSha256: string | null;
  readonly outputSha256: string | null;
  /** Whole milliseconds. */
  readonly latencyMs: number;
  /** Integers. 0 today: no agent call runs a model (the fields are there for AG-19 and later). */
  readonly tokens: number;
  readonly costMicros: number;
  readonly decision: AgentTraceDecision;
  /** For `denied` only: the policy's reason. */
  readonly reason: AgentDenyReason | null;
  /** For `approved` and `declined` only: the member who decided. */
  readonly approverId: string | null;
  readonly draftId: string | null;
  /** An allowed call that ended in an error (a busy server, a tool error). */
  readonly error: boolean;
}

export interface AgentTraceInput {
  at: string;
  agentId: string;
  tool: string | null;
  inputSha256: string | null;
  outputSha256: string | null;
  latencyMs: number;
  tokens: number;
  costMicros: number;
  decision: AgentTraceDecision;
  reason?: AgentDenyReason | null;
  approverId?: string | null;
  draftId?: string | null;
  error?: boolean;
}

const DECISIONS: ReadonlySet<string> = new Set(AGENT_TRACE_DECISIONS);
const REASONS: ReadonlySet<string> = new Set(AGENT_DENY_REASONS);
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_LATENCY_MS = 31_536_000_000;

/** Throws with the field's name only: a refused value is never echoed (it may be a secret). */
function refuse(field: string): never {
  throw new Error(`Agent trace: ${field} is not valid.`);
}
const whole = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const codeOrNull = (v: unknown, field: string, re = CODE): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !re.test(v)) refuse(field);
  return v;
};

/** Checks every field and returns the frozen record, keys in a fixed order. */
export function agentTraceRecord(input: AgentTraceInput): AgentTraceRecord {
  if (typeof input.at !== "string" || !ISO.test(input.at)) refuse("at");
  const agentId = codeOrNull(input.agentId, "agentId");
  if (agentId === null) refuse("agentId");
  if (!whole(input.latencyMs, MAX_LATENCY_MS)) refuse("latencyMs");
  if (!whole(input.tokens, MAX_COST_MICROS)) refuse("tokens");
  if (!whole(input.costMicros, MAX_COST_MICROS)) refuse("costMicros");
  if (!DECISIONS.has(input.decision)) refuse("decision");
  const reason = input.reason ?? null;
  if (
    (input.decision === "denied") !== (reason !== null) ||
    (reason !== null && !REASONS.has(reason))
  )
    refuse("reason");
  const approverId = codeOrNull(input.approverId, "approverId");
  if ((input.decision === "approved" || input.decision === "declined") !== (approverId !== null))
    refuse("approverId");
  return Object.freeze({
    v: 1,
    at: input.at,
    agentId,
    tool: codeOrNull(input.tool, "tool"),
    inputSha256: codeOrNull(input.inputSha256, "inputSha256", HEX64),
    outputSha256: codeOrNull(input.outputSha256, "outputSha256", HEX64),
    latencyMs: input.latencyMs,
    tokens: input.tokens,
    costMicros: input.costMicros,
    decision: input.decision,
    reason: reason as AgentDenyReason | null,
    approverId,
    draftId: codeOrNull(input.draftId, "draftId"),
    error: input.error === true,
  });
}

/** One JSONL line. */
export const traceLine = (r: AgentTraceRecord): string => `${JSON.stringify(r)}\n`;

// Starts only where a run of address characters starts, and every part is bounded, so a long run of
// letters is scanned once (linear), never from every position.
export const EMAIL_PATTERN =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/g;
// A run of at least 8 digits with the separators phone numbers use. Over-matching only merges two hashes.
export const PHONE_PATTERN = /\+?\d(?:[\s().-]*\d){7,}/g;

/**
 * A string with every secret shape replaced by a fixed marker: the core redaction rules, the key shapes and
 * the leak detectors (what the secret-in-js check uses). No personal data: the model privacy gate (AG-23)
 * counts emails and phone numbers as kinds of their own, so it calls this and then its own rules.
 */
export function redactSecretShapes(text: string): string {
  let s = redact(text);
  for (const k of keyPatterns()) s = s.replace(k.pattern, `[secret:${k.name}]`);
  for (const d of DETECTORS) {
    const re = new RegExp(d.pattern.source, d.pattern.flags);
    const hits: [number, string][] = [];
    for (const m of s.matchAll(re)) {
      const secret = m.groups?.secret;
      if (!secret || (d.verify && !d.verify(secret, m as RegExpExecArray))) continue;
      hits.push([(m.index ?? 0) + m[0].indexOf(secret), secret]);
    }
    if (hits.length > 0) {
      // One pass: slices and markers joined once, never the whole string rebuilt for each hit.
      const parts: string[] = [];
      let from = 0;
      for (const [at, secret] of hits) {
        if (at < from) continue;
        parts.push(s.slice(from, at), `[secret:${d.id}]`);
        from = at + secret.length;
      }
      parts.push(s.slice(from));
      s = parts.join("");
    }
  }
  return s;
}

/**
 * A string with every secret and piece of personal data replaced by a fixed marker: the secret shapes above,
 * email addresses and phone numbers. Exported for tests of the sinks; the record never holds text.
 */
export function redactForTrace(text: string): string {
  return redactSecretShapes(text)
    .replace(EMAIL_PATTERN, "[email]")
    .replace(PHONE_PATTERN, "[phone]");
}

function writeString(h: Hash, raw: string): void {
  if (raw.length > MAX_TRACE_STRING) {
    h.update(`<long:${raw.length}>`);
    return;
  }
  h.update(JSON.stringify(redactForTrace(raw.normalize("NFC"))));
}

/**
 * SHA-256 (hex) of `value`'s canonical form, streamed: JSON, object keys NFC-normalised, redacted and sorted
 * by UTF-16 code units, strings NFC-normalised and redacted, numbers as JSON writes them (NaN and Infinity
 * as null), undefined, functions and symbols as null, a bigint as its digits in a string, a repeated object
 * (a cycle) as "<cycle>". Iterative: no recursion, and no canonical text is built in memory.
 */
export function traceHash(value: unknown): string {
  const h = createHash("sha256");
  const seen = new WeakSet<object>();
  // A work list of values to write and literal punctuation to emit.
  const todo: ({ lit: string } | { val: unknown })[] = [{ val: value }];
  while (todo.length > 0) {
    const item = todo.pop()!;
    if ("lit" in item) {
      h.update(item.lit);
      continue;
    }
    const v = item.val;
    if (typeof v === "string") writeString(h, v);
    else if (typeof v === "number") h.update(Number.isFinite(v) ? JSON.stringify(v) : "null");
    else if (typeof v === "boolean") h.update(v ? "true" : "false");
    else if (typeof v === "bigint") h.update(JSON.stringify(v.toString()));
    else if (v === null || typeof v !== "object") h.update("null");
    else if (seen.has(v)) h.update('"<cycle>"');
    else {
      seen.add(v);
      const next: ({ lit: string } | { val: unknown })[] = [];
      if (Array.isArray(v)) {
        next.push({ lit: "[" });
        v.forEach((x, i) => {
          if (i > 0) next.push({ lit: "," });
          next.push({ val: x });
        });
        next.push({ lit: "]" });
      } else {
        const entries = Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .map(([k, x]) => [redactForTrace(k.normalize("NFC")), x] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        next.push({ lit: "{" });
        entries.forEach(([k, x], i) => {
          next.push({ lit: `${i > 0 ? "," : ""}${JSON.stringify(k)}:` });
          next.push({ val: x });
        });
        next.push({ lit: "}" });
      }
      for (let i = next.length - 1; i >= 0; i--) todo.push(next[i]!);
    }
  }
  return h.digest("hex");
}
