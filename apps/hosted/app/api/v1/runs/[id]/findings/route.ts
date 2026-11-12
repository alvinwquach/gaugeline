import { getRunFindings } from "../../../../../../lib/api/handlers.js";
import { serve } from "../../../../../../lib/api/routes.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await context.params;
  return serve((deps) => getRunFindings(request, id, deps));
};
