import type { Fetcher } from "../fetcher.js";

/**
 * The variables a run was started with, handed to core by the CLI as a frozen copy. Core never
 * reads process state; a plain record is also trivial to fake in a test.
 */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * One system behind the page (the website's content, checkout, fulfilment). A connector only ever
 * reads: its requests are GET through the fetcher, with the key in a per-request Authorization
 * header, and its keys come from `envVars` and nowhere else.
 */
export interface Connector<T> {
  /** Stable name: the key of its entry in the result and the name in every notice. */
  id: string;
  /** Every environment variable this connector needs. It is configured when all are non-empty. */
  envVars: string[];
  /** Variables read when set but never required (a token a public dataset does not need, a setting). */
  optionalEnvVars?: string[];
  /**
   * Which variables hold keys, so the redactor blanks only those. Defaults to `envVars`; a connector
   * with plain settings among its variables (a dataset name, a unit) lists just its keys here.
   */
  secretEnvVars?: string[];
  configured(env: Env): boolean;
  /**
   * `note` adds a plain-language "advice" notice from inside the read (a page cap that was hit, a
   * key that works but should be swapped). It is optional to call and optional to accept.
   */
  read(env: Env, fetcher: Fetcher, note?: (message: string) => void): Promise<T[]>;
  /**
   * Plain-language advice the runner adds as "advice" notices after the read, whether it worked or
   * not (an assumed default, a key with more power than it needs). It may make GET requests; if it
   * throws, there is no advice and nothing else changes.
   */
  advise?(env: Env, fetcher: Fetcher): Promise<string[]>;
}

/**
 * Why a system gave no data. Never an error: the rest of the run goes on.
 * - not-configured: a variable is missing or empty, so nothing was requested.
 * - unreachable: it did not answer, answered with something unusable, or the read failed.
 * - refused: it answered, and said the key is not allowed to read this (401 or 403).
 * - advice: the read may have worked; this is something worth changing (never a failure).
 */
export interface ConnectorNotice {
  connector: string;
  kind: "not-configured" | "unreachable" | "refused" | "advice";
  message: string;
}

export interface ConnectorRun {
  /** Rows by connector id. A connector with no answer has no entry. */
  data: Map<string, unknown[]>;
  /** In connector order, so the same input always gives the same notices. */
  notices: ConnectorNotice[];
}
