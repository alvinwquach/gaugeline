import { GqlSyntaxError, parseGraphql } from "../query/graphql-parse.js";

/**
 * The allowlist that lets an adapter send a POST to a documented read-only query endpoint
 * (ADR-0006). A POST is never a general capability: `fetcher.query()` is the only way to send one,
 * and it checks every request against one entry of this shape before a socket opens.
 *
 * An entry says which endpoint (host, path pattern), which body shape counts as a query, and where
 * the vendor documents that endpoint as a read. Nothing here sends anything; the checks are pure
 * functions, shared by the fetcher and by the adapter contract suite.
 */

/** The one method a query is sent with. */
export type QueryMethod = "POST";

/** A GraphQL request: one operation, and it must parse as a `query`. */
export interface GraphqlQueryShape {
  kind: "graphql-query";
  /**
   * Also accept a persisted-query request: only an id (or a sha256 hash) and variables, no
   * document. Such a request cannot be read, so an entry sets this only where the vendor documents
   * that persisted ids are read-only (the id is a stored query).
   */
  persistedQueries?: boolean;
}

/** A JSON object whose top-level keys are all in `keys`, none named like a write. */
export interface JsonQueryShape {
  kind: "json-query";
  /** The vendor's documented query keys, for example ["dataCollectionId", "query"]. */
  keys: readonly string[];
}

export type QueryBodyShape = GraphqlQueryShape | JsonQueryShape;

/**
 * One allowed read-only query endpoint. Built by an adapter from its configuration (the host) and
 * the vendor's documentation (the rest), and passed to `fetcher.query()` with every request.
 */
export interface ReadOnlyQueryAllow {
  /** A short stable id, "wix-data-query": the request log records this and never the body. */
  id: string;
  /** Always POST. Anything else (PUT, PATCH, DELETE) is never allowed. */
  method: QueryMethod;
  /** The exact host (and port, if not the default), lower case, from the adapter's configuration. No wildcard. */
  host: string;
  /**
   * The path, from "/". A segment is a literal or `*`, which stands for exactly one non-empty
   * segment ("/v1/data/query/*"). No other wildcard exists.
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

/** The most bytes a query body may have once serialised. */
export const MAX_QUERY_BODY_BYTES = 64 * 1024;

/** Words that name a write. A top-level key with one of them as a word is never a query key. */
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
  "send",
  "execute",
  "truncate",
  "clear",
  "reset",
  "subscribe",
  "subscription",
]);

/** The words of a key: "updateItem", "delete_item", "$set" and "bulk-insert" split on case, digits and punctuation. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/** True for a key named like a write ("insert", "updateItem", "$set", "delete_item"). */
export function isWriteKey(key: string): boolean {
  return wordsOf(key).some((w) => WRITE_WORDS.has(w));
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

/** What is wrong with the entry itself; an empty list means it is well formed. */
export function allowProblems(allow: ReadOnlyQueryAllow): string[] {
  const out: string[] = [];
  const a = allow as unknown as Record<string, unknown>;
  if (typeof a.id !== "string" || !ID.test(a.id))
    out.push("the id must be a short lower-case name");
  if (a.method !== "POST") out.push(`the method must be POST, not ${String(a.method)}`);
  if (typeof a.host !== "string" || !HOST.test(a.host) || a.host.includes("*"))
    out.push("the host must be one exact lower-case host name, with no scheme, path or wildcard");
  const path = a.path;
  if (typeof path !== "string" || !path.startsWith("/") || /\s|\?|#/.test(path))
    out.push("the path must start with / and hold no query string");
  else if (path.split("/").some((s) => s.includes("*") && s !== "*"))
    out.push("the only wildcard in a path is a whole segment: *");
  const shape = a.body as { kind?: unknown; keys?: unknown } | undefined;
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
  } else if (shape?.kind !== "graphql-query")
    out.push("the body shape must be graphql-query or json-query");
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
  for (const key of Object.keys(body)) {
    if (GRAPHQL_KEYS.has(key)) continue;
    if (shape.persistedQueries === true && PERSISTED_KEYS.has(key)) continue;
    return `the key "${key}" is not part of a GraphQL query request`;
  }
  if (body.variables !== undefined && !isPlainObject(body.variables))
    return "variables must be an object";
  if (body.operationName !== undefined && typeof body.operationName !== "string")
    return "operationName must be a string";
  if (body.extensions !== undefined && !isPlainObject(body.extensions))
    return "extensions must be an object";
  const query = body.query;
  if (query === undefined) {
    if (shape.persistedQueries !== true)
      return "a GraphQL query request carries its query document";
    const ext = body.extensions as { persistedQuery?: { sha256Hash?: unknown } } | undefined;
    const ids = [...PERSISTED_KEYS].map((k) => body[k]).filter((v) => v !== undefined);
    const hash = ext?.persistedQuery?.sha256Hash;
    const ok =
      (ids.length === 1 && typeof ids[0] === "string" && ids[0] !== "") ||
      (ids.length === 0 && typeof hash === "string" && hash !== "");
    return ok ? undefined : "a persisted query request carries one id or one sha256 hash";
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

function jsonProblem(shape: JsonQueryShape, body: Record<string, unknown>): string | undefined {
  const allowed = new Set(shape.keys);
  for (const key of Object.keys(body)) {
    if (isWriteKey(key)) return `the key "${key}" is named like a write`;
    if (!allowed.has(key)) return `the key "${key}" is not one of the entry's query keys`;
  }
  return undefined;
}

/**
 * Why this body is not a read-only query for this entry, or undefined when it is one. The reason
 * never repeats the body (it may hold what a person searched for or a key).
 */
export function bodyProblem(allow: ReadOnlyQueryAllow, body: unknown): string | undefined {
  if (!isPlainObject(body)) return "the body must be a JSON object";
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    return "the body is not JSON";
  }
  if (text === undefined) return "the body is not JSON";
  if (Buffer.byteLength(text) > MAX_QUERY_BODY_BYTES)
    return `the body is over ${MAX_QUERY_BODY_BYTES / 1024} KB`;
  switch (allow.body.kind) {
    case "graphql-query":
      return graphqlProblem(allow.body, body);
    case "json-query":
      return jsonProblem(allow.body, body);
    default:
      return "the body shape is not one a query may have";
  }
}

/** True when the body is a read-only query of the entry's shape. */
export function isReadOnlyBody(allow: ReadOnlyQueryAllow, body: unknown): boolean {
  return bodyProblem(allow, body) === undefined;
}

/** Does the address belong to the entry (https, its host, its path, no credentials, no query string)? */
export function addressProblem(url: URL, allow: ReadOnlyQueryAllow): string | undefined {
  if (url.protocol !== "https:") return "a query goes over https only";
  if (url.username !== "" || url.password !== "") return "the address carries credentials";
  if (url.host !== allow.host) return `${url.host} is not the host of allowlist entry ${allow.id}`;
  if (url.search !== "" || url.hash !== "") return "the address has a query string or fragment";
  if (!matchesPath(allow.path, url.pathname))
    return `${url.pathname} does not match the path of allowlist entry ${allow.id}`;
  return undefined;
}

/**
 * The whole check `fetcher.query()` makes before it sends: the entry, the address, the body.
 * Undefined means the request may be sent.
 */
export function queryRefusal(
  url: URL,
  allow: ReadOnlyQueryAllow,
  body: unknown,
): string | undefined {
  const entry = allowProblems(allow);
  if (entry.length > 0) return `allowlist entry ${String(allow.id)} is not valid: ${entry[0]}`;
  return addressProblem(url, allow) ?? bodyProblem(allow, body);
}

/** A POST that was not sent because it is not a documented read-only query. */
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
