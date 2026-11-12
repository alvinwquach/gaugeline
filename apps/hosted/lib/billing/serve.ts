/**
 * What the webhook's Route Handler file calls: the handler with the server's dependencies, or a 503.
 *
 *   GAUGELINE_BILLING_PROVIDER        `stand-in` is the only provider that exists. It also needs NODE_ENV to be
 *                                     exactly `development` or `test`: a production server never takes a stand-in.
 *   GAUGELINE_BILLING_WEBHOOK_SECRET  the signing secret (server-only), 32 characters or more. Several, comma
 *                                     separated, while one is being replaced.
 */
import { getDeps } from "../api/deps.js";
import { problem } from "../api/http.js";
import { BILLING } from "./config.js";
import { postWebhook, type WebhookDeps } from "./webhook.js";

export function billingEnv(env: Record<string, string | undefined>): string[] {
  if (env.GAUGELINE_BILLING_PROVIDER !== "stand-in")
    throw new Error(
      "GAUGELINE_BILLING_PROVIDER is not set to a configured provider (only `stand-in` exists).",
    );
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test")
    throw new Error("the stand-in payment provider is for development and tests only.");
  const secrets = (env.GAUGELINE_BILLING_WEBHOOK_SECRET ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0 || secrets.some((s) => s.length < 32))
    throw new Error("GAUGELINE_BILLING_WEBHOOK_SECRET must hold secrets of 32 characters or more.");
  return secrets;
}

export async function serveWebhook(request: Request): Promise<Response> {
  let deps: WebhookDeps;
  try {
    const secrets = billingEnv(process.env);
    const api = await getDeps();
    deps = {
      sql: api.sql,
      secrets,
      config: BILLING,
      now: () => new Date(),
      // Mail is the morning email's job (X64); until it exists the notice is only counted in the log.
      notify: async (effect) => void console.log(`billing: ${effect.kind} for one organisation`),
    };
  } catch (e) {
    // The reason is for the server's log; the caller only learns that the service is not available.
    console.error("billing webhook: not started:", e instanceof Error ? e.message : "error");
    return problem(503, "not_configured", "The service is not available.");
  }
  return postWebhook(request, deps);
}
