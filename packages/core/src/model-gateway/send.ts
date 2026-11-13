/**
 * The one module that sends a request to a model provider (AG-19 part 2; ADR-0005, amendment of 13 Nov 2026,
 * modes 1 and 2). It is not the fetcher and not notify/post.ts, and it is named by the lint rule and the
 * post-boundary test the way the writer's senders are named in ADR-0010. What it will and will not do:
 *
 * - It sends one POST, over https, to a host on PROVIDER_HOSTS and to the path that entry gives. A caller
 *   names a provider, never a host, a path or a scheme, and no setting can add one: a provider is added by
 *   a change to this list and to its test.
 * - It reads nothing from the environment. The key arrives in the call (the gateway read it just now) and
 *   goes into one header; it is never kept, logged, or put in a body, a message or an error.
 * - It sends only what the caller passed, at most MAX_PAYLOAD_BYTES, and refuses text that is a whole page.
 * - It never follows a redirect (a 3xx is an error), reads at most MAX_RESPONSE_BYTES, and refuses a name
 *   that resolves to a loopback, private, link-local, CGNAT or metadata address, at connect time, with the
 *   same rule the fetcher uses (../addresses.ts).
 * - It stops after HARD_TIMEOUT_MS whatever the config says, and when the gateway aborts it.
 * - It says what failed with the host, a status or an error code, never with the body or the provider's words.
 *
 * The request and response shapes are provider-neutral. There is no SDK, and no real provider is chosen: the
 * one entry is a documented example on a reserved name that never resolves. Choosing a real provider is the
 * owner's decision, made by adding an entry here.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { isBlockedAddress } from "../addresses.js";
import { ModelGatewayError } from "./errors.js";
import type { AdapterCall, ModelAdapter } from "./types.js";

/** One provider the module may reach. Exact host, https, one path. Prices are whole micro-units per million tokens. */
export interface ProviderHost {
  readonly provider: string;
  readonly host: string;
  readonly path: string;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
}

/**
 * The only hosts a model request can go to. `.test` is a reserved name that never resolves, so this entry
 * documents the shape and cannot reach anything. Request: POST JSON {model, prompt, max_output_tokens} with
 * `Authorization: Bearer <key>`. Answer: JSON {text, usage: {input_tokens, output_tokens}}.
 */
export const PROVIDER_HOSTS: readonly ProviderHost[] = Object.freeze([
  Object.freeze({
    provider: "example",
    host: "api.example.test",
    path: "/v1/complete",
    inputMicrosPerMillionTokens: 1_000_000,
    outputMicrosPerMillionTokens: 3_000_000,
  }),
]);

/** The most bytes of prompt one request may carry: findings, ids and snippets, a page is far larger. */
export const MAX_PAYLOAD_BYTES = 16_000;
/** The most bytes of answer read. */
export const MAX_RESPONSE_BYTES = 262_144;
/** The longest a request may take, whatever the config says. */
export const HARD_TIMEOUT_MS = 60_000;

/** A document's own elements: a snippet may quote one tag, a page has these. */
const WHOLE_PAGE = /<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>]/i;
/** Thrown inside a lookup when a name resolves to an address outside the public internet. */
const NOT_PUBLIC = "EGAUGELINENOTPUBLIC";

/** The part of a client request this module uses. node:https' request satisfies it. */
export interface RequestLike {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  end(data: Buffer): unknown;
  destroy(): unknown;
}
export type ResponseLike = Readable & { statusCode?: number };
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

/** A lookup that refuses any name that resolves to an address the fetcher would refuse, so the connection goes to a public one. */
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

/** Whole micro-units: tokens times the price per million, rounded up. */
function costMicros(entry: ProviderHost, inputTokens: number, outputTokens: number): number {
  const total =
    BigInt(inputTokens) * BigInt(entry.inputMicrosPerMillionTokens) +
    BigInt(outputTokens) * BigInt(entry.outputMicrosPerMillionTokens);
  return Number((total + 999_999n) / 1_000_000n);
}

const whole = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The gateway's answer shape from the neutral JSON, or null. */
function answerOf(entry: ProviderHost, raw: string, latencyMs: number): unknown {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text, usage } = body as { text?: unknown; usage?: Record<string, unknown> | null };
  if (typeof text !== "string" || usage === null || typeof usage !== "object") return null;
  const { input_tokens: i, output_tokens: o } = usage;
  if (!whole(i) || !whole(o)) return null;
  return {
    text,
    usage: {
      inputTokens: i,
      outputTokens: o,
      costMicros: costMicros(entry, i, o),
      latencyMs,
    },
  };
}

/**
 * The adapter for one provider on the allowlist. `request`, `resolve` and `now` exist so tests need no
 * network, no DNS and no clock; production passes none of them.
 */
export function createProviderAdapter(
  provider: string,
  options: { request?: RequestFn; resolve?: NameResolver; now?: () => number } = {},
): ModelAdapter {
  const entry = PROVIDER_HOSTS.find((e) => e.provider === provider);
  if (!entry)
    throw new ModelGatewayError(
      "unknown-provider",
      `There is no provider "${provider}" on the allowlist.`,
    );
  const send: RequestFn = options.request ?? (httpsRequest as unknown as RequestFn);
  const lookup = publicLookup(options.resolve ?? (dnsLookup as unknown as NameResolver));
  const now = options.now ?? (() => performance.now());
  const url = new URL(`https://${entry.host}${entry.path}`);

  return {
    provider,
    needsKey: true,
    complete(call: AdapterCall): Promise<unknown> {
      const { key } = call;
      if (key === undefined)
        return Promise.reject(
          new ModelGatewayError("missing-key", "No key was given to the sender."),
        );
      if (Buffer.byteLength(call.prompt, "utf8") > MAX_PAYLOAD_BYTES)
        return Promise.reject(
          new ModelGatewayError(
            "input-too-large",
            `The prompt is over ${MAX_PAYLOAD_BYTES} bytes; nothing was sent.`,
          ),
        );
      if (WHOLE_PAGE.test(call.prompt))
        return Promise.reject(
          new ModelGatewayError(
            "bad-request",
            "The prompt looks like a whole page; only findings, ids and snippets are sent.",
          ),
        );
      const data = Buffer.from(
        JSON.stringify({
          model: call.model,
          prompt: call.prompt,
          max_output_tokens: call.maxOutputTokens,
        }),
      );
      const started = now();
      return new Promise((resolve, reject) => {
        let settled = false;
        let req: RequestLike | undefined;
        const finish = (done: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          call.signal.removeEventListener("abort", onAbort);
          done();
        };
        const fail = (code: ModelGatewayError["code"], message: string) =>
          finish(() => {
            req?.destroy();
            reject(new ModelGatewayError(code, message));
          });
        function onAbort() {
          fail("timeout", `${entry!.host} did not answer in time.`);
        }
        const timer = setTimeout(
          () =>
            fail(
              "timeout",
              `${entry.host} did not answer within ${HARD_TIMEOUT_MS / 1000} seconds.`,
            ),
          HARD_TIMEOUT_MS,
        );
        if (call.signal.aborted) return onAbort();
        call.signal.addEventListener("abort", onAbort, { once: true });
        try {
          req = send(
            url,
            {
              method: "POST",
              lookup: lookup as unknown as RequestOptions["lookup"],
              headers: {
                accept: "application/json",
                authorization: `Bearer ${key.reveal()}`,
                "content-length": String(data.length),
                "content-type": "application/json",
                "user-agent": "Gaugeline (model call)",
              },
            },
            (res) => {
              const status = res.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                res.destroy();
                return fail(
                  "provider-error",
                  `${entry.host} answered a redirect, which is not followed.`,
                );
              }
              if (status < 200 || status >= 300) {
                res.destroy();
                return fail("provider-error", `${entry.host} answered ${status}.`);
              }
              const chunks: Buffer[] = [];
              let size = 0;
              res.on("data", (c: Buffer) => {
                size += c.length;
                if (size > MAX_RESPONSE_BYTES) {
                  res.destroy();
                  return fail("bad-answer", `The answer from ${entry.host} is too long.`);
                }
                chunks.push(c);
              });
              res.on("end", () => {
                const answer = answerOf(
                  entry,
                  Buffer.concat(chunks).toString("utf8"),
                  Math.max(0, Math.round(now() - started)),
                );
                if (answer === null)
                  return fail(
                    "bad-answer",
                    `The answer from ${entry.host} is not in the expected shape.`,
                  );
                finish(() => resolve(answer));
              });
              res.on("error", () =>
                fail("provider-error", `${entry.host} ended the answer early.`),
              );
            },
          );
          // Never the raw error: it can carry the address or the request.
          req.on("error", (err) =>
            fail(
              "provider-error",
              err.code === NOT_PUBLIC
                ? `${entry.host} is not a public address: nothing was sent`
                : `${entry.host} could not be reached (${err.code ?? "error"})`,
            ),
          );
          req.end(data);
        } catch {
          fail("provider-error", `${entry.host} could not be reached.`);
        }
      });
    },
  };
}
