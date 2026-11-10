// check-community: allow-email (invented addresses at reserved example domains, inside the stand-in for Stripe's responses)
import { describe, expect, it } from "vitest";
import {
  providerTransport,
  type FakeProviders,
  type SeenRequest,
} from "../../../../testkit/src/index.js";
import { createStripeWebhooksConnector } from "../../connectors/stripe-webhooks.js";
import { runConnectors } from "../../connectors/run.js";
import { createFetcher } from "../../fetcher.js";
import {
  STALE_AFTER_SECONDS,
  attribute,
  endpointHost,
  formatAge,
  type PendingEvent,
  type RawEndpoint,
} from "../webhooks.js";

const RK = ["rk", "live", "Tideline0123456789abcdef"].join("_");
const NOW = new Date("2026-11-10T12:00:00Z");
const ago = (seconds: number) => NOW.getTime() - seconds * 1000;
const DAY = 24 * 60 * 60;

const hooks = (extra: Partial<RawEndpoint> = {}): RawEndpoint => ({
  host: "hooks.tideline.example",
  status: "enabled",
  events: ["*"],
  ...extra,
});
const pending = (type: string, secondsAgo: number): PendingEvent => ({
  type,
  at: ago(secondsAgo),
});

describe("attribute: unit", () => {
  it("14 pending events, the oldest six days old: a count and the oldest age", () => {
    const events = Array.from({ length: 14 }, (_, i) =>
      pending("checkout.session.completed", 6 * DAY - i * 3600),
    );
    expect(attribute([hooks()], events, NOW.getTime())).toEqual([
      { host: "hooks.tideline.example", enabled: true, undelivered: 14, oldestAgeSeconds: 6 * DAY },
    ]);
  });

  it("an event younger than an hour is still being tried, and is not counted", () => {
    const events = [
      pending("charge.succeeded", STALE_AFTER_SECONDS - 1),
      pending("charge.succeeded", STALE_AFTER_SECONDS),
      pending("charge.succeeded", STALE_AFTER_SECONDS + 1),
    ];
    const [state] = attribute([hooks()], events, NOW.getTime());
    expect(state).toMatchObject({ undelivered: 1, oldestAgeSeconds: STALE_AFTER_SECONDS + 1 });
  });

  it("an endpoint only counts the types it takes; * takes all", () => {
    const events = [pending("charge.succeeded", DAY), pending("invoice.paid", DAY)];
    const states = attribute(
      [
        hooks({ host: "orders.tideline.example", events: ["charge.succeeded"] }),
        hooks({ host: "all.tideline.example" }),
        hooks({ host: "none.tideline.example", events: ["customer.created"] }),
      ],
      events,
      NOW.getTime(),
    );
    expect(states.map((s) => [s.host, s.undelivered])).toEqual([
      ["orders.tideline.example", 1],
      ["all.tideline.example", 2],
      ["none.tideline.example", 0],
    ]);
  });

  it("a disabled endpoint is not given a count: Stripe sends it nothing", () => {
    const [state] = attribute(
      [hooks({ status: "disabled" })],
      [pending("charge.succeeded", DAY)],
      NOW.getTime(),
    );
    expect(state).toEqual({
      host: "hooks.tideline.example",
      enabled: false,
      undelivered: 0,
      oldestAgeSeconds: null,
    });
  });

  it("no pending events: zero and no age", () => {
    expect(attribute([hooks()], [], NOW.getTime())[0]).toMatchObject({
      undelivered: 0,
      oldestAgeSeconds: null,
    });
  });
});

describe("endpointHost and formatAge: unit", () => {
  it("only the host leaves: the path, the query and a login are dropped", () => {
    expect(endpointHost("https://user:pw@hooks.tideline.example/stripe/whsec_path?token=abc")).toBe(
      "hooks.tideline.example",
    );
    expect(endpointHost("https://hooks.tideline.example:8443/x")).toBe(
      "hooks.tideline.example:8443",
    );
    expect(endpointHost("not an address")).toBe("(an address that could not be read)");
  });

  it.each([
    [3601, "1 hour"],
    [2 * 3600, "2 hours"],
    [47 * 3600, "47 hours"],
    [2 * DAY, "2 days"],
    [6 * DAY + 5, "6 days"],
  ])("%i seconds is %s", (seconds, text) => {
    expect(formatAge(seconds)).toBe(text);
  });
});

function fetcherFor(spec: FakeProviders, seen: SeenRequest[] = []) {
  return createFetcher({ transport: providerTransport(spec, seen), timeoutMs: 5000 });
}
const env = { STRIPE_API_KEY: RK };
const make = (extra = {}) =>
  createStripeWebhooksConnector({ now: NOW, sleep: () => Promise.resolve(), ...extra });

describe("stripe-webhooks: integration (recorded-style responses, no live keys)", () => {
  const events = Array.from({ length: 14 }, (_, i) => ({
    type: "checkout.session.completed",
    at: new Date(ago(6 * DAY - i * 3600)).toISOString(),
    pending: 1,
  }));

  it("reads endpoints and the undelivered events, and gives one state per endpoint", async () => {
    const rows = await make().read(
      env,
      fetcherFor({
        endpoints: [
          { url: "https://hooks.tideline.example/stripe?secret=abc" },
          { url: "https://old.tideline.example/hook", status: "disabled" },
        ],
        events,
      }),
    );
    expect(rows).toEqual([
      { host: "hooks.tideline.example", enabled: true, undelivered: 14, oldestAgeSeconds: 6 * DAY },
      { host: "old.tideline.example", enabled: false, undelivered: 0, oldestAgeSeconds: null },
    ]);
  });

  it("asks Stripe for undelivered events only, inside the 30 days Stripe keeps, GET only", async () => {
    const seen: SeenRequest[] = [];
    await make().read(
      env,
      fetcherFor({ endpoints: [{ url: "https://hooks.tideline.example/x" }], events }, seen),
    );
    const eventsUrl = seen.map((s) => new URL(s.url)).find((u) => u.pathname === "/v1/events");
    expect(eventsUrl?.searchParams.get("delivery_success")).toBe("false");
    expect(eventsUrl?.searchParams.get("created[gte]")).toBe(String(ago(30 * DAY) / 1000));
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen.map((s) => new URL(s.url).pathname).sort()).toEqual([
      "/v1/events",
      "/v1/webhook_endpoints",
    ]);
    for (const s of seen) expect(s.url).not.toContain(RK);
  });

  it("follows the cursor across pages", async () => {
    const seen: SeenRequest[] = [];
    const many = Array.from({ length: 250 }, (_, i) => ({
      type: "charge.succeeded",
      at: new Date(ago(2 * 3600 + i)).toISOString(),
      pending: 2,
    }));
    const [row] = await make().read(
      env,
      fetcherFor(
        { endpoints: [{ url: "https://hooks.tideline.example/x" }], events: many, pageSize: 100 },
        seen,
      ),
    );
    expect(row?.undelivered).toBe(250);
    expect(seen.filter((s) => s.url.includes("/v1/events"))).toHaveLength(3);
  });

  it("states the window it read, through onReadable", async () => {
    let from: Date | undefined;
    await make({ onReadable: (d: Date) => (from = d) }).read(env, fetcherFor({}));
    expect(from?.toISOString()).toBe(new Date(ago(30 * DAY)).toISOString());
  });

  it("a key that cannot read says which permissions to set", async () => {
    const out = await runConnectors([make()], env, fetcherFor({ stripeStatus: 403 }));
    expect(out.notices[0]).toMatchObject({ connector: "stripe-webhooks", kind: "refused" });
    expect(out.notices[0]?.message).toMatch(/Webhook Endpoints/);
    expect(out.notices[0]?.message).toMatch(/Events/);
    expect(out.notices[0]?.message).not.toContain(RK);
  });
});
