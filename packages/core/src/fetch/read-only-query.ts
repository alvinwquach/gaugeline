import { GqlSyntaxError, parseGraphql } from "../query/graphql-parse.js";

/**
 * The allowlist that lets an adapter send a POST to a documented read-only query endpoint
 * (ADR-0006). A POST is never a general capability: `fetcher.query()` is the only way to send one,
 * and it checks every request against one REGISTERED entry of this shape before a socket opens.
 *
 * An entry says which endpoint (host, path pattern), which body shape counts as a query, and where
 * the vendor documents that endpoint as a read. Entries are written once, in an adapter's own file,
 * registered at module load (`registerQueryAllow`, fetch/query-registry.ts) and frozen; the caller
 * of `fetcher.query()` names an entry by its id and cannot pass one of its own. Nothing here sends
 * anything; the checks are pure functions, shared by the fetcher and by the adapter contract suite.
 */

/** The one method a query is sent with. The registry sets it; an adapter never writes it (ADR-0006, Amendment 1). */
export type QueryMethod = "POST";

/** A GraphQL request: one operation, and it must parse as a `query`. */
export interface GraphqlQueryShape {
  kind: "graphql-query";
  /**
   * Persisted-query requests the entry allows: the ids (or sha256 hashes) of stored queries the
   * vendor documents as reads. A request with only an id is accepted when the id is on this list;
   * an id beside a `query` document is never accepted (the id could name a stored mutation).
   */
  persisted?: readonly string[];
}

/** A JSON object whose keys are the vendor's documented query keys, none named like a write. */
export interface JsonQueryShape {
  kind: "json-query";
  /** The vendor's documented top-level query keys, for example ["dataCollectionId", "query"]. */
  keys: readonly string[];
  /**
   * The query operators the vendor documents (["$eq", "$and", "$hasSome"]). A key starting with `$`
   * anywhere in the body must be on this list; with no list, no `$` key is accepted.
   */
  operators?: readonly string[];
  /** Top-level keys whose value must be one of a small set (for example a sort direction). */
  enums?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
}

export type QueryBodyShape = GraphqlQueryShape | JsonQueryShape;

/**
 * A host the adapter reads from its own validated configuration (a GraphQL endpoint the person
 * set). `configured` names the setting. The adapter passes the host with each request; the fetcher
 * checks it is one exact host name, and the entry's path and body shape still apply.
 */
export interface ConfiguredHost {
  configured: string;
}

/**
 * One allowed read-only query endpoint, as an adapter's file writes it for `registerQueryAllow`.
 * There is no `method` field: the registry fixes the method to POST itself (ADR-0006, Amendment 1),
 * so an adapter never writes the verb, and PUT, PATCH and DELETE cannot be asked for at all. An
 * entry that passes a `method` is a type error and is refused at run time.
 */
export interface ReadOnlyQueryAllow {
  /** A short stable id, "wix-data-query": the request log records this and never the body. */
  id: string;
  /** The vendor's exact host (lower case, no wildcard), or `{ configured }` for a host the person set. */
  host: string | ConfiguredHost;
  /**
   * The path, from "/". A segment is a literal or `*`, which stands for exactly one non-empty
   * segment ("/v1/data/query/*"). No other wildcard exists. No segment is named like a write.
   */
  path: string;
  body: QueryBodyShape;
  /** Where the vendor documents this endpoint as a read, query or search endpoint. */
  docs: {
    /** https page of the vendor's documentation. */
    url: string;
    /** YYYY-MM-DD the page was last read to confirm the endpoint only reads, or null: not verified. */
    checked: string | null;
  };
}

/** What `registerQueryAllow` stores and returns: the entry, frozen, with the method the registry fixed. */
export interface RegisteredQueryAllow extends ReadOnlyQueryAllow {
  readonly method: QueryMethod;
}

/** The most bytes a query body may have once serialised. */
export const MAX_QUERY_BODY_BYTES = 64 * 1024;
/** The deepest a JSON query may nest. */
const MAX_DEPTH = 16;

/** Words that name a write or an action. A key (or path segment) with one of them as a word is never a query key. */
const WRITE_WORDS: ReadonlySet<string> = new Set([
  "create",
  "insert",
  "update",
  "upsert",
  "delete",
  "remove",
  "set",
  "put",
  "patch",
  "write",
  "mutation",
  "mutations",
  "mutate",
  "drop",
  "destroy",
  "save",
  "add",
  "replace",
  "merge",
  "publish",
  "unpublish",
  "send",
  "execute",
  "truncate",
  "clear",
  "reset",
  "subscribe",
  "subscription",
  "purge",
  "wipe",
  "erase",
  "archive",
  "import",
  "submit",
  "cancel",
  "restore",
  "charge",
  "pay",
  "refund",
  "checkout",
  "approve",
  "reject",
  "assign",
  "invite",
  "login",
  "register",
  "signup",
  "upload",
  "transfer",
  "grant",
  "revoke",
  "deploy",
  "trigger",
  "enqueue",
  "overwrite",
  "unset",
  "rename",
  "push",
  "pull",
  "pop",
  "inc",
  "increment",
  "decrement",
  "append",
  "prepend",
]);

/**
 * Verbs long enough to be recognised inside a run of letters with no separator ("deleteitem",
 * "bulkdelete", "UPDATEITEM"). Short words (add, set, pay) only match as whole words, so "address",
 * "settings" and "offset" are not writes.
 */
const AFFIX_VERBS: readonly string[] = [
  "create",
  "insert",
  "update",
  "upsert",
  "delete",
  "remove",
  "mutate",
  "destroy",
  "replace",
  "publish",
  "purge",
  "execute",
  "truncate",
  "overwrite",
];
/** What may follow a verb in an ordinary word: "created", "updates", "publishing". */
const INFLECTIONS: ReadonlySet<string> = new Set([
  "d",
  "s",
  "es",
  "ed",
  "ing",
  "ion",
  "ions",
  "ive",
  "able",
  "r",
  "rs",
  "er",
  "ers",
]);

/** The words of a key: "updateItem", "UPDATEItem", "delete_item", "$set" and "bulk-insert" split on case and punctuation. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/**
 * True for a key named like a write: a word on the list ("insert", "updateItem", "$set",
 * "delete_item", "mutation"), or a long verb run together with another word ("deleteitem",
 * "bulkdelete", "UPDATEITEM"). Inflections are not writes ("createdDate" is a field).
 */
export function isWriteKey(key: string): boolean {
  for (const word of wordsOf(key)) {
    if (WRITE_WORDS.has(word)) return true;
    for (const verb of AFFIX_VERBS) {
      if (word.length > verb.length && word.endsWith(verb)) return true;
      if (
        word.length > verb.length &&
        word.startsWith(verb) &&
        !INFLECTIONS.has(word.slice(verb.length))
      )
        return true;
    }
  }
  return false;
}

/** A string value that is a statement rather than data: SQL that changes something, or a GraphQL mutation. */
const WRITE_STATEMENT =
  /(^\s*(mutation|subscription)\b)|\b(delete\s+from|insert\s+into|update\s+[\w."`[\]]+\s+set|drop\s+(table|database|schema|index|view)|truncate\s+table|alter\s+table|create\s+table|merge\s+into|upsert\s+into|replace\s+into)\b/i;

/** True for a string value that reads as a write statement (not for data that merely holds a word). */
export function isWriteText(value: string): boolean {
  return WRITE_STATEMENT.test(value.trim());
}

/** Does `pathname` match the pattern? A segment is literal or `*` (one whole non-empty segment). */
export function matchesPath(pattern: string, pathname: string): boolean {
  // Encoded slashes and dots would let a path say one thing and mean another to the server.
  if (/%2f|%5c|%2e/i.test(pathname) || pathname.includes("\\")) return false;
  const want = pattern.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return false;
  return want.every((w, i) => {
    const g = got[i] ?? "";
    if (w === "*") return g !== "" && g !== "." && g !== "..";
    if (g === "." || g === "..") return false;
    return w === g;
  });
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Is this one exact lower-case host name (and optional port), with no scheme, path or wildcard? */
export function isExactHost(host: unknown): host is string {
  return typeof host === "string" && HOST.test(host) && !host.includes("*");
}

/**
 * What is wrong with the entry itself; an empty list means it is well formed. An entry an adapter
 * wrote must have no `method` key at all (the registry fixes it); with `{ stored: true }` the entry
 * is one the registry stored, whose method must be the fixed one.
 */
export function allowProblems(
  allow: ReadOnlyQueryAllow,
  opts: { stored?: boolean } = {},
): string[] {
  const out: string[] = [];
  const a = allow as unknown as Record<string, unknown>;
  if (typeof a.id !== "string" || !ID.test(a.id))
    out.push("the id must be a short lower-case name");
  if (opts.stored === true) {
    if (a.method !== "POST") out.push(`the method must be POST, not ${String(a.method)}`);
  } else if ("method" in a)
    out.push("the method is fixed by the registry: remove the method key from the entry");
  const host = a.host as { configured?: unknown } | string | undefined;
  if (typeof host === "string") {
    if (!isExactHost(host))
      out.push("the host must be one exact lower-case host name, with no scheme, path or wildcard");
  } else if (typeof host?.configured !== "string" || host.configured === "")
    out.push("the host is an exact host name, or { configured: <the setting's name> }");
  const path = a.path;
  if (typeof path !== "string" || !path.startsWith("/") || /\s|\?|#/.test(path))
    out.push("the path must start with / and hold no query string");
  else {
    const segments = path.split("/");
    if (segments.some((s) => s.includes("*") && s !== "*"))
      out.push("the only wildcard in a path is a whole segment: *");
    const bad = segments.find((s) => s !== "*" && isWriteKey(s));
    if (bad !== undefined) out.push(`the path segment "${bad}" is named like a write`);
  }
  const shape = a.body as
    { kind?: unknown; keys?: unknown; operators?: unknown; persisted?: unknown } | undefined;
  if (shape?.kind === "json-query") {
    const keys = shape.keys;
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.some((k) => typeof k !== "string" || k === "")
    )
      out.push("a json-query entry lists the query keys it allows");
    else
      for (const k of keys as string[])
        if (isWriteKey(k)) out.push(`the key "${k}" is named like a write`);
    const ops = shape.operators;
    if (ops !== undefined) {
      if (!Array.isArray(ops) || ops.some((o) => typeof o !== "string" || !/^\$[A-Za-z]+$/.test(o)))
        out.push("operators are names like $eq");
      else
        for (const o of ops as string[])
          if (isWriteKey(o)) out.push(`the operator "${o}" is named like a write`);
    }
  } else if (shape?.kind === "graphql-query") {
    const p = shape.persisted;
    if (p !== undefined && (!Array.isArray(p) || p.some((x) => typeof x !== "string" || x === "")))
      out.push("persisted is a list of the stored query ids the vendor documents as reads");
  } else out.push("the body shape must be graphql-query or json-query");
  const docs = a.docs as { url?: unknown; checked?: unknown } | undefined;
  if (typeof docs?.url !== "string" || !docs.url.startsWith("https://"))
    out.push("docs.url must be an https page of the vendor's documentation");
  if (docs?.checked !== null && (typeof docs?.checked !== "string" || !DATE.test(docs.checked)))
    out.push("docs.checked must be a YYYY-MM-DD date, or null when not verified");
  return out;
}

/** True when the vendor's page was read and the date recorded; false: marked not verified. */
export function isVerified(allow: ReadOnlyQueryAllow): boolean {
  return allow.docs.checked !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

const GRAPHQL_KEYS: ReadonlySet<string> = new Set([
  "query",
  "variables",
  "operationName",
  "extensions",
]);
const PERSISTED_KEYS: ReadonlySet<string> = new Set(["id", "documentId", "queryId"]);

function graphqlProblem(
  shape: GraphqlQueryShape,
  body: Record<string, unknown>,
): string | undefined {
  const persisted = shape.persisted ?? [];
  for (const key of Object.keys(body)) {
    if (GRAPHQL_KEYS.has(key)) continue;
    if (persisted.length > 0 && PERSISTED_KEYS.has(key)) continue;
    return `the key "${key}" is not part of a GraphQL query request`;
  }
  if (body.variables !== undefined && !isPlainObject(body.variables))
    return "variables must be an object";
  if (body.operationName !== undefined && typeof body.operationName !== "string")
    return "operationName must be a string";
  if (body.extensions !== undefined && !isPlainObject(body.extensions))
    return "extensions must be an object";
  const ext = body.extensions as { persistedQuery?: { sha256Hash?: unknown } } | undefined;
  const ids = [...PERSISTED_KEYS].map((k) => body[k]).filter((v) => v !== undefined);
  const hash = ext?.persistedQuery?.sha256Hash;
  const query = body.query;
  if (query !== undefined) {
    // A stored id beside a document could run the stored operation, whatever the document says.
    if (ids.length > 0 || hash !== undefined)
      return "a query request carries a query document or a stored query id, never both";
  } else {
    const named = ids.length === 1 && typeof ids[0] === "string" ? ids[0] : hash;
    if (
      ids.length > 1 ||
      (ids.length === 1 && hash !== undefined) ||
      typeof named !== "string" ||
      named === ""
    )
      return "a stored query request carries one id or one sha256 hash";
    if (!persisted.includes(named)) return "this stored query id is not on the entry's list";
    return undefined;
  }
  if (typeof query !== "string") return "the query must be a string";
  let defs;
  try {
    defs = parseGraphql(query);
  } catch (err) {
    if (err instanceof GqlSyntaxError) return "the query is not a GraphQL document";
    throw err;
  }
  const operations = defs.filter((d) => d.kind === "operation");
  if (defs.some((d) => d.kind !== "operation" && d.kind !== "fragment"))
    return "a query request holds operations and fragments only";
  if (operations.length !== 1) return "a query request holds exactly one operation";
  const op = operations[0];
  if (op?.kind === "operation" && op.operation !== "query")
    return `the operation is a ${op.operation}, not a query`;
  return undefined;
}

/** Walk every key and string value below the top level: operators on the list, no write-looking key, no statement. */
function walk(value: unknown, shape: JsonQueryShape, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return `the body nests deeper than ${MAX_DEPTH} levels`;
  if (typeof value === "string")
    return isWriteText(value) ? "a value reads as a write statement" : undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const why = walk(v, shape, depth + 1);
      if (why !== undefined) return why;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith("$")) {
        if (!(shape.operators ?? []).includes(key))
          return `the operator "${key}" is not one of the entry's operators`;
      } else if (isWriteKey(key)) return `the key "${key}" is named like a write`;
      const why = walk(v, shape, depth + 1);
      if (why !== undefined) return why;
    }
  }
  return undefined;
}

function jsonProblem(shape: JsonQueryShape, body: Record<string, unknown>): string | undefined {
  const allowed = new Set(shape.keys);
  for (const [key, value] of Object.entries(body)) {
    if (isWriteKey(key)) return `the key "${key}" is named like a write`;
    if (!allowed.has(key)) return `the key "${key}" is not one of the entry's query keys`;
    const choices = shape.enums?.[key];
    if (choices !== undefined && !choices.some((c) => c === value))
      return `the value of "${key}" is not one of the entry's allowed values`;
    const why = walk(value, shape, 1);
    if (why !== undefined) return why;
  }
  return undefined;
}

/**
 * Serialise a body once. The text is what is validated (parsed back) and what is sent, so a
 * getter or `toJSON` that answers differently the second time cannot make them differ.
 */
export function serializeBody(
  body: unknown,
): { ok: true; text: string; parsed: unknown } | { ok: false; reason: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    return { ok: false, reason: "the body is not JSON" };
  }
  if (text === undefined) return { ok: false, reason: "the body is not JSON" };
  if (Buffer.byteLength(text) > MAX_QUERY_BODY_BYTES)
    return { ok: false, reason: `the body is over ${MAX_QUERY_BODY_BYTES / 1024} KB` };
  return { ok: true, text, parsed: JSON.parse(text) as unknown };
}

/**
 * Why this body is not a read-only query for this entry, or undefined when it is one. The reason
 * never repeats the body (it may hold what a person searched for or a key).
 */
export function bodyProblem(allow: ReadOnlyQueryAllow, body: unknown): string | undefined {
  const s = serializeBody(body);
  if (!s.ok) return s.reason;
  const parsed = s.parsed;
  if (!isPlainObject(parsed)) return "the body must be a JSON object";
  switch (allow.body.kind) {
    case "graphql-query":
      return graphqlProblem(allow.body, parsed);
    case "json-query":
      return jsonProblem(allow.body, parsed);
    default:
      return "the body shape is not one a query may have";
  }
}

/** True when the body is a read-only query of the entry's shape. */
export function isReadOnlyBody(allow: ReadOnlyQueryAllow, body: unknown): boolean {
  return bodyProblem(allow, body) === undefined;
}

/** The host a request to this entry must go to: the entry's own, or the configured one the adapter passed. */
export function effectiveHost(allow: ReadOnlyQueryAllow, configured?: string): string | undefined {
  if (typeof allow.host === "string") return configured === undefined ? allow.host : undefined;
  return isExactHost(configured) ? configured : undefined;
}

/** Does the address belong to the entry (https, its host, its path, no credentials, no query string)? */
export function addressProblem(
  url: URL,
  allow: ReadOnlyQueryAllow,
  configuredHost?: string,
): string | undefined {
  if (url.protocol !== "https:") return "a query goes over https only";
  if (url.username !== "" || url.password !== "") return "the address carries credentials";
  const host = effectiveHost(allow, configuredHost);
  if (host === undefined)
    return typeof allow.host === "string"
      ? `allowlist entry ${allow.id} has a fixed host and is not given another`
      : `allowlist entry ${allow.id} needs the host from the adapter's configuration (one exact host name)`;
  if (url.host !== host) return `${url.host} is not the host of allowlist entry ${allow.id}`;
  if (url.search !== "" || url.hash !== "") return "the address has a query string or fragment";
  if (!matchesPath(allow.path, url.pathname))
    return `${url.pathname} does not match the path of allowlist entry ${allow.id}`;
  return undefined;
}

/**
 * The whole check `fetcher.query()` makes before it sends: the entry, the address, the body.
 * `body` is the parsed copy of the text that will be sent. Undefined means the request may be sent.
 */
export function queryRefusal(
  url: URL,
  allow: ReadOnlyQueryAllow,
  body: unknown,
  configuredHost?: string,
): string | undefined {
  // The fetcher passes the registry's stored entry (method fixed to POST); a bare entry (a unit
  // test's fixture) has no method key. Either way a method that is there must be POST.
  const entry = allowProblems(allow, { stored: "method" in allow });
  if (entry.length > 0) return `allowlist entry ${String(allow.id)} is not valid: ${entry[0]}`;
  return addressProblem(url, allow, configuredHost) ?? bodyProblem(allow, body);
}

/** A POST that was not sent because it is not a documented read-only query. The message never holds the address's path or query. */
export class QueryRefusedError extends TypeError {
  readonly allowId: string;
  constructor(host: string, allowId: string, reason: string) {
    super(
      `Gaugeline is read-only: refusing to send a POST to ${host} (allowlist entry ${allowId}): ${reason}.`,
    );
    this.name = "QueryRefusedError";
    this.allowId = allowId;
  }
}
