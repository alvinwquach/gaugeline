import type { Readable } from "node:stream";
import { FetchError, type Transport } from "../fetcher.js";
import { isAnalyticsRequest } from "./deny-hosts.js";
import {
  BLOCK_REASONS,
  DEFAULT_RENDER_LIMITS,
  emptyBlocked,
  type BlockReason,
  type RenderLimits,
  type RenderedRequest,
} from "./types.js";

/**
 * The egress gate (ADR-0009, part 3): every request a rendered page makes is answered here, never by the
 * browser's own network. A browser that fetched for itself would resolve names itself (so a name that
 * resolves to a private address, or changes between a check and a connection, would get through) and would
 * follow a redirect without asking again. Here:
 *
 *   - only GET and HEAD are ever sent; any other method is aborted and counted;
 *   - only http and https; anything else is aborted;
 *   - an analytics host is aborted, recorded and never reached;
 *   - the request goes out through the fetcher's own transport, which refuses private, loopback,
 *     link-local and metadata addresses (unless the run said --allow-private) on the address it resolved,
 *     and connects to the address it checked;
 *   - a redirect is never handed to the browser: a subresource's is followed here, hop by hop, and a
 *     navigation's is answered with a one-line page that sends the browser to the next address, which comes
 *     back through this gate and is checked again (a redirect answered to the browser as a redirect is
 *     followed by the browser's own network, without a second look: checked on Chromium 1243);
 *   - no cookie, credential or header the page chose is forwarded, and no Set-Cookie comes back;
 *   - caps on requests, bytes and redirects turn the rest of the page into could-not-check.
 *
 * Nothing here knows about a browser: it is plain data in, plain data out, so the rules are testable
 * without one and a second renderer could use the same gate.
 */

export interface GateRequest {
  url: string;
  method: string;
  /** What asked: "document", "script", "image", "fetch" ... (Playwright's resource type). */
  kind: string;
  /** Whose request: the page itself, a frame inside it, or a window it opened. */
  frame: "main" | "sub" | "popup";
  headers?: Record<string, string>;
}

export type GateAnswer =
  | { action: "fulfill"; status: number; headers: Record<string, string>; body: Buffer }
  | { action: "abort"; reason: BlockReason };

export type CapName = "requests" | "bytes" | "redirects" | "time";

export interface GateState {
  /** Recorded requests, at most `limits.requests`. */
  readonly requests: readonly RenderedRequest[];
  readonly blocked: Readonly<Record<BlockReason, number>>;
  /** Every request attempted, including those past the list's cap. */
  readonly totalRequests: number;
  /** Bytes handed to the page. */
  readonly bytes: number;
  /** The cap that tripped first, if one did. */
  readonly capped?: CapName;
  /** The main frame's last document: where it ended and how the server answered. */
  readonly finalUrl?: string;
  readonly status?: number;
  /** Why the main frame's latest document was refused, if it was: a later document that is served clears it. */
  readonly mainBlock?: BlockReason;
  /** A redirect was handed to the main frame and the browser has not come back for the next address yet. */
  readonly redirectPending?: boolean;
}

export interface EgressGate {
  handle(request: GateRequest): Promise<GateAnswer>;
  /** Count something the browser layer stopped itself: a WebSocket, a window, a form. */
  note(reason: "websocket" | "popup" | "form"): void;
  /** Stop answering: everything after this is aborted. */
  close(cap?: CapName): void;
  readonly state: GateState;
}

/** The only request headers that leave. A cookie, an authorization header or a custom header never does. */
const FORWARD = ["accept", "accept-language", "user-agent", "referer"] as const;

/** Response headers that are the transport's, or that would set state in the browser. */
const DROP = new Set([
  "set-cookie",
  "set-cookie2",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "location",
]);

const MAX_RECORDED_URL = 300;
const REQUEST_TIMEOUT_MS = 10_000;

/** Origin and path only: a query string or fragment can carry a token. */
function recordable(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin === "null" ? `${u.protocol}//` : u.origin}${u.pathname}`.slice(
      0,
      MAX_RECORDED_URL,
    );
  } catch {
    return raw.split(/[?#]/)[0]?.slice(0, MAX_RECORDED_URL) ?? "";
  }
}

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function readCapped(
  body: Readable,
  cap: number,
): Promise<{ bytes: Buffer } | { tooBig: true }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > cap) {
        body.destroy();
        return { tooBig: true };
      }
      chunks.push(buf);
    }
  } catch (err) {
    body.destroy();
    throw err;
  }
  return { bytes: Buffer.concat(chunks) };
}

export function createEgressGate(opts: {
  transport: Transport;
  limits?: Partial<RenderLimits>;
  /**
   * A refusal the load asked for itself (a variant that takes scripts from other sites away), judged on the address
   * a request names and on every address a redirect names, before anything is sent. It can only add refusals: a
   * request it lets through is judged by every other rule here. It fails closed: only an explicit `false` (or a
   * promise of one) lets a request on; a throw, a rejection or any other answer refuses it.
   */
  refuse?: (target: string, req: GateRequest) => boolean | Promise<boolean>;
}): EgressGate {
  const limits: RenderLimits = { ...DEFAULT_RENDER_LIMITS, ...opts.limits };
  const requests: RenderedRequest[] = [];
  const blocked = emptyBlocked();
  let total = 0;
  let bytes = 0;
  let capped: CapName | undefined;
  let closed = false;
  let finalUrl: string | undefined;
  let status: number | undefined;
  let mainBlock: BlockReason | undefined;
  let redirectPending = false;
  /** Redirects answered to the browser in a row for a navigation. */
  let navHops = 0;

  const trip = (cap: CapName) => {
    capped ??= cap;
  };

  const record = (r: RenderedRequest) => {
    if (requests.length < limits.requests) requests.push(r);
  };

  function block(req: GateRequest, reason: BlockReason, url: string = req.url): GateAnswer {
    blocked[reason] += 1;
    record({
      url: recordable(url),
      method: req.method.slice(0, 16),
      kind: req.kind,
      verdict: "blocked",
      reason,
    });
    if (req.kind === "document" && req.frame === "main") {
      mainBlock = reason;
      redirectPending = false;
    }
    return { action: "abort", reason };
  }

  /** What stops a request before it is sent, judged on its text alone. */
  function refusal(target: string): BlockReason | undefined {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return "scheme";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
    if (isAnalyticsRequest(url)) return "analytics";
    return undefined;
  }

  function forwarded(headers: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of FORWARD) {
      const value = headers?.[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  /**
   * The load's own refusal, failing closed: only an explicit `false` lets a request on. A callback that throws,
   * rejects, or answers anything else (undefined, null, an object) refuses it. Without a callback nothing is refused.
   */
  const refusedByLoad = async (target: string, req: GateRequest): Promise<boolean> => {
    const callback = opts.refuse;
    if (callback === undefined) return false;
    try {
      return (await callback(target, req)) !== false;
    } catch {
      return true;
    }
  };

  async function handle(req: GateRequest): Promise<GateAnswer> {
    total += 1;
    if (closed) return block(req, "cap");
    if (total > limits.requests) {
      trip("requests");
      return block(req, "cap");
    }
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return block(req, "method");
    if (req.frame === "popup") return block(req, "popup");
    const first = refusal(req.url);
    if (first !== undefined) return block(req, first);
    if (await refusedByLoad(req.url, req)) return block(req, "variant");

    const navigation = req.kind === "document";
    if (navigation && req.frame === "main") redirectPending = false;
    let current = req.url;
    for (let hop = 0; ; hop += 1) {
      let response;
      try {
        response = await opts.transport(new URL(current), {
          method: method as "GET" | "HEAD",
          headers: forwarded(req.headers),
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (err) {
        const refused =
          err instanceof FetchError &&
          (err.reason === "private-address-refused" || err.reason === "blocked-address");
        return block(req, refused ? "address" : "failed", current);
      }

      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        response.body.destroy();
        let next: string;
        try {
          next = new URL(location.trim(), current).href;
        } catch {
          return block(req, "scheme", current);
        }
        const why = refusal(next);
        if (why !== undefined) return block(req, why, next);
        if (await refusedByLoad(next, req)) return block(req, "variant", next);
        if (navigation) {
          navHops += 1;
          if (navHops > limits.redirects) {
            trip("redirects");
            return block(req, "cap", next);
          }
          record({
            url: recordable(current),
            method,
            kind: req.kind,
            verdict: "allowed",
            status: response.status,
            bytes: 0,
          });
          if (req.frame === "main") redirectPending = true;
          // Not a 3xx: the browser would follow it on its own network. A page that sends it to `next`
          // through this gate instead, so `next` is judged like any other request.
          const html = `<!doctype html><meta http-equiv="refresh" content="0;url=${escapeAttribute(next)}">`;
          return {
            action: "fulfill",
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
            body: Buffer.from(html),
          };
        }
        if (hop >= limits.redirects) {
          trip("redirects");
          return block(req, "cap", next);
        }
        current = next;
        continue;
      }

      let body: Buffer = Buffer.alloc(0);
      if (method === "GET") {
        const read = await readCapped(response.body, limits.responseBytes).catch(() => undefined);
        if (read === undefined) return block(req, "failed", current);
        if ("tooBig" in read) {
          trip("bytes");
          return block(req, "cap", current);
        }
        body = read.bytes;
      } else response.body.destroy();
      if (bytes + body.length > limits.bytes) {
        trip("bytes");
        return block(req, "cap", current);
      }
      bytes += body.length;
      if (navigation) {
        navHops = 0;
        if (req.frame === "main") {
          finalUrl = current;
          status = response.status;
          mainBlock = undefined;
        }
      }
      record({
        url: recordable(current),
        method,
        kind: req.kind,
        verdict: "allowed",
        status: response.status,
        bytes: body.length,
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers))
        if (!DROP.has(name.toLowerCase())) headers[name] = value;
      return { action: "fulfill", status: response.status, headers, body };
    }
  }

  return {
    handle,
    note(reason) {
      blocked[reason] += 1;
    },
    close(cap) {
      closed = true;
      if (cap) trip(cap);
    },
    get state(): GateState {
      return {
        requests,
        blocked,
        totalRequests: total,
        bytes,
        ...(capped ? { capped } : {}),
        ...(finalUrl !== undefined ? { finalUrl } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(mainBlock !== undefined ? { mainBlock } : {}),
        ...(redirectPending ? { redirectPending } : {}),
      };
    },
  };
}

export { BLOCK_REASONS };
