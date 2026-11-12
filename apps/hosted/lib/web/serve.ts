/** What each Route Handler file calls: the handler with the app's dependencies, or a 503. */
import { getWebDeps } from "./deps.js";
import type { Route } from "./routes.js";
import { ROUTES } from "./routes.js";
import { respondText } from "./layout.js";

export function handle(
  path: string,
  method: "GET" | "POST",
): (request: Request) => Promise<Response> {
  const entry = ROUTES.find((x) => x.path === path) as Route;
  return async (request) => {
    try {
      return await entry.handlers[method]!(request, await getWebDeps());
    } catch (e) {
      // The reason is for the server's log; the visitor only learns the service is not available.
      console.error("web: not available:", e instanceof Error ? e.message : "error");
      return respondText(503, "The service is not available.", "text/plain; charset=utf-8");
    }
  };
}
