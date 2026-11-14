import { getPendingDrafts } from "../../../../lib/api/agent-reads.js";
import { serve } from "../../../../lib/api/routes.js";

// The database driver needs Node, not the edge runtime. Read-only: there is no POST, PUT, PATCH or DELETE.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request): Promise<Response> =>
  serve((deps) => getPendingDrafts(request, deps));
