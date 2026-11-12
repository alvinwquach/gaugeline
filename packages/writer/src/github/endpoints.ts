/**
 * The writer's whole GitHub surface (ADR-0010 part 1): three reads and three writes, each a fixed path
 * shape with a fixed body shape. A request that is not one of these is refused before it reaches the
 * network. Nothing here can approve a review, delete, force a ref, or touch any branch but the draft's
 * own `gaugeline/<id>` branch. Paths and bodies are from GitHub's REST description (see the PR's Sources).
 *
 * The registry is frozen all the way down (every entry and every array in it), and its path patterns are
 * kept as strings that checkRequest compiles, so code elsewhere in the process cannot change a method,
 * push a body key or recompile a pattern.
 */
import { isSafeRepoPath } from "../kinds.js";

export type EndpointId =
  "getRef" | "getContent" | "listPulls" | "createRef" | "putContent" | "createPull";

export interface GithubRequest {
  endpoint: EndpointId;
  /** The path under https://api.github.com, starting /repos/{owner}/{repo}. */
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

interface Endpoint {
  readonly method: "GET" | "POST" | "PUT";
  /** A regular expression's source, matched after /repos/{owner}/{repo}. Captures a file path where there is one. */
  readonly rest: string;
  readonly query: readonly string[];
  readonly body: readonly string[] | null;
  /** Body keys that must be present. */
  readonly required: readonly string[];
}

/** Freeze an entry and each array in it. */
function entry(e: Endpoint): Endpoint {
  Object.freeze(e.query);
  if (e.body) Object.freeze(e.body);
  Object.freeze(e.required);
  return Object.freeze(e);
}

/** /repos/{owner}/{repo}, then the rest. Dot segments are refused separately, for every pattern. */
const REPO = /^\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(\/.*)$/;
/** The only branch the writer creates or writes to. */
const BRANCH = /^gaugeline\/[A-Za-z0-9-]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;

export const ENDPOINTS: Readonly<Record<EndpointId, Endpoint>> = Object.freeze({
  getRef: entry({
    method: "GET",
    rest: "^/git/ref/heads/[A-Za-z0-9._/-]{1,200}$",
    query: [],
    body: null,
    required: [],
  }),
  getContent: entry({
    method: "GET",
    rest: "^/contents/(.+)$",
    query: ["ref"],
    body: null,
    required: [],
  }),
  listPulls: entry({
    method: "GET",
    rest: "^/pulls$",
    query: ["head", "state"],
    body: null,
    required: [],
  }),
  createRef: entry({
    method: "POST",
    rest: "^/git/refs$",
    query: [],
    body: ["ref", "sha"],
    required: ["ref", "sha"],
  }),
  putContent: entry({
    method: "PUT",
    rest: "^/contents/(.+)$",
    query: [],
    body: ["message", "content", "branch", "sha"],
    required: ["message", "content", "branch"],
  }),
  createPull: entry({
    method: "POST",
    rest: "^/pulls$",
    query: [],
    body: ["title", "head", "base", "body", "draft"],
    required: ["title", "head", "base", "body", "draft"],
  }),
});

export class RegistryError extends Error {}

function refuse(req: GithubRequest, why: string): never {
  throw new RegistryError(`refused ${String(req.endpoint)}: ${why}`);
}

/** Throws unless `req` is one of the registered requests, with a body of the registered shape. */
export function checkRequest(req: GithubRequest): void {
  const e = Object.hasOwn(ENDPOINTS, req.endpoint) ? ENDPOINTS[req.endpoint] : undefined;
  if (!e) refuse(req, "not a registered endpoint");
  if (typeof req.path !== "string") refuse(req, "path is not text");
  // A dot segment (or one hidden as %2e, %2f, %5c) makes the URL parser walk out of /repos/{owner}/{repo}.
  if (
    /%(2e|2f|5c)/i.test(req.path) ||
    req.path
      .split("/")
      .slice(1)
      .some((s) => s === "" || s === "." || s === "..")
  ) {
    refuse(req, "path has a dot, empty or encoded segment");
  }
  const m = REPO.exec(req.path);
  const rest = m ? new RegExp(e.rest).exec(m[1]!) : null;
  if (!rest) refuse(req, "path does not match");
  if (rest[1] !== undefined) {
    let file: string;
    try {
      file = decodeURIComponent(rest[1]);
    } catch {
      return refuse(req, "file path not allowed");
    }
    if (!isSafeRepoPath(file)) refuse(req, "file path not allowed");
  }
  for (const k of Object.keys(req.query ?? {})) if (!e.query.includes(k)) refuse(req, `query ${k}`);
  if (e.body === null) {
    if (req.body !== undefined) refuse(req, "a read has no body");
    return;
  }
  const b = req.body ?? {};
  for (const k of Object.keys(b)) if (!e.body.includes(k)) refuse(req, `body key ${k}`);
  for (const k of e.required) if (!(k in b)) refuse(req, `missing ${k}`);
  if (req.endpoint === "createRef") {
    if (!/^refs\/heads\//.test(String(b.ref)) || !BRANCH.test(String(b.ref).slice(11))) {
      refuse(req, "only a refs/heads/gaugeline/ branch is created");
    }
    if (!SHA.test(String(b.sha))) refuse(req, "sha");
  }
  if (req.endpoint === "putContent") {
    if (!BRANCH.test(String(b.branch))) refuse(req, "writes go to the draft's own branch only");
    if (b.sha !== undefined && !SHA.test(String(b.sha))) refuse(req, "sha");
  }
  if (req.endpoint === "createPull") {
    if (b.draft !== true) refuse(req, "a pull request is opened as a draft");
    if (!BRANCH.test(String(b.head))) refuse(req, "head is the draft's own branch");
  }
}
