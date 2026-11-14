import { getPendingDraft } from "../../../../../lib/api/agent-reads.js";
import { serve } from "../../../../../lib/api/routes.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  return serve((deps) => getPendingDraft(request, id, deps));
};
