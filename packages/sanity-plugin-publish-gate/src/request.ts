/**
 * The Studio's one network request: a GET to the Function address you configured, asking about one
 * page. Browser-safe (no node: import). The request goes to that one https origin and nowhere
 * else: no redirect is followed, no cookie or credential is sent, nothing is in the address but
 * the page's own public address, the wait is bounded, the reply is size-capped, and the reply is
 * checked against a fixed shape (answer.ts) before anything in it is used. A problem on the way
 * is an answer of "could-not-check", never a pass.
 */
import { couldNotCheck, parseGateAnswer, type GateAnswer } from "./answer.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_PAGE_URL = 2048;
/** Exactly application/json, with at most a utf-8 charset: not json-seq, jsonp or any other suffix. */
const JSON_TYPE = /^application\/json(?:\s*;\s*charset="?utf-8"?)?$/i;

export interface RequestGateOptions {
  /** The Function address you own, for example "https://gate.lantern-yard.example/check". */
  functionUrl: string;
  /** The page to check: a public http(s) address with no user name or password. */
  pageUrl: string;
  /** The longest wait for the whole reply, in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** The most bytes of reply read. Default 65536. */
  maxBytes?: number;
  /** Replaces the browser's fetch; for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The Function address as a URL, or an error that says how to fix it. One https origin: no user
 * name or password, no wildcard, no query (the Studio adds the only one) and no fragment.
 */
export function gateEndpoint(functionUrl: string): URL {
  const fail = (): never => {
    throw new Error(
      "The Function address must be a full https address with no name, password, wildcard, query or fragment, for example https://gate.lantern-yard.example/check.",
    );
  };
  if (
    typeof functionUrl !== "string" ||
    !/^https:\/\/[^\s/\\]/.test(functionUrl) ||
    /[\s?#*\\]/.test(functionUrl) ||
    !URL.canParse(functionUrl)
  )
    return fail();
  const url = new URL(functionUrl);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.host === "")
    return fail();
  return url;
}

function isPageUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PAGE_URL ||
    !/^https?:\/\/[^\s/\\]/i.test(value) ||
    !URL.canParse(value)
  )
    return false;
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === ""
  );
}

class Stop extends Error {}

/**
 * Asks the Function about one page. Throws only for a configuration that is wrong (found when the
 * Studio loads); every network or reply problem comes back as a could-not-check answer.
 */
export async function requestGate(options: RequestGateOptions): Promise<GateAnswer> {
  const endpoint = gateEndpoint(options.functionUrl);
  const pageUrl = options.pageUrl;
  if (!isPageUrl(pageUrl))
    return couldNotCheck("", "The page address is not a public http or https address.");
  const send = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const target = new URL(endpoint);
  target.searchParams.set("url", pageUrl);

  const controller = new AbortController();
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Stop("timeout")));
  });
  deadline.catch(() => undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const run = async (): Promise<GateAnswer> => {
    const stop = (reason: string) => couldNotCheck(pageUrl, reason);
    // The browser's init has `cache`; Node's type for it does not, so the type adds it.
    const init: RequestInit & { cache: "no-store" } = {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      mode: "cors",
      signal: controller.signal,
    };
    const res = await send(target.href, init);
    // `redirect: "error"` already refuses one; this catches a stand-in or a browser that did not.
    if (
      res.redirected ||
      res.type === "opaqueredirect" ||
      (res.url !== "" && new URL(res.url).origin !== endpoint.origin)
    )
      return stop("The Function redirected the request, which the Studio does not follow.");
    if (res.status !== 200) return stop(`The gate answered ${res.status}.`);
    if (!JSON_TYPE.test(res.headers.get("content-type") ?? ""))
      return stop("The reply was not JSON.");
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) return stop("The reply was too large.");
    if (res.body === null) return stop("The reply had no body.");
    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return stop("The reply was too large.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return stop("The reply was not valid JSON.");
    }
    const parsed = parseGateAnswer(data, pageUrl);
    return parsed.ok ? parsed.answer : stop(parsed.reason);
  };

  try {
    return await Promise.race([run(), deadline]);
  } catch {
    return couldNotCheck(
      pageUrl,
      timedOut ? "The gate did not answer in time." : "The gate could not be reached.",
    );
  } finally {
    clearTimeout(timer);
    // Stop reading whatever is left, and never let a stalled body hold the Studio.
    void reader?.cancel().catch(() => undefined);
    controller.abort();
  }
}
