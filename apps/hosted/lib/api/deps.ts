/** The API's dependencies for a running server: one pooled connection, opened and checked once. */
import type { ApiDeps } from "./handlers.js";
import { openDatabase } from "./startup.js";

let shared: Promise<ApiDeps> | undefined;

/**
 * Opens the database on first use (or at start-up, from instrumentation.ts) and keeps the answer. A refusal
 * is kept too: a server whose login skips row-level security never serves a request.
 */
export function getDeps(): Promise<ApiDeps> {
  shared ??= openDatabase(process.env).then((sql) => ({ sql, env: process.env }));
  return shared;
}
