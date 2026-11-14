import { handle } from "../../lib/web/serve.js";

// The database driver needs Node, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle("/last-night", "GET");
