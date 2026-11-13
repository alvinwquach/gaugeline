import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { isBlockedAddress } from "../addresses.js";

/**
 * The one place Gaugeline sends a POST: to the person's own channels, at their request. It is
 * deliberately not the fetcher, so the fetcher's read-only guard still covers every request to
 * the checked site. Webhook addresses are secrets: only the host ever appears in a result.
 */
export const NOTIFY_TIMEOUT_MS = 10_000;

/** How much of a failed answer is read for its message. */
const ERROR_BODY_BYTES = 4096;

/** The "message" of a JSON error body, on one line and at most 300 characters; else undefined. */
export function providerMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message !== "string") return undefined;
    const line = parsed.message.replace(/\s+/g, " ").trim();
    return line === "" ? undefined : line.slice(0, 300);
  } catch {
    return undefined;
  }
}

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Thrown inside a lookup when a name resolves to an address outside the public internet. */
const NOT_PUBLIC = "EGAUGELINENOTPUBLIC";

/**
 * A lookup that refuses loopback, private, link-local and metadata addresses (core's address guard), for
 * sends to an address a hosted organisation saved: the connection goes to the address that was checked.
 */
function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a)))
      return callback(
        Object.assign(new Error("not a public address"), { code: NOT_PUBLIC }),
        address,
        family,
      );
    callback(null, address, family);
  });
}

/** The host of a webhook address, for messages; its path is the secret part. */
export function safeTarget(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the webhook";
  }
}

export function postJson(
  url: string,
  body: unknown,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    /** On a failed answer, add the provider's JSON "message" (first 4 KB read) to the error. */
    readError?: boolean;
    /** Refuse, before connecting, an address that is or resolves to a non-public one (hosted sends). */
    publicOnly?: boolean;
  } = {},
): Promise<PostResult> {
  const timeoutMs = opts.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const host = safeTarget(url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, error: "the webhook address is not a valid address" });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return Promise.resolve({
      ok: false,
      error: `${host}: only http and https addresses are sent to`,
    });
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (opts.publicOnly && isIP(literal) !== 0 && isBlockedAddress(literal))
    return Promise.resolve({
      ok: false,
      error: `${host} is not a public address: nothing was sent`,
    });
  const data = Buffer.from(JSON.stringify(body));
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: PostResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = send(
      u,
      {
        method: "POST",
        ...(opts.publicOnly ? { lookup: publicLookup } : {}),
        headers: {
          "content-type": "application/json",
          "content-length": String(data.length),
          "user-agent": "Gaugeline (notification)",
          ...opts.headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ((status >= 200 && status < 300) || !opts.readError) {
          res.resume();
          done(
            status >= 200 && status < 300
              ? { ok: true, status }
              : { ok: false, status, error: `${host} answered ${status}` },
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < ERROR_BODY_BYTES) chunks.push(c);
          size += c.length;
        });
        res.on("end", () => {
          const message = providerMessage(
            Buffer.concat(chunks).subarray(0, ERROR_BODY_BYTES).toString("utf8"),
          );
          done({
            ok: false,
            status,
            error: `${host} answered ${status}${message ? `: ${message}` : ""}`,
          });
        });
        res.on("error", () => done({ ok: false, status, error: `${host} answered ${status}` }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, error: `${host} did not answer within ${timeoutMs / 1000} seconds` });
    });
    // Never the raw error: it can carry the full address.
    req.on("error", (err: NodeJS.ErrnoException) =>
      done({
        ok: false,
        error:
          err.code === NOT_PUBLIC
            ? `${host} is not a public address: nothing was sent`
            : `${host} could not be reached (${err.code ?? "error"})`,
      }),
    );
    req.end(data);
  });
}
