/** What each Route Handler file calls: the route table with the app's dependencies, or a 503. */
import { getWebDeps } from "./deps.js";
import { respondText } from "./layout.js";
import { ROUTES, route } from "./routes.js";

export function handle(
  path: string,
  method: "GET" | "POST",
): (request: Request) => Promise<Response> {
  if (!ROUTES.some((x) => x.path === path && x.methods.includes(method)))
    throw new Error(`no route ${method} ${path} in the route table`);
  return async (request) => {
    try {
      return await route(request, await getWebDeps());
    } catch (e) {
      // The reason is for the server's log; the visitor only learns the service is not available.
      console.error("web: not available:", e instanceof Error ? e.message : "error");
      return respondText(503, "The service is not available.", "text/plain; charset=utf-8");
    }
  };
}
