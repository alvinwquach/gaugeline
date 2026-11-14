import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import {
  STRIPE_EVENT_RETENTION_DAYS,
  attribute,
  endpointHost,
  type PendingEvent,
  type RawEndpoint,
  type WebhookEndpointState,
} from "../delivery/webhooks.js";
import { isConfigured } from "./env.js";
import { getJson, isRecord } from "./get-json.js";
import { ConnectorRateLimitedError, ConnectorRefusedError } from "./http.js";
import { createRedactor } from "./redact.js";
import { STRIPE_API_KEY, STRIPE_MAX_PAGES, STRIPE_PAGE_SIZE, guardStripeKey } from "./stripe.js";
import type { Connector } from "./types.js";

const API = "https://api.stripe.com/v1";

/** What the restricted key reads. */
export const STRIPE_WEBHOOKS_NEEDS = "Webhook Endpoints and Events";

export interface StripeWebhooksOptions {
  /** The run's clock: the events are asked for from 30 days before it, and their age is measured to it. */
  now: Date;
  allowSecretKey?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Told where the events read start. */
  onReadable?: (from: Date) => void;
  maxPages?: number;
}

function refusal(err: ConnectorRefusedError): ConnectorRefusedError {
  return new ConnectorRefusedError(
    err.status,
    err.status === 401
      ? `Stripe did not accept ${STRIPE_API_KEY}. Check it is a restricted key from the right Stripe account.`
      : `${STRIPE_API_KEY} cannot read ${STRIPE_WEBHOOKS_NEEDS}. In Stripe, edit the restricted key and set Webhook Endpoints and Events to Read; nothing else is needed.`,
  );
}

/**
 * Stripe as a source of webhook delivery state ("stripe-webhooks"). Read only: GETs of the webhook
 * endpoints list and of the events list filtered to deliveries that are not successful
 * (`delivery_success=false`), from 30 days back, 100 a page, following `starting_after`, at most
 * STRIPE_MAX_PAGES pages each. One row per endpoint: its host, whether it is enabled, how many old
 * events are waiting for it and the age of the oldest. Nothing from an event's payload, an endpoint's
 * path or its signing secret is read into a row.
 */
export function createStripeWebhooksConnector(
  options: StripeWebhooksOptions,
): Connector<WebhookEndpointState> {
  const maxPages = options.maxPages ?? STRIPE_MAX_PAGES;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const from = new Date(options.now.getTime() - STRIPE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return {
    id: "stripe-webhooks",
    envVars: [STRIPE_API_KEY],
    secretEnvVars: [STRIPE_API_KEY],
    configured: (env) => isConfigured(env, [STRIPE_API_KEY]),
    async read(env, fetcher: Fetcher, note = () => undefined) {
      try {
        for (const n of guardStripeKey(env, {
          allowSecretKey: options.allowSecretKey === true,
          needs: STRIPE_WEBHOOKS_NEEDS,
          steps: "docs/delivery",
        }))
          note(n);
        const source = {
          fetcher,
          request: { authorization: `Bearer ${(env[STRIPE_API_KEY] ?? "").trim()}` },
          sleep,
          system: "Stripe",
        };
        /** Every row of one list, following the cursor; a cap that cuts it short is noted. */
        const list = async (path: string, query: string, what: string): Promise<unknown[]> => {
          const rows: unknown[] = [];
          let cursor: string | undefined;
          for (let page = 1; page <= maxPages; page++) {
            const url = `${API}/${path}?limit=${STRIPE_PAGE_SIZE}${query}${cursor === undefined ? "" : `&starting_after=${encodeURIComponent(cursor)}`}`;
            let body: unknown;
            try {
              body = (await getJson(source, url)).body;
            } catch (err) {
              if (err instanceof ConnectorRefusedError) throw refusal(err);
              throw err;
            }
            if (!isRecord(body) || !Array.isArray(body.data) || typeof body.has_more !== "boolean")
              throw new Error(`Stripe answered with something that is not a list of ${what}.`);
            const data: unknown[] = body.data;
            const last = data.at(-1);
            const lastId = isRecord(last) && typeof last.id === "string" ? last.id : null;
            if (data.length > 0 && lastId === null)
              throw new Error(`Stripe answered with an item of ${what} that has no id.`);
            if (lastId !== null && lastId === cursor) return rows;
            rows.push(...data);
            if (!body.has_more || lastId === null) return rows;
            cursor = lastId;
          }
          note(
            `Stripe has more ${what} than Gaugeline reads in one run: it read the first ${rows.length} and left the rest out.`,
          );
          return rows;
        };
        const rawEndpoints = await list("webhook_endpoints", "", "webhook endpoints");
        const rawEvents = await list(
          "events",
          `&delivery_success=false&created%5Bgte%5D=${Math.floor(from.getTime() / 1000)}`,
          "events",
        );
        options.onReadable?.(from);
        const endpoints: RawEndpoint[] = rawEndpoints.flatMap((raw) => {
          if (!isRecord(raw)) return [];
          const events = Array.isArray(raw.enabled_events)
            ? raw.enabled_events.filter((e): e is string => typeof e === "string")
            : ["*"];
          return [
            {
              host: endpointHost(raw.url),
              status: raw.status === "disabled" ? ("disabled" as const) : ("enabled" as const),
              events,
            },
          ];
        });
        const pending: PendingEvent[] = rawEvents.flatMap((raw) => {
          if (!isRecord(raw) || typeof raw.type !== "string") return [];
          // A listed event whose pending count is zero has nothing left to deliver.
          if (typeof raw.pending_webhooks === "number" && raw.pending_webhooks <= 0) return [];
          return typeof raw.created === "number"
            ? [{ type: raw.type, at: raw.created * 1000 }]
            : [];
        });
        return attribute(endpoints, pending, options.now.getTime());
      } catch (err) {
        if (
          err instanceof ConfigError ||
          err instanceof ConnectorRefusedError ||
          err instanceof ConnectorRateLimitedError
        )
          throw err;
        const text = err instanceof Error ? err.message : String(err);
        throw new Error(createRedactor(env, [STRIPE_API_KEY])(text));
      }
    },
  };
}
