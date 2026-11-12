/** The API's dependencies for a running server: one pooled connection from GAUGELINE_DATABASE_URL. */
import postgres from "postgres";
import type { ApiDeps } from "./handlers.js";

let shared: ApiDeps | undefined;

/** Undefined when the server has no database configured: the route answers 503 rather than throwing. */
export function getDeps(): ApiDeps | undefined {
  const url = process.env.GAUGELINE_DATABASE_URL;
  if (!url) return undefined;
  shared ??= { sql: postgres(url, { max: 10, onnotice: () => {} }), env: process.env };
  return shared;
}
