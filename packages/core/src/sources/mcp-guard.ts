import { createHash } from "node:crypto";
import {
  gluedWriteIn,
  idPattern,
  idPatternProblem,
  isIdValue,
  writeWordIn,
} from "../fetch/mcp-jsonrpc.js";
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
  unreviewed:
    "the server lists a tool Gaugeline has not reviewed, or two tools whose names differ only in case, so this session is not trusted and nothing was called",
  badCursor: "the server's page cursor is not an opaque token",
  task: "the server would run this tool as a task, which Gaugeline does not follow, so it is not called",
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
  title?: unknown;
  annotations?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execution?: unknown;
}): string {
  const text = canonical({
    name: tool.name ?? null,
    title: tool.title ?? null,
    annotations: tool.annotations ?? null,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    execution: tool.execution ?? null,
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
  // Every name that equals the entry's once lower-cased: "LIST_TABLES" beside "list_tables" is not one tool.
  const same = listed.filter(
    (t) =>
      isObject(t) &&
      typeof t.name === "string" &&
      t.name.toLowerCase() === entry.tool.toLowerCase(),
  ) as Record<string, unknown>[];
  const tool = same.length === 1 && same[0]?.name === entry.tool ? same[0] : undefined;
  if (tool === undefined) return COULD_NOT_CHECK.notListed;
  if (!hintsSayRead(tool.annotations)) return COULD_NOT_CHECK.hints;
  // A tool run as a task answers later, through calls Gaugeline never makes: only "forbidden" (or none) is read.
  if (
    tool.execution !== undefined &&
    !(isObject(tool.execution) && tool.execution.taskSupport === "forbidden")
  )
    return COULD_NOT_CHECK.task;
  if (listingHash(tool) !== entry.listingHash) return COULD_NOT_CHECK.changed;
  return undefined;
}

/** A tool the server may list in its read-only session that Gaugeline never calls, pinned by its reviewed hash. */
export interface ToleratedTool {
  tool: string;
  listingHash: string;
}

/**
 * The whole listing of a session the entry says is in the server's read-only mode, every page
 * collected, judged before any call. Every tool says `readOnlyHint: true` and is not destructive; no
 * two names are equal once lower-cased; a name outside plain ASCII stops the run; and no tool is named
 * like a write, except a tolerated one, matched by exact name AND reviewed hash, with all three hints.
 * With `reviewed`, any tool neither called nor tolerated stops the run too. A listing that is empty or
 * malformed is could-not-check, never a pass. A description is never read.
 */
export function sessionReadOnlyProblem(
  listed: unknown,
  reviewed?: { called: readonly { tool: string }[]; tolerated: readonly ToleratedTool[] },
): CouldNotCheckReason | undefined {
  if (!Array.isArray(listed) || listed.length === 0) return COULD_NOT_CHECK.unexpectedShape;
  const seen = new Set<string>();
  for (const t of listed) {
    if (!isObject(t) || typeof t.name !== "string") return COULD_NOT_CHECK.unexpectedShape;
    // A name outside plain ASCII (a Cyrillic lookalike) cannot be screened by words: not read-only.
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) return COULD_NOT_CHECK.sessionNotReadOnly;
    const lower = t.name.toLowerCase();
    if (seen.has(lower)) return COULD_NOT_CHECK.unreviewed;
    seen.add(lower);
    const a = isObject(t.annotations) ? t.annotations : {};
    if (a.readOnlyHint !== true || a.destructiveHint === true)
      return COULD_NOT_CHECK.sessionNotReadOnly;
    const tolerated = reviewed?.tolerated.find((x) => x.tool === t.name);
    if (tolerated !== undefined) {
      if (!hintsSayRead(t.annotations)) return COULD_NOT_CHECK.sessionNotReadOnly;
      if (listingHash(t) !== tolerated.listingHash) return COULD_NOT_CHECK.changed;
      continue;
    }
    if (writeWordIn(t.name) !== undefined) return COULD_NOT_CHECK.sessionNotReadOnly;
    if (reviewed !== undefined && !reviewed.called.some((c) => c.tool === t.name))
      return COULD_NOT_CHECK.unreviewed;
  }
  return undefined;
}

/**
 * Contract for an entry's tolerated list: a lower-case ASCII name with no write verb as a word (a key,
 * docs or search tool, never `apply_migration` or `execute_sql`), never one of the tools the entry
 * calls (the names `fetcher.query` may send), listed once, with a sha256 hash.
 */
export function toleratedProblems(
  tolerated: readonly ToleratedTool[],
  called: readonly { tool: string }[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tolerated) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.tool)) out.push(`${t.tool}: not a lower-case ASCII name`);
    const verb = gluedWriteIn(t.tool);
    if (verb !== undefined) out.push(`${t.tool}: a tool named with "${verb}" is never tolerated`);
    if (called.some((c) => c.tool.toLowerCase() === t.tool.toLowerCase()))
      out.push(`${t.tool}: is a called tool, so it is not tolerated`);
    if (seen.has(t.tool)) out.push(`${t.tool}: tolerated twice`);
    seen.add(t.tool);
    if (!/^[0-9a-f]{64}$/.test(t.listingHash))
      out.push(`${t.tool}: the listing hash is not a sha256`);
  }
  return out;
}

/** Why a server's page cursor may not be sent back, or undefined: an opaque token, short, no "..". */
export function cursorProblem(cursor: unknown): CouldNotCheckReason | undefined {
  return typeof cursor === "string" &&
    /^[A-Za-z0-9+/=_.-]{1,256}$/.test(cursor) &&
    !cursor.includes("..")
    ? undefined
    : COULD_NOT_CHECK.badCursor;
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
  // Lines end in CRLF, LF or a bare CR (all three are valid in an event stream).
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
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
  // A batch (an array of messages) is read as its messages, so nothing hides inside one.
  messages = messages.flatMap((m) => (Array.isArray(m) ? (m as unknown[]) : [m]));
  // A request from the server anywhere in the answer ends the run, before or after the response.
  if (messages.some((m) => isObject(m) && typeof m.method === "string" && m.id !== undefined))
    return fail(COULD_NOT_CHECK.serverRequest);
  for (const m of messages) {
    if (!isObject(m)) continue;
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
  if (isObject(result.structuredContent))
    return Buffer.byteLength(JSON.stringify(result.structuredContent)) > maxBytes
      ? fail(COULD_NOT_CHECK.tooLarge)
      : { ok: true, data: result.structuredContent };
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

/** The longest id kept. */
const ID_MAX = 128;
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
    case "id": {
      // A rule that admits free text keeps nothing; a kept id is still cleaned (N17) and capped.
      // The fixed character set (no markup, space, quote or ".."), the cap, then the entry's own pattern.
      if (!isIdValue(v, ID_MAX) || idPatternProblem(rule.pattern) !== undefined) return undefined;
      if (!idPattern(rule.pattern).test(v)) return undefined;
      const clean = sanitise(v, ID_MAX).text;
      return clean === v ? clean : undefined;
    }
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

/** The most items a list rule may keep. */
const MAX_LIST = 10_000;

/** What is wrong with an entry's output rules; empty when every rule is closed and bounded. */
export function outputRuleProblems(rules: Readonly<Record<string, OutputRule>>, at = ""): string[] {
  const out: string[] = [];
  for (const [field, rule] of Object.entries(rules)) {
    const where = `${at}${field}`;
    const r = rule as unknown as Record<string, unknown>;
    switch (r.type) {
      case "boolean":
      case "integer":
      case "timestamp":
      case "name":
      case "count":
      case "hash":
        break;
      case "id": {
        const why = idPatternProblem(r.pattern);
        if (why !== undefined) out.push(`${where}: ${why}`);
        break;
      }
      case "enum":
        if (
          !Array.isArray(r.values) ||
          r.values.length === 0 ||
          r.values.some((v) => typeof v !== "string")
        )
          out.push(`${where}: an enum rule needs a list of values`);
        break;
      case "list":
        if (!Number.isInteger(r.max) || (r.max as number) < 1 || (r.max as number) > MAX_LIST)
          out.push(`${where}: a list rule needs a max from 1 to ${MAX_LIST}`);
        if (!isObject(r.item)) out.push(`${where}: a list rule needs item rules`);
        else out.push(...outputRuleProblems(r.item as Record<string, OutputRule>, `${where}.`));
        break;
      default:
        out.push(`${where}: not an output rule`);
    }
  }
  return out;
}
