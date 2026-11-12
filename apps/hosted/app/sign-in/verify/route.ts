import { handle } from "../../../lib/web/serve.js";

// The database driver needs Node, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle("/sign-in/verify", "GET");
export const POST = handle("/sign-in/verify", "POST");
