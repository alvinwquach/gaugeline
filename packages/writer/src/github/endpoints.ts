/**
 * The writer's whole GitHub surface (ADR-0010 part 1): three reads and three writes, each a fixed path
 * shape with a fixed body shape. A request that is not one of these is refused before it reaches the
 * network. Nothing here can approve a review, delete, force a ref, or touch any branch but the draft's
 * own `gaugeline/<id>` branch. Paths and bodies are from GitHub's REST description (see the PR's Sources).
 */
import { isSafeRepoPath } from "../schema.js";

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
  method: "GET" | "POST" | "PUT";
  /** After /repos/{owner}/{repo}: the rest of the path. Captures a file path where there is one. */
  rest: RegExp;
  query: readonly string[];
  body: readonly string[] | null;
  /** Body keys that must be present. */
  required: readonly string[];
}

const REPO = /^\/repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(\/.*)$/;
/** The only branch the writer creates or writes to. */
export const BRANCH = /^gaugeline\/[A-Za-z0-9-]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;

export const ENDPOINTS: Readonly<Record<EndpointId, Endpoint>> = Object.freeze({
  getRef: {
    method: "GET",
    rest: /^\/git\/ref\/heads\/[A-Za-z0-9._/-]{1,200}$/,
    query: [],
    body: null,
    required: [],
  },
  getContent: {
    method: "GET",
    rest: /^\/contents\/(.+)$/,
    query: ["ref"],
    body: null,
    required: [],
  },
  listPulls: {
    method: "GET",
    rest: /^\/pulls$/,
    query: ["head", "state"],
    body: null,
    required: [],
  },
  createRef: {
    method: "POST",
    rest: /^\/git\/refs$/,
    query: [],
    body: ["ref", "sha"],
    required: ["ref", "sha"],
  },
  putContent: {
    method: "PUT",
    rest: /^\/contents\/(.+)$/,
    query: [],
    body: ["message", "content", "branch", "sha"],
    required: ["message", "content", "branch"],
  },
  createPull: {
    method: "POST",
    rest: /^\/pulls$/,
    query: [],
    body: ["title", "head", "base", "body", "draft"],
    required: ["title", "head", "base", "body", "draft"],
  },
});

export class RegistryError extends Error {}

function refuse(req: GithubRequest, why: string): never {
  throw new RegistryError(`refused ${String(req.endpoint)}: ${why}`);
}

/** Throws unless `req` is one of the registered requests, with a body of the registered shape. */
export function checkRequest(req: GithubRequest): void {
  const e = Object.hasOwn(ENDPOINTS, req.endpoint) ? ENDPOINTS[req.endpoint] : undefined;
  if (!e) refuse(req, "not a registered endpoint");
  const m = REPO.exec(req.path);
  const rest = m ? e.rest.exec(m[1]!) : null;
  if (!rest) refuse(req, "path does not match");
  if (rest[1] !== undefined && !isSafeRepoPath(decodeURIComponent(rest[1]))) {
    refuse(req, "file path not allowed");
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
