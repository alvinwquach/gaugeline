/** What each Route Handler file calls: the handler with the server's dependencies, or a 503. */
import { getDeps } from "./deps.js";
import type { ApiDeps } from "./handlers.js";
import { problem } from "./http.js";

export async function serve(run: (deps: ApiDeps) => Promise<Response>): Promise<Response> {
  const deps = getDeps();
  return deps
    ? run(deps)
    : problem(503, "not_configured", "The service has no database configured.");
}
