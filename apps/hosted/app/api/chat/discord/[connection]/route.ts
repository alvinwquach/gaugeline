import { getDiscordDeps } from "../../../../../chat/deps.js";
import { discordInteraction } from "../../../../../chat/discord.js";

// The database driver needs Node, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discord's interactions endpoint. The reason for a 503 is for the server's log only. */
export const POST = async (
  request: Request,
  context: { params: Promise<{ connection: string }> },
): Promise<Response> => {
  const { connection } = await context.params;
  try {
    return await discordInteraction(request, connection, await getDiscordDeps());
  } catch (e) {
    console.error("chat: discord endpoint not available:", e instanceof Error ? e.name : "error");
    return new Response("This endpoint is not available.", {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
};
