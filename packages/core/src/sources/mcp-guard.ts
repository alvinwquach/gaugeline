import { createHash } from "node:crypto";
import { writeWordIn } from "../fetch/mcp-jsonrpc.js";
import { sanitise } from "../untrusted.js";

/**
 * The client-side locks of a platform read through a remote MCP server (ADR-0008 points 2, 4 and
 * 5). The fetcher already refuses any message that is not one of four methods or that names a tool
 * off the entry (fetch/mcp-jsonrpc.ts); this module checks what the SERVER says before a call and
 * what it sends back after:
 *
 * - a tool is called only when the server lists it once, by its exact name, with `readOnlyHint:
 *   true`, `destructiveHint` not true and `openWorldHint: false` stated, AND its name, annotations
 *   and input schema hash to the value a person reviewed. The hint is required, never sufficient.
 * - a session that should be read-only and lists a tool without the hint, or one named like a
 *   write, is not read-only: the run for that platform stops.
 * - an answer is data. Only the first text item (or `structuredContent`) is parsed, under a cap,
 *   and only the fields an entry names survive, by type. The server's own message is never shown:
 *   every failure is one of Gaugeline's fixed reasons below.
 *
 * Pure functions: no connection, no key, no model (ADR-0002).
 */

/** Why a platform could not be checked, in Gaugeline's own words. A server's text never appears. */
export const COULD_NOT_CHECK = Object.freeze({
  notListed: "the server does not list this tool exactly once under its reviewed name",
  hints:
    "the server does not mark this tool read-only, non-destructive and closed-world, so Gaugeline does not call it",
  changed: "the vendor changed this tool and Gaugeline has not reviewed the new one",
  sessionNotReadOnly:
    "the server lists a tool that can write, so this session is not in read-only mode and nothing was called",
  httpStatus: "the server answered with an error status (check the token and the project)",
  notJson: "the server's answer was not the JSON-RPC response Gaugeline asked for",
  tooLarge: "the server's answer was over Gaugeline's size cap",
  rpcError: "the server answered the request with an error",
  toolError: "the tool reported an error",
  serverRequest:
    "the server asked Gaugeline a question; Gaugeline answers no request from a server, so the run stopped",
  unexpectedShape: "the answer does not have the fields Gaugeline reads",
  callCap: "the run reached its call cap for this platform",
} as const);

export type CouldNotCheckReason = (typeof COULD_NOT_CHECK)[keyof typeof COULD_NOT_CHECK];

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** JSON with object keys sorted at every level, so the same listing always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * sha256 of a listed tool's name, annotations and input schema; never its description, which
 * vendors rewrite often and Gaugeline never reads. The value a person records in an entry.
 */
export function listingHash(tool: {
  name?: unknown;
  annotations?: unknown;
  inputSchema?: unknown;
}): string {
  const text = canonical({
    name: tool.name ?? null,
    annotations: tool.annotations ?? null,
    inputSchema: tool.inputSchema ?? null,
  });
  return createHash("sha256").update(text).digest("hex");
}

/** All three hints stated, as the reviewed entry requires (a missing openWorldHint defaults to true, so silence is a refusal). */
function hintsSayRead(annotations: unknown): boolean {
  return (
    isObject(annotations) &&
    annotations.readOnlyHint === true &&
    annotations.destructiveHint !== true &&
    annotations.openWorldHint === false
  );
}

/**
 * Why this allowlisted tool may not be called now, judged from the server's `tools/list` answer,
 * or undefined when every lock holds. Call it on the listing taken in the same session.
 */
export function toolLockProblem(
  entry: { tool: string; listingHash: string },
  listed: readonly unknown[],
): CouldNotCheckReason | undefined {
  const same = listed.filter((t) => isObject(t) && t.name === entry.tool) as Record<
    string,
    unknown
  >[];
  const tool = same.length === 1 ? same[0] : undefined;
  if (tool === undefined) return COULD_NOT_CHECK.notListed;
  if (!hintsSayRead(tool.annotations)) return COULD_NOT_CHECK.hints;
  if (listingHash(tool) !== entry.listingHash) return COULD_NOT_CHECK.changed;
  return undefined;
}

/**
 * For a session the entry says is in the server's read-only mode: undefined when every listed tool
 * says `readOnlyHint: true`, none says `destructiveHint: true` and none is named like a write. A
 * listing that is empty or malformed is could-not-check, never a pass.
 */
export function sessionReadOnlyProblem(listed: unknown): CouldNotCheckReason | undefined {
  if (!Array.isArray(listed) || listed.length === 0) return COULD_NOT_CHECK.unexpectedShape;
  for (const t of listed) {
    if (!isObject(t) || typeof t.name !== "string") return COULD_NOT_CHECK.unexpectedShape;
    const a = isObject(t.annotations) ? t.annotations : {};
    if (a.readOnlyHint !== true || a.destructiveHint === true || writeWordIn(t.name) !== undefined)
      return COULD_NOT_CHECK.sessionNotReadOnly;
  }
  return undefined;
}

/** The parts of a fetcher hop this module reads. */
export interface AnswerHop {
  status: number;
  headers: Record<string, string>;
  body?: string;
  truncated?: boolean;
}

/** The JSON messages of an event stream: each event's data lines, joined. Lines that are not JSON are skipped. */
function streamMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""));
    if (data.length === 0) continue;
    try {
      out.push(JSON.parse(data.join("\n")) as unknown);
    } catch {
      // Not a message: ignored, and the answer is then whatever else the stream held.
    }
  }
  return out;
}

/**
 * The `result` of the response to request `id`, from a JSON body or an event stream. A request
 * from the server in the stream (sampling, elicitation, roots, more input) ends the run.
 */
export function readRpcAnswer(
  hop: AnswerHop,
  id: number,
): { ok: true; result: Record<string, unknown> } | { ok: false; reason: CouldNotCheckReason } {
  const fail = (reason: CouldNotCheckReason) => ({ ok: false as const, reason });
  if (hop.truncated === true) return fail(COULD_NOT_CHECK.tooLarge);
  if (hop.status < 200 || hop.status > 299) return fail(COULD_NOT_CHECK.httpStatus);
  const type = (hop.headers["content-type"] ?? "").toLowerCase();
  const body = hop.body ?? "";
  let messages: unknown[];
  if (type.startsWith("text/event-stream")) messages = streamMessages(body);
  else if (type.startsWith("application/json")) {
    try {
      messages = [JSON.parse(body) as unknown];
    } catch {
      return fail(COULD_NOT_CHECK.notJson);
    }
  } else return fail(COULD_NOT_CHECK.notJson);
  for (const m of messages) {
    if (!isObject(m)) continue;
    if (typeof m.method === "string" && m.id !== undefined)
      return fail(COULD_NOT_CHECK.serverRequest);
    if (m.id !== id) continue;
    if (m.error !== undefined) return fail(COULD_NOT_CHECK.rpcError);
    return isObject(m.result) ? { ok: true, result: m.result } : fail(COULD_NOT_CHECK.notJson);
  }
  return fail(COULD_NOT_CHECK.notJson);
}

/** The session id a server set on `initialize`, when it is visible ASCII and short; else undefined. */
export function sessionIdOf(hop: { headers: Record<string, string> }): string | undefined {
  const id = hop.headers["mcp-session-id"];
  return typeof id === "string" && /^[\x21-\x7E]{1,128}$/.test(id) ? id : undefined;
}

/** A tool result's data: `structuredContent`, else the first text item parsed as JSON, under `maxBytes`. */
export function toolResultData(
  result: unknown,
  maxBytes: number,
): { ok: true; data: unknown } | { ok: false; reason: CouldNotCheckReason } {
  const fail = (reason: CouldNotCheckReason) => ({ ok: false as const, reason });
  if (!isObject(result)) return fail(COULD_NOT_CHECK.unexpectedShape);
  if (result.isError === true) return fail(COULD_NOT_CHECK.toolError);
  if (isObject(result.structuredContent)) return { ok: true, data: result.structuredContent };
  const first = Array.isArray(result.content)
    ? (result.content as unknown[]).find((c) => isObject(c) && c.type === "text")
    : undefined;
  const text = isObject(first) && typeof first.text === "string" ? first.text : undefined;
  if (text === undefined) return fail(COULD_NOT_CHECK.unexpectedShape);
  if (Buffer.byteLength(text) > maxBytes) return fail(COULD_NOT_CHECK.tooLarge);
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return fail(COULD_NOT_CHECK.unexpectedShape);
  }
}

/** How one field of a tool result is kept. Fingerprints, never content: a text field is a name (cut and cleaned) or a hash. */
export type OutputRule =
  | { type: "boolean" }
  | { type: "integer" }
  /** An ISO date-time, kept normalised. */
  | { type: "timestamp" }
  | { type: "id"; pattern: string }
  | { type: "enum"; values: readonly string[] }
  /** A name (a table, a migration): cleaned by `sanitise` (N17), then letters, digits and _ . - only, at most 40. */
  | { type: "name" }
  /** An array, kept as its length. */
  | { type: "count" }
  /** A text, kept as "sha256:" and 12 hex digits. */
  | { type: "hash" }
  | { type: "list"; max: number; item: Readonly<Record<string, OutputRule>> };

/** The longest name kept. */
export const NAME_MAX = 40;
/** Hex digits of a kept hash: enough to tell two texts apart, too few to search for one. */
const HASH_DIGITS = 12;

function keepValue(rule: OutputRule, v: unknown): unknown {
  switch (rule.type) {
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "integer":
      return Number.isSafeInteger(v) ? v : undefined;
    case "timestamp": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return undefined;
      const t = Date.parse(v);
      return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
    }
    case "id":
      return typeof v === "string" && v.length <= 128 && new RegExp(rule.pattern).test(v)
        ? v
        : undefined;
    case "enum":
      return typeof v === "string" && rule.values.includes(v) ? v : undefined;
    case "name": {
      if (typeof v !== "string") return undefined;
      const name = sanitise(v, NAME_MAX)
        .text.replace(/[^A-Za-z0-9_.-]/g, "?")
        .slice(0, NAME_MAX);
      return name === "" ? undefined : name;
    }
    case "count":
      return Array.isArray(v) ? v.length : undefined;
    case "hash":
      return typeof v === "string"
        ? `sha256:${createHash("sha256").update(v).digest("hex").slice(0, HASH_DIGITS)}`
        : undefined;
    case "list":
      return Array.isArray(v)
        ? v.slice(0, rule.max).map((x) => keepFields(x, rule.item))
        : undefined;
  }
}

/**
 * The fields the rules name, each kept by its type; every other field is dropped, and a value of
 * the wrong type is dropped too rather than guessed at (an odd value is never read as "none").
 */
export function keepFields(
  data: unknown,
  rules: Readonly<Record<string, OutputRule>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObject(data)) return out;
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(data, key)) continue;
    const kept = keepValue(rule, data[key]);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}
