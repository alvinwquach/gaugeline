/**
 * What can go wrong with a model call, as a closed list. A message is built from fixed words, an id or an
 * environment variable's NAME, passed through `scrub` first: it never holds a key, the provider's own words
 * unscrubbed, or anything from a page.
 */
import { scrub } from "./key.js";

export const GATEWAY_ERROR_CODES = [
  "bad-config",
  "unknown-provider",
  "unknown-tier",
  "tier-not-configured",
  "bad-request",
  "input-refused",
  "input-too-large",
  "missing-key",
  "bad-key",
  "key-in-prompt",
  "budget",
  "timeout",
  "provider-error",
  "bad-answer",
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/**
 * What a failure IS, as the thrower knows it, never as its words say. Only `outage` (a timeout, a lost
 * connection, a 5xx) may be tried on a second provider: every other class would meet the same problem there,
 * or is the person's own key, limit or request.
 */
export const FAILURE_CLASSES = [
  "outage",
  "rate-limited",
  "refused",
  "bad-key",
  "bad-request",
  "blocked-address",
  "redirect",
  "not-json",
  "bad-answer",
  "unclassified",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** The class of an error whose thrower named none: a timeout is an outage, a bad answer is a bad answer, nothing else is. */
const defaultFailure = (code: GatewayErrorCode): FailureClass =>
  code === "timeout" ? "outage" : code === "bad-answer" ? "bad-answer" : "unclassified";

export class ModelGatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly failure: FailureClass;
  /** The message is scrubbed here, so no throw site can forget to. There is never a `cause`. */
  constructor(
    code: GatewayErrorCode,
    message: string,
    secrets: readonly string[] = [],
    failure?: FailureClass,
  ) {
    super(scrub(message, secrets));
    this.name = "ModelGatewayError";
    this.code = code;
    this.failure = failure ?? defaultFailure(code);
  }
}
