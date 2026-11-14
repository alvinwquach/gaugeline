/**
 * The one module that sends a pull request comment (ACTION-COMMENT; ADR-0005, amendment of 14 Nov 2026). It is
 * not the fetcher, not notify/post.ts and not the model sender, and it is named by the lint rule and the
 * post-boundary test the way those are. What it will and will not do:
 *
 * - It sends one POST, over https, to api.github.com, to /repos/{owner}/{repo}/issues/{number}/comments
 *   ("Create an issue comment", which also comments on a pull request). The host, the scheme, the port and the
 *   method are fixed here; the caller names a repository and a pull request number, validated below, and the
 *   address built from them is checked to be exactly the path it meant. GitHub Enterprise Server is not
 *   supported: GITHUB_API_URL is never read.
 * - It sends no PATCH, PUT or DELETE, so it never edits or removes a comment. Every call posts a new one.
 * - It reads nothing from the environment. The workflow's own token arrives in the call and goes into one
 *   header; it is never kept, logged, or put in a body or an error.
 * - It sends only the text it is handed, at most MAX_COMMENT_CHARS, as the one field `body`.
 * - It never follows a redirect (a 3xx is a failure), reads no part of the answer, and refuses a name that
 *   resolves to a loopback, private, link-local, CGNAT or metadata address, at connect time, with the same rule
 *   the fetcher uses (../addresses.ts).
 * - It uses its own https agent, never the global one (which carries Node's env proxy, and a proxied request
 *   never calls `lookup`, so the address rule would not run). The own agent has no proxy.
 * - It makes one attempt. There is no retry: a failure is a plain line and the run carries on.
 * - It says what failed by a class, never by the response, a header or the token.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { isBlockedAddress } from "../addresses.js";

/** The only host a comment can go to. */
export const COMMENT_HOST = "api.github.com";
/** The most characters of comment one request may carry. GitHub's own limit is 65,536. */
export const MAX_COMMENT_CHARS = 20_000;
/** The longest a request may take. */
export const COMMENT_TIMEOUT_MS = 15_000;

/** Thrown inside a lookup when a name resolves to an address outside the public internet. */
const NOT_PUBLIC = "EGAUGELINENOTPUBLIC";
/** A repository owner or name as GitHub spells it: letters, digits, dots, hyphens and underscores. */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The pull request a comment goes to. */
export interface CommentTarget {
  owner: string;
  repo: string;
  /** The pull request's number. */
  pullNumber: number;
}

/** Why a comment was not posted. Chosen from the status and headers, never from the answer's words. */
export type CommentFailure =
  /** Nothing was sent: the target or the text was refused. */
  | "refused"
  /** 403: the token cannot write here. A pull request from a fork has a read-only token. */
  | "read-only-token"
  /** 403 or 429 with a rate-limit header: nothing is retried. */
  | "rate-limited"
  /** 401: the token was not accepted. */
  | "bad-token"
  /** 404 or 410: no such pull request, or the token cannot see it. */
  | "not-found"
  /** 422: GitHub did not accept the comment. */
  | "rejected"
  /** 3xx: not followed. */
  | "redirect"
  /** 5xx. */
  | "outage"
  /** The name resolved to an address the fetcher would refuse. */
  | "blocked-address"
  /** No answer in time, or the connection failed. */
  | "unreachable"
  | "other";

export type CommentResult = { ok: true } | { ok: false; failure: CommentFailure };

/** What a caller holds: the token, the pull request and the text go in; a result comes out, never a throw. */
export type CommentSender = (call: {
  token: string;
  target: CommentTarget;
  body: string;
}) => Promise<CommentResult>;

/** What a status (and the headers that tell a rate limit from a read-only token) means, as a class. */
function classOf(status: number, headers: Record<string, unknown> | undefined): CommentFailure {
  if (status >= 500 && status < 600) return "outage";
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401) return "bad-token";
  if (status === 404 || status === 410) return "not-found";
  if (status === 422) return "rejected";
  const limited =
    status === 429 ||
    headers?.["retry-after"] !== undefined ||
    headers?.["x-ratelimit-remaining"] === "0";
  if (status === 403 || status === 429) return limited ? "rate-limited" : "read-only-token";
  return "other";
}

/** The part of a client request this module uses. node:https' request satisfies it. */
export interface RequestLike {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  end(data: Buffer): unknown;
  destroy(): unknown;
}
export type ResponseLike = Readable & { statusCode?: number; headers?: Record<string, unknown> };
/** Sends one request. The default is node:https; a test hands in one that goes to a local server. */
export type RequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (res: ResponseLike) => void,
) => RequestLike;

/** A name lookup in the shape of node:dns lookup (the default). Tests stand in for it; production never does. */
export type NameResolver = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/** A lookup that refuses any name that resolves to an address the fetcher would refuse. */
function publicLookup(resolve: NameResolver): NameResolver {
  return (hostname, options, callback) =>
    resolve(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (list.length === 0 || list.some((a) => isIP(a) === 0 || isBlockedAddress(a)))
        return callback(
          Object.assign(new Error("not a public address"), { code: NOT_PUBLIC }),
          address,
          family,
        );
      callback(null, address, family);
    });
}

/**
 * The address for a target, or undefined when the target is not a repository and a pull request number. Built
 * from validated parts, then checked to be exactly the path meant, so a name such as ".." cannot walk out of it.
 */
export function commentUrl(target: CommentTarget): URL | undefined {
  const { owner, repo, pullNumber } = target;
  if (!NAME.test(owner) || !NAME.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo))
    return undefined;
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) return undefined;
  const path = `/repos/${owner}/${repo}/issues/${pullNumber}/comments`;
  const url = new URL(`https://${COMMENT_HOST}${path}`);
  return url.pathname === path && url.host === COMMENT_HOST ? url : undefined;
}

/** Errors that mean the host could not be reached or the connection was lost, by their code and nothing else. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

/**
 * A sender for pull request comments. `request`, `resolve` and `timeoutMs` exist so tests need no network, no
 * DNS and no wait; production passes none of them.
 */
export function createCommentSender(
  options: { request?: RequestFn; resolve?: NameResolver; timeoutMs?: number } = {},
): CommentSender {
  const send: RequestFn = options.request ?? (httpsRequest as unknown as RequestFn);
  const lookup = publicLookup(options.resolve ?? (dnsLookup as unknown as NameResolver));
  // Not the global agent: see the header. No keep-alive, so nothing outlives the call.
  const agent = new HttpsAgent({ keepAlive: false });
  const timeoutMs = Math.min(options.timeoutMs ?? COMMENT_TIMEOUT_MS, COMMENT_TIMEOUT_MS);

  return ({ token, target, body }) => {
    const url = commentUrl(target);
    if (
      url === undefined ||
      token === "" ||
      /[\r\n]/.test(token) ||
      body === "" ||
      body.length > MAX_COMMENT_CHARS
    )
      return Promise.resolve({ ok: false, failure: "refused" });
    const data = Buffer.from(JSON.stringify({ body }));
    return new Promise((resolve) => {
      let settled = false;
      let req: RequestLike | undefined;
      const finish = (result: CommentResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok) req?.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, failure: "unreachable" }), timeoutMs);
      try {
        req = send(
          url,
          {
            method: "POST",
            agent,
            lookup: lookup as unknown as RequestOptions["lookup"],
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "content-length": String(data.length),
              "content-type": "application/json",
              "user-agent": "Gaugeline (pull request comment)",
              "x-github-api-version": "2022-11-28",
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            // The answer is never read: a created comment is its own news, and a failure is its status.
            res.destroy();
            finish(
              status === 201 ? { ok: true } : { ok: false, failure: classOf(status, res.headers) },
            );
          },
        );
        req.on("error", (err) =>
          finish({
            ok: false,
            failure:
              err.code === NOT_PUBLIC
                ? "blocked-address"
                : err.code !== undefined && CONNECTION_CODES.has(err.code)
                  ? "unreachable"
                  : "other",
          }),
        );
        req.end(data);
      } catch {
        finish({ ok: false, failure: "other" });
      }
    });
  };
}
