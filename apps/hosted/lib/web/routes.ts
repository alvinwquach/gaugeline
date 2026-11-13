/**
 * The route table. Each entry is also a Next.js App Router Route Handler file under app/ (a test keeps the
 * two lists equal); the table lets a plain Node server (server/node.ts) serve the same handlers for
 * development and the end-to-end tests.
 */
import {
  agentsPage,
  home,
  lastNightPage,
  postOrg,
  postSignIn,
  postSignOut,
  postVerify,
  signInPage,
  stylesheet,
  verifyPage,
} from "./handlers.js";
import { clientUpdatePage, clientsPage } from "./clients.js";
import type { WebDeps } from "./deps.js";
import { respondText, withHsts } from "./layout.js";

type Handler = (request: Request, deps: WebDeps) => Response | Promise<Response>;

export interface Route {
  path: string;
  handlers: Partial<Record<"GET" | "POST", Handler>>;
  methods: ("GET" | "POST")[];
}

const r = (path: string, handlers: Route["handlers"]): Route => ({
  path,
  handlers,
  methods: Object.keys(handlers) as Route["methods"],
});

export const ROUTES: Route[] = [
  r("/", { GET: home }),
  r("/last-night", { GET: lastNightPage }),
  r("/agents", { GET: agentsPage }),
  r("/clients", { GET: clientsPage }),
  r("/clients/update", { GET: clientUpdatePage }),
  r("/sign-in", { GET: signInPage, POST: postSignIn }),
  r("/sign-in/verify", { GET: verifyPage, POST: postVerify }),
  r("/sign-out", { POST: postSignOut }),
  r("/org", { POST: postOrg }),
  r("/assets/app.css", { GET: stylesheet }),
];

export async function route(request: Request, deps: WebDeps): Promise<Response> {
  const path = new URL(request.url).pathname;
  const match = ROUTES.find((x) => x.path === path);
  if (!match) return respondText(404, "Not found", "text/plain; charset=utf-8");
  const handler = match.handlers[request.method as "GET" | "POST"];
  if (!handler)
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: match.methods.join(", ") },
    });
  return withHsts(await handler(request, deps), request, deps.secureCookies);
}
