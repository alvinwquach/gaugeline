import { getPreferenceDeps } from "../../../lib/email/deps.js";
import { getPreferences, postPreferences } from "../../../lib/email/preferences.js";

// The database driver needs Node, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The reason is for the server's log; the person only learns that the page is not available. */
async function serve(
  run: (deps: Awaited<ReturnType<typeof getPreferenceDeps>>) => Promise<Response>,
): Promise<Response> {
  try {
    return await run(await getPreferenceDeps());
  } catch (e) {
    console.error("email preferences: not available:", e instanceof Error ? e.name : "error");
    return new Response("This page is not available.", {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
}

export const GET = (request: Request): Promise<Response> =>
  serve((deps) => getPreferences(request, deps));
export const POST = (request: Request): Promise<Response> =>
  serve((deps) => postPreferences(request, deps));
