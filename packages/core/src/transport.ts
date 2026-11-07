import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { certificateOf, type Certificate } from "./dns/certificate.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Turns a host name into addresses. Injected in tests to simulate DNS, including rebinding. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** Decompressed body. Errors with name "TimeoutError" when the deadline passes. */
  body: Readable;
  /** Over https: the certificate the server presented (read from the connection, no extra request). */
  certificate?: Certificate;
}

export interface SendOptions {
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  /** The address that was checked. The socket connects here and nowhere else: no second lookup. */
  pinned: ResolvedAddress;
  timeoutMs: number;
  /**
   * Over https: trust only this certificate authority instead of the system's (a private staging
   * CA, or the tests' own). Verification is never turned off.
   */
  ca?: string;
}

function timeoutError(ms: number): Error {
  const err = new Error(`No answer within ${ms} ms`);
  err.name = "TimeoutError";
  return err;
}

function toRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function decode(res: IncomingMessage): Readable {
  const encoding = (res.headers["content-encoding"] ?? "").toLowerCase().trim();
  const stream =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
  if (!stream) return res;
  res.on("error", (err) => stream.destroy(err));
  return res.pipe(stream);
}

/**
 * One HTTP request over node:http or node:https. The custom lookup hands the socket the address
 * that was already checked, so a DNS answer that changes between the check and the connection
 * (rebinding) cannot redirect it. TLS still verifies the certificate against the host name.
 */
export function send(url: URL, opts: SendOptions): Promise<TransportResponse> {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all === true) {
      (
        callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void
      )(null, [{ address: opts.pinned.address, family: opts.pinned.family }]);
    } else {
      callback(null, opts.pinned.address, opts.pinned.family);
    }
  };
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request(url, {
      method: opts.method,
      headers: { "accept-encoding": "gzip, deflate, br", ...opts.headers },
      agent: false,
      lookup: pinnedLookup,
      ...(opts.ca && url.protocol === "https:" ? { ca: opts.ca } : {}),
    });
    const timer = setTimeout(() => {
      const err = timeoutError(opts.timeoutMs);
      req.destroy(err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    }, opts.timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.on("response", (res) => {
      settled = true;
      const body = decode(res);
      const done = () => clearTimeout(timer);
      body.on("end", done);
      body.on("close", done);
      body.on("error", done);
      // The deadline covers the body too.
      req.removeAllListeners("error");
      req.on("error", (err) => body.destroy(err));
      const certificate = certificateOf(res.socket);
      resolve({
        status: res.statusCode ?? 0,
        headers: toRecord(res.headers),
        body,
        ...(certificate ? { certificate } : {}),
      });
    });
    req.end();
  });
}
