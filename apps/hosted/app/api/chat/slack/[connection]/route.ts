import { getSlackDeps } from "../../../../../chat/deps.js";
import { slackInteraction } from "../../../../../chat/slack.js";

// The database driver needs Node, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Slack's interactivity request address. The reason for a 503 is for the server's log only. */
export const POST = async (
  request: Request,
  context: { params: Promise<{ connection: string }> },
): Promise<Response> => {
  const { connection } = await context.params;
  try {
    return await slackInteraction(request, connection, await getSlackDeps());
  } catch (e) {
    console.error("chat: slack endpoint not available:", e instanceof Error ? e.name : "error");
    return new Response("This endpoint is not available.", {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
};
