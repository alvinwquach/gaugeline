import { getRuns, postRun } from "../../../../lib/api/handlers.js";
import { serve } from "../../../../lib/api/routes.js";

// The database driver needs Node, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request): Promise<Response> =>
  serve((deps) => postRun(request, deps));
export const GET = (request: Request): Promise<Response> => serve((deps) => getRuns(request, deps));
