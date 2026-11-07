// The free redirect tool's live check (docs/tools/redirects). The list arrives in the request
// body, is checked, and is gone: nothing is stored or logged. Requests go only to the typed domain.
import {
  createLimiter,
  handleCheckRedirects,
} from "../../packages/core/src/tools/check-redirects.ts";

/** Ten live checks a minute per visitor, in this instance; the platform's limit below is the main one. */
const limiter = createLimiter({ max: 10, windowMs: 60_000 });

export default async (req: Request, context: { ip?: string }) =>
  handleCheckRedirects(req, {
    limiter,
    visitor: context.ip ?? req.headers.get("x-nf-client-connection-ip") ?? "unknown",
  });

export const config = {
  path: "/api/check-redirects",
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
