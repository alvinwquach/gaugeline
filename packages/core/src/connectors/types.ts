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
  configured(env: Env): boolean;
  read(env: Env, fetcher: Fetcher): Promise<T[]>;
}

/**
 * Why a system gave no data. Never an error: the rest of the run goes on.
 * - not-configured: a variable is missing or empty, so nothing was requested.
 * - unreachable: it did not answer, answered with something unusable, or the read failed.
 * - refused: it answered, and said the key is not allowed to read this (401 or 403).
 */
export interface ConnectorNotice {
  connector: string;
  kind: "not-configured" | "unreachable" | "refused";
  message: string;
}

export interface ConnectorRun {
  /** Rows by connector id. A connector with no answer has no entry. */
  data: Map<string, unknown[]>;
  /** In connector order, so the same input always gives the same notices. */
  notices: ConnectorNotice[];
}
