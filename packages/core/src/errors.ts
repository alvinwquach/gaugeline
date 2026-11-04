export interface ErrorOptions {
  hint?: string;
  cause?: unknown;
}

/**
 * Base of Gaugeline's own errors. Never thrown directly. `code` is kept as a fallback discriminator
 * because instanceof fails across two copies of the core package.
 */
export class GaugelineError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

/** The check had nothing to check. Exit code 2. */
export class CouldNotRunError extends GaugelineError {
  constructor(message: string, options: ErrorOptions = {}, code = "could-not-run") {
    super(code, message, options);
  }
}

/** Bad address, bad flag, missing file, missing environment variable. */
export class ConfigError extends CouldNotRunError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options, "config");
  }
}

/** DNS, refused, timeout, TLS. */
export class NetworkError extends CouldNotRunError {
  readonly url: string;
  constructor(message: string, options: ErrorOptions & { url: string }) {
    super(message, options, "network");
    this.url = options.url;
  }
}

const OWN_CODES = new Set(["could-not-run", "config", "network"]);

export function isGaugelineError(err: unknown): err is GaugelineError {
  if (err instanceof GaugelineError) return true;
  const code: unknown =
    err instanceof Error ? (err as unknown as { code?: unknown }).code : undefined;
  return typeof code === "string" && OWN_CODES.has(code);
}

/** Low-level error codes anywhere in a cause chain, including AggregateError members. */
export function errorCodes(err: unknown, depth = 0): string[] {
  if (depth > 5 || err === null || typeof err !== "object") return [];
  const codes: string[] = [];
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") codes.push(code);
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) for (const e of errors) codes.push(...errorCodes(e, depth + 1));
  codes.push(...errorCodes((err as { cause?: unknown }).cause, depth + 1));
  return codes;
}
