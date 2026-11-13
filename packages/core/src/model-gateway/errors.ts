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

export class ModelGatewayError extends Error {
  readonly code: GatewayErrorCode;
  /** The message is scrubbed here, so no throw site can forget to. There is never a `cause`. */
  constructor(code: GatewayErrorCode, message: string, secrets: readonly string[] = []) {
    super(scrub(message, secrets));
    this.name = "ModelGatewayError";
    this.code = code;
  }
}
