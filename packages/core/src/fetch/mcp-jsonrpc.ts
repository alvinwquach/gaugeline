/**
 * The `mcp-jsonrpc` body shape of `fetcher.query` (ADR-0008 Part A): one JSON-RPC message to a
 * platform's remote MCP server, checked before a socket opens. Only four methods exist here
 * (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`); a `tools/call` names a
 * tool on the entry, by exact name, and every argument passes the entry's rule for it. There is no
 * free-form string rule, so no text from a page, a finding or a server can reach a tool. Pure
 * functions, shared by the fetcher, the registry and the adapter contract suite.
 */

/** A rule for one tool argument. Closed: an argument the entry does not list is refused. */
export type McpArgumentRule =
  | { type: "const"; value: string | number | boolean }
  | { type: "enum"; values: readonly string[] }
  /** An array of distinct values, each on the list ("schemas": ["public"]). */
  | { type: "enum-list"; values: readonly string[] }
  | { type: "integer"; min: number; max: number }
  /** An identifier (a project ref, a site id): the pattern is anchored, the length capped. */
  | { type: "id"; pattern: string; maxLength: number };

export interface McpJsonRpcShape {
  kind: "mcp-jsonrpc";
  /** The exact tool names that may be called, each with its closed argument rules. */
  tools: Readonly<Record<string, Readonly<Record<string, McpArgumentRule>>>>;
}

/** The only methods a message may carry. Anything else (resources, prompts, logging, tasks, a reply to the server) is refused. */
export const MCP_METHODS: readonly string[] = Object.freeze([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
]);

/**
 * Words that mark a tool Gaugeline never calls, whatever its annotations say (ADR-0008 point 5):
 * a write or an action, a credential, the vendor fetching a page for us, or code execution.
 */
const WRITE_WORDS: ReadonlySet<string> = new Set(
  (
    "create update delete upsert insert mutate write remove merge execute invoke post patch put " +
    "send submit assign convert approve deploy run redeploy rollback revert promote publish " +
    "unpublish set apply drop destroy reset rebase restore pause resume cancel purge invalidate " +
    "flush clear push invite grant revoke rotate regenerate enable disable trigger confirm login " +
    "logout install uninstall migrate"
  ).split(" "),
);
const REFUSED_WORDS: ReadonlySet<string> = new Set(
  (
    [...WRITE_WORDS].join(" ") +
    " token tokens secret secrets key keys password passwords credential credentials " +
    "fetch browser browse screenshot url crawl scrape navigate " +
    "search eval exec code sql script shell"
  ).split(" "),
);

const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * The first write word in a tool name as any server spells it ("apply_migration", "deployFunction",
 * "confirm-cost"), or undefined. Used to check a whole listing, so it splits camel case too.
 */
export function writeWordIn(name: string): string | undefined {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((w) => WRITE_WORDS.has(w));
}

/** Why Gaugeline never calls a tool by this name, or undefined. Names are lower-case ASCII only. */
export function mcpToolNameProblem(name: string): string | undefined {
  if (!TOOL_NAME.test(name)) return `the tool name "${safe(name)}" is not a lower-case ASCII name`;
  const bad = name.split(/[_-]/).find((w) => REFUSED_WORDS.has(w));
  return bad === undefined
    ? undefined
    : `the tool "${name}" is named like a write, a credential, a fetch or code ("${bad}")`;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 40);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v) as object | null);

const isStringList = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");

function ruleProblem(rule: unknown): string | undefined {
  if (!isPlainObject(rule)) return "is not an object";
  switch (rule.type) {
    case "const":
      return ["string", "number", "boolean"].includes(typeof rule.value)
        ? undefined
        : "const needs a string, number or boolean";
    case "enum":
    case "enum-list":
      return isStringList(rule.values) ? undefined : `${rule.type} needs a list of values`;
    case "integer":
      return Number.isInteger(rule.min) &&
        Number.isInteger(rule.max) &&
        (rule.min as number) <= (rule.max as number)
        ? undefined
        : "integer needs min <= max";
    case "id": {
      const p = rule.pattern;
      if (typeof p !== "string" || !p.startsWith("^") || !p.endsWith("$"))
        return "id needs an anchored pattern";
      try {
        new RegExp(p);
      } catch {
        return "id pattern does not compile";
      }
      const n = rule.maxLength;
      return Number.isInteger(n) && (n as number) > 0 && (n as number) <= 128
        ? undefined
        : "id needs a maxLength from 1 to 128";
    }
    default:
      return "is not one of const, enum, enum-list, integer or id (there is no free-form string)";
  }
}

/** What is wrong with an entry's mcp-jsonrpc shape; empty when it is well formed. */
export function mcpShapeProblems(shape: unknown): string[] {
  const out: string[] = [];
  const tools = isPlainObject(shape) ? shape.tools : undefined;
  if (!isPlainObject(tools) || Object.keys(tools).length === 0)
    return ["an mcp-jsonrpc entry lists at least one tool"];
  for (const [name, rules] of Object.entries(tools)) {
    const why = mcpToolNameProblem(name);
    if (why !== undefined) out.push(why);
    if (!isPlainObject(rules)) {
      out.push(`the tool "${safe(name)}" needs an object of argument rules`);
      continue;
    }
    for (const [arg, rule] of Object.entries(rules)) {
      const bad = ruleProblem(rule);
      if (bad !== undefined) out.push(`the argument rule ${safe(name)}.${safe(arg)} ${bad}`);
    }
  }
  return out;
}

function argumentProblem(rule: McpArgumentRule, value: unknown): boolean {
  switch (rule.type) {
    case "const":
      return value !== rule.value;
    case "enum":
      return typeof value !== "string" || !rule.values.includes(value);
    case "enum-list":
      return (
        !Array.isArray(value) ||
        value.length === 0 ||
        new Set(value).size !== value.length ||
        value.some((v) => typeof v !== "string" || !rule.values.includes(v))
      );
    case "integer":
      return (
        !Number.isInteger(value) || (value as number) < rule.min || (value as number) > rule.max
      );
    case "id":
      return (
        typeof value !== "string" ||
        value.length > rule.maxLength ||
        !new RegExp(rule.pattern).test(value)
      );
  }
}

const VERSION = /^\d{4}-\d{2}-\d{2}$/;
const LABEL = /^[A-Za-z0-9 ._-]{1,64}$/;
const CURSOR = /^[A-Za-z0-9+/=_.-]{1,256}$/;

const extraKey = (obj: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(obj).find((k) => !allowed.includes(k));

function paramsProblem(
  shape: McpJsonRpcShape,
  method: string,
  params: unknown,
): string | undefined {
  if (method === "notifications/initialized" || method === "tools/list") {
    if (params === undefined) return undefined;
    if (!isPlainObject(params)) return "params must be an object";
    const extra = extraKey(params, method === "tools/list" ? ["cursor"] : []);
    if (extra !== undefined) return `the params key "${safe(extra)}" is not allowed`;
    if (
      params.cursor !== undefined &&
      (typeof params.cursor !== "string" || !CURSOR.test(params.cursor))
    )
      return "the cursor is not an opaque token";
    return undefined;
  }
  if (!isPlainObject(params)) return "params must be an object";
  if (method === "initialize") {
    const extra = extraKey(params, ["protocolVersion", "capabilities", "clientInfo"]);
    if (extra !== undefined) return `the params key "${safe(extra)}" is not allowed`;
    if (typeof params.protocolVersion !== "string" || !VERSION.test(params.protocolVersion))
      return "protocolVersion must be a dated revision";
    // No sampling, elicitation or roots: Gaugeline has no one to ask and answers no server request.
    if (!isPlainObject(params.capabilities) || Object.keys(params.capabilities).length > 0)
      return "the client declares no capabilities";
    const info = params.clientInfo;
    if (
      !isPlainObject(info) ||
      extraKey(info, ["name", "version"]) !== undefined ||
      typeof info.name !== "string" ||
      !LABEL.test(info.name) ||
      typeof info.version !== "string" ||
      !LABEL.test(info.version)
    )
      return "clientInfo is a short name and version";
    return undefined;
  }
  // tools/call
  const extra = extraKey(params, ["name", "arguments"]);
  if (extra !== undefined) return `the params key "${safe(extra)}" is not allowed`;
  const name = params.name;
  if (typeof name !== "string" || !Object.hasOwn(shape.tools, name))
    return `the tool "${safe(String(name))}" is not on the entry`;
  const rules = shape.tools[name] ?? {};
  const args = params.arguments ?? {};
  if (!isPlainObject(args)) return "arguments must be an object";
  for (const [arg, value] of Object.entries(args)) {
    const rule = Object.hasOwn(rules, arg) ? rules[arg] : undefined;
    if (rule === undefined || argumentProblem(rule, value))
      return `the argument "${safe(arg)}" of ${name} does not pass the entry's rule`;
  }
  return undefined;
}

/**
 * Why this parsed body is not one allowed MCP message for the shape, or undefined. The reason
 * never repeats a value from the body.
 */
export function mcpBodyProblem(shape: McpJsonRpcShape, body: unknown): string | undefined {
  if (!isPlainObject(body)) return "the body must be one JSON-RPC message (no batch)";
  const extra = extraKey(body, ["jsonrpc", "id", "method", "params"]);
  if (extra !== undefined) return `the key "${safe(extra)}" is extra in a JSON-RPC request`;
  if (body.jsonrpc !== "2.0") return "jsonrpc must be 2.0";
  const method = body.method;
  if (typeof method !== "string" || !MCP_METHODS.includes(method))
    return "the method is not initialize, notifications/initialized, tools/list or tools/call";
  const notice = method === "notifications/initialized";
  if (notice ? body.id !== undefined : !Number.isInteger(body.id) || (body.id as number) < 0)
    return notice ? "a notification carries no id" : "the id must be a whole number";
  return paramsProblem(shape, method, body.params);
}

/** A query-string option of an mcp-jsonrpc entry: a value fixed by the entry, or one the person configured. */
export type McpQueryOption = { fixed: string } | { configured: string };

const OPTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const OPTION_VALUE = /^[A-Za-z0-9_.-]{1,64}$/;

/** What is wrong with an entry's query options. */
export function queryOptionProblems(query: unknown): string[] {
  if (!isPlainObject(query) || Object.keys(query).length === 0)
    return ["the query string options are an object of { fixed } or { configured }"];
  const out: string[] = [];
  for (const [name, opt] of Object.entries(query)) {
    if (!OPTION_NAME.test(name)) out.push(`the query option "${safe(name)}" is not a plain name`);
    const ok =
      isPlainObject(opt) &&
      Object.keys(opt).length === 1 &&
      ((typeof opt.fixed === "string" && OPTION_VALUE.test(opt.fixed)) ||
        (typeof opt.configured === "string" && opt.configured !== ""));
    if (!ok)
      out.push(`the query option "${safe(name)}" is { fixed: value } or { configured: name }`);
  }
  return out;
}

/** Does the address carry exactly the entry's options, each once, fixed ones as written and configured ones as plain ids? */
export function queryStringProblem(
  params: URLSearchParams,
  options: Readonly<Record<string, McpQueryOption>>,
): string | undefined {
  const seen = [...params.keys()];
  if (new Set(seen).size !== seen.length) return "an option appears twice in the address";
  const want = Object.keys(options);
  if (seen.length !== want.length || seen.some((k) => !Object.hasOwn(options, k)))
    return "the address does not carry exactly the entry's options";
  for (const [name, opt] of Object.entries(options)) {
    const value = params.get(name) ?? "";
    if ("fixed" in opt ? value !== opt.fixed : !OPTION_VALUE.test(value))
      return `the option ${name} is not the entry's`;
  }
  return undefined;
}
