import { serveWebhook } from "../../../../../lib/billing/serve.js";

// The database driver needs Node, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request): Promise<Response> => serveWebhook(request);
