/** What each Route Handler file calls: the handler with the server's dependencies, or a 503. */
import { getDeps } from "./deps.js";
import type { ApiDeps } from "./handlers.js";
import { problem } from "./http.js";

export async function serve(run: (deps: ApiDeps) => Promise<Response>): Promise<Response> {
  let deps: ApiDeps;
  try {
    deps = await getDeps();
  } catch (e) {
    // The reason is for the server's log; the caller only learns that the service is not available.
    console.error("runs api: not started:", e instanceof Error ? e.message : "error");
    return problem(503, "not_configured", "The service is not available.");
  }
  return run(deps);
}
