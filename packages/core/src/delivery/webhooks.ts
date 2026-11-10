/** An event is "undelivered" once it has been waiting this long (seconds). Proposed: the spec's 1 hour. */
export const STALE_AFTER_SECONDS = 60 * 60;
/** How far back Stripe keeps events. Uncited: Stripe's page was not reachable. Used to say what was read. */
export const STRIPE_EVENT_RETENTION_DAYS = 30;

/** A webhook endpoint as Stripe lists it, reduced to where it points (the host only) and what it takes. */
export interface RawEndpoint {
  host: string;
  status: "enabled" | "disabled";
  /** The event types it takes; "*" takes all. */
  events: readonly string[];
}

/** An event with a delivery still pending: its type and when it happened. Nothing from its payload. */
export interface PendingEvent {
  type: string;
  at: number;
}

/** What `gaugeline platform --webhooks` knows about one endpoint. Counts and a host. */
export interface WebhookEndpointState {
  host: string;
  enabled: boolean;
  /** Events older than an hour that this endpoint takes and that are still not delivered. */
  undelivered: number;
  /** Age in seconds of the oldest of them, or null when there are none. */
  oldestAgeSeconds: number | null;
}

const UNREADABLE = "(an address that could not be read)";

/**
 * The host of an endpoint's address and nothing else: a webhook address often carries a secret in
 * its path or query, and a login in front of the host. A port stays (it names the service).
 */
export function endpointHost(address: unknown): string {
  if (typeof address !== "string") return UNREADABLE;
  try {
    return new URL(address).host || UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

/** "1 hour", "47 hours", "6 days": a whole number of the largest unit, rounded down. */
export function formatAge(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/**
 * Stripe's event list does not say which endpoint an undelivered event is waiting for. An enabled
 * endpoint is given the events whose type it takes ("*" takes every type), so when two endpoints take
 * the same type each is told about the same event. A disabled endpoint is given none: Stripe sends it
 * nothing, and "disabled" is the finding. Events newer than STALE_AFTER_SECONDS are still being tried.
 */
export function attribute(
  endpoints: readonly RawEndpoint[],
  pending: readonly PendingEvent[],
  now: number,
): WebhookEndpointState[] {
  const stale = pending.filter((e) => (now - e.at) / 1000 > STALE_AFTER_SECONDS);
  return endpoints.map((endpoint) => {
    if (endpoint.status !== "enabled")
      return { host: endpoint.host, enabled: false, undelivered: 0, oldestAgeSeconds: null };
    const takes = new Set(endpoint.events);
    const mine = takes.has("*") ? stale : stale.filter((e) => takes.has(e.type));
    const oldest = mine.reduce<number | null>(
      (age, e) => Math.max(age ?? 0, Math.floor((now - e.at) / 1000)),
      null,
    );
    return {
      host: endpoint.host,
      enabled: true,
      undelivered: mine.length,
      oldestAgeSeconds: oldest,
    };
  });
}
