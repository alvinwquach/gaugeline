/**
 * The writer's whole Sanity surface (ADR-0010 part 1, X71): one read of one document and one mutation
 * request, each a fixed path shape with a fixed body shape. A request that is not one of these is refused
 * before it reaches the network. The mutation request can only `create` one `drafts.<id>` document (which
 * Sanity refuses when that id exists). It cannot name a live id, patch, replace, remove, use a query
 * selector or run an action, so there is no request here that makes a change live or overwrites a draft.
 *
 * Like the GitHub registry next to it, it is frozen all the way down (every entry and every array in it), so
 * code elsewhere in the process cannot change a method or push a body key. The target (project, dataset and
 * API version) comes from the customer's worker configuration for the site, never from a payload; a path must
 * name exactly that dataset and that API version.
 */

export type SanityEndpointId = "getDoc" | "mutate";

export interface SanityRequest {
  endpoint: SanityEndpointId;
  /** The path under https://<project>.api.sanity.io, starting /v<version>/data/. */
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

/** Where a site's content lives. All three are plain names, checked by `isSanityTarget`. */
export interface SanityTarget {
  projectId: string;
  dataset: string;
  /** "v" and a date: the API version the requests are written for. */
  apiVersion: string;
}

interface Endpoint {
  readonly method: "GET" | "POST";
  /** The path's directory under /v<version>/data/, before the dataset. */
  readonly area: "doc" | "mutate";
  readonly query: readonly string[];
  readonly body: readonly string[] | null;
}

/** Freeze an entry and each array in it. */
function entry(e: Endpoint): Endpoint {
  Object.freeze(e.query);
  if (e.body) Object.freeze(e.body);
  return Object.freeze(e);
}

export const SANITY_ENDPOINTS: Readonly<Record<SanityEndpointId, Endpoint>> = Object.freeze({
  getDoc: entry({ method: "GET", area: "doc", query: [], body: null }),
  mutate: entry({ method: "POST", area: "mutate", query: ["returnIds"], body: ["mutations"] }),
});

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const DATASET = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const API_VERSION = /^v(\d{4})-(\d{2})-(\d{2})$/;
/** A document id the writer will read or name: letters, digits, `_` and `-`, not starting with `_`. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A document type, and a field name: a letter first, so Sanity's own `_id`, `_type`, `_rev` are never named. */
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DRAFTS = "drafts.";

/** True when `target` is plain names: a lower-case project id and dataset, and "v" with a real calendar date. */
export function isSanityTarget(t: SanityTarget): boolean {
  const v = typeof t.apiVersion === "string" ? API_VERSION.exec(t.apiVersion) : null;
  if (!v) return false;
  const [year, month, day] = [Number(v[1]), Number(v[2]), Number(v[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    typeof t.projectId === "string" &&
    PROJECT_ID.test(t.projectId) &&
    typeof t.dataset === "string" &&
    DATASET.test(t.dataset) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** A plain document id, optionally with the one `drafts.` prefix. No dots otherwise, no slash, no `%`. */
export function isPlainDocumentId(id: string): boolean {
  return (
    typeof id === "string" && PLAIN_ID.test(id.startsWith(DRAFTS) ? id.slice(DRAFTS.length) : id)
  );
}

/** True for `drafts.<plain id>`. */
function isDraftId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(DRAFTS) && PLAIN_ID.test(id.slice(DRAFTS.length));
}

export class SanityRegistryError extends Error {}

function refuse(req: SanityRequest, why: string): never {
  throw new SanityRegistryError(`refused ${String(req.endpoint)}: ${why}`);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The id a mutation names, or a refusal. The one registered operation is `create` of a `drafts.<id>`
 * document: Sanity refuses a `create` whose id already exists, so it can never overwrite a draft an editor
 * has started (`createIfNotExists` would quietly do nothing and `createOrReplace` would overwrite). The
 * document is a copy of the live one with the fix in it: its own id and type, and its content. The content
 * system's own fields (_rev, _createdAt, ...) are never sent.
 */
function checkMutation(req: SanityRequest, m: unknown): string {
  if (!isObject(m)) return refuse(req, "a mutation is an object");
  const ops = Object.keys(m);
  if (ops.length !== 1) return refuse(req, "a mutation has exactly one operation");
  const doc = m.create;
  if (!isObject(doc)) return refuse(req, "only create of a document is registered");
  for (const k of Object.keys(doc))
    if (k.startsWith("_") && k !== "_id" && k !== "_type") refuse(req, `system field ${k}`);
  if (!isDraftId(doc._id)) return refuse(req, "create names a drafts. id only");
  if (typeof doc._type !== "string" || !FIELD.test(doc._type)) return refuse(req, "_type");
  return doc._id;
}

/** Throws unless `req` is one of the registered requests, for this target, with a body of the registered shape. */
export function checkSanityRequest(req: SanityRequest, target: SanityTarget): void {
  const e = Object.hasOwn(SANITY_ENDPOINTS, req.endpoint)
    ? SANITY_ENDPOINTS[req.endpoint]
    : undefined;
  if (!e) refuse(req, "not a registered endpoint");
  if (!isSanityTarget(target)) refuse(req, "the target is not plain names");
  if (typeof req.path !== "string") refuse(req, "path is not text");
  const base = `/${target.apiVersion}/data/${e.area}/${target.dataset}`;
  if (e.area === "doc") {
    if (!req.path.startsWith(`${base}/`) || !isPlainDocumentId(req.path.slice(base.length + 1)))
      refuse(req, "path does not match");
  } else if (req.path !== base) {
    refuse(req, "path does not match");
  }
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (!e.query.includes(k)) refuse(req, `query ${k}`);
    if (k === "returnIds" && v !== "true") refuse(req, "returnIds is true or absent");
  }
  if (e.body === null) {
    if (req.body !== undefined) refuse(req, "a read has no body");
    return;
  }
  const b = req.body;
  if (!isObject(b)) return refuse(req, "a body is required");
  for (const k of Object.keys(b)) if (!e.body.includes(k)) refuse(req, `body key ${k}`);
  const list = b.mutations;
  if (!Array.isArray(list) || list.length !== 1) return refuse(req, "one mutation per request");
  checkMutation(req, list[0]);
}
