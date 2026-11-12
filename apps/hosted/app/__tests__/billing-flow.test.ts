/**
 * Billing end to end against a real Postgres, with the local stand-in playing the payment provider: it posts
 * signed webhooks to the real handler. Subscribe, add sites up to the limit, change plan, cancel: the plan
 * changes each time. Skipped without GAUGELINE_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  type Sql,
  type TestDatabase,
} from "../../db/__tests__/harness.js";
import { withService } from "../../lib/api/db.js";
import { StandInProvider, type Delivery } from "../../lib/billing/provider.js";
import { billingEnv } from "../../lib/billing/serve.js";
import type { Effect } from "../../lib/billing/state.js";
import { checkSiteLimit, getSubscription } from "../../lib/billing/store.js";
import { postWebhook, type WebhookDeps } from "../../lib/billing/webhook.js";
import { appLogin } from "../api/__tests__/app-login.js";
import { TEST_CONFIG, T0 } from "./billing-fixtures.js";

const SECRET = "test-webhook-secret-not-real-0123456789abcdef";

describe("billingEnv: the stand-in is for development and tests", () => {
  const ok = {
    GAUGELINE_BILLING_PROVIDER: "stand-in",
    NODE_ENV: "test",
    GAUGELINE_BILLING_WEBHOOK_SECRET: SECRET,
  };
  it("takes one secret or several", () => {
    expect(billingEnv(ok)).toEqual([SECRET]);
    expect(
      billingEnv({ ...ok, GAUGELINE_BILLING_WEBHOOK_SECRET: `${SECRET}, ${SECRET}x` }),
    ).toHaveLength(2);
  });
  it("refuses production, an unknown provider, and a short or missing secret", () => {
    expect(() => billingEnv({ ...ok, NODE_ENV: "production" })).toThrow(
      /development and tests only/,
    );
    expect(() => billingEnv({ ...ok, NODE_ENV: undefined })).toThrow(/development and tests only/);
    expect(() => billingEnv({ ...ok, GAUGELINE_BILLING_PROVIDER: "other" })).toThrow(
      /not set to a configured/,
    );
    expect(() => billingEnv({ ...ok, GAUGELINE_BILLING_WEBHOOK_SECRET: "short" })).toThrow(
      /32 characters/,
    );
    expect(() => billingEnv({ ...ok, GAUGELINE_BILLING_WEBHOOK_SECRET: undefined })).toThrow(
      /32 characters/,
    );
  });
});

describe.skipIf(!HAS_DATABASE)("billing: subscribe, add sites, change plan, cancel", () => {
  let db: TestDatabase;
  let sql: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  let provider: StandInProvider;
  const notices: Effect[] = [];
  const statuses: string[] = [];
  const clock = { t: T0 };

  const deps = (): WebhookDeps => ({
    sql: app.sql,
    secrets: [SECRET],
    config: TEST_CONFIG,
    now: () => clock.t,
    notify: async (e) => void notices.push(e),
  });
  const post = async (d: Delivery) => {
    const res = await postWebhook(
      new Request("https://hosted.example/api/v1/billing/webhook", {
        method: "POST",
        headers: d.headers,
        body: d.body,
      }),
      deps(),
    );
    const out = (await res.json()) as { status?: string; code?: string };
    statuses.push(out.status ?? out.code ?? String(res.status));
    return res;
  };
  const plan = async (orgId = ORG_A) =>
    (await withService(app.sql, (tx) => getSubscription(tx, orgId)))?.planId;
  const canAdd = async () =>
    (await withService(app.sql, (tx) => checkSiteLimit(tx, ORG_A, TEST_CONFIG, clock.t))).allowed;

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
    app = await appLogin(sql);
    provider = new StandInProvider({ secret: SECRET, now: () => clock.t, deliver: post });
  });
  afterAll(async () => {
    await app?.drop();
    await db?.drop();
  });

  it("walks through a team's whole life, and the plan changes each time", async () => {
    expect(await plan()).toBeUndefined();
    const checkout = await provider.createCheckout({
      orgId: ORG_A,
      planId: "small",
      interval: "month",
    });
    expect(checkout.url).toMatch(/^\/billing\/stand-in\/checkout\/sa_cs_/);
    const subscriptionId = await provider.completeCheckout(checkout.id);
    expect(await plan()).toBe("small");
    // Northgate has two sites and "small" includes two: the third is refused with a plain message.
    expect(await canAdd()).toBe(false);

    clock.t = new Date(clock.t.getTime() + 60_000);
    await provider.changePlan(subscriptionId, "large", "year");
    expect(await plan()).toBe("large");
    expect(await canAdd()).toBe(true);
    await sql`insert into public.sites (org_id, name, url) values (${ORG_A}, 'Third', 'https://third.example.test')`;

    clock.t = new Date(clock.t.getTime() + 60_000);
    await provider.cancelSubscription({ subscriptionId });
    expect((await withService(app.sql, (tx) => getSubscription(tx, ORG_A)))?.status).toBe(
      "canceled",
    );
    expect(await canAdd()).toBe(false);
    // Cancelling removed nothing: the sites are still there to be checked.
    expect(
      (await sql`select count(*)::int as n from public.sites where org_id = ${ORG_A}`)[0]!.n,
    ).toBe(3);
    expect(await plan(ORG_B)).toBeUndefined();
  });

  it("the same recorded webhook twice changes nothing", async () => {
    const before = await withService(app.sql, (tx) => getSubscription(tx, ORG_A));
    const sent = provider.last!;
    const again = await post(sent);
    expect(again.status).toBe(200);
    expect(statuses.at(-1)).toBe("duplicate");
    expect(await withService(app.sql, (tx) => getSubscription(tx, ORG_A))).toEqual(before);
  });

  it("a failed payment gives a grace period and exactly one notice, however often it is delivered", async () => {
    await sql.unsafe("truncate public.subscriptions");
    notices.length = 0;
    clock.t = new Date(clock.t.getTime() + 60_000);
    const checkout = await provider.createCheckout({
      orgId: ORG_A,
      planId: "large",
      interval: "month",
    });
    const id = await provider.completeCheckout(checkout.id);
    clock.t = new Date(clock.t.getTime() + 1000);
    await provider.failPayment(id);
    await post(provider.last!);
    await post(provider.last!);
    expect(notices).toHaveLength(1);
    const s = await withService(app.sql, (tx) => getSubscription(tx, ORG_A));
    expect(s?.status).toBe("past_due");
    expect(s?.graceEndsAt?.getTime()).toBe(clock.t.getTime() + 7 * 86_400_000);
    expect(await canAdd()).toBe(true); // still in the grace period
    clock.t = new Date(clock.t.getTime() + 8 * 86_400_000);
    // The delivery's signature is checked against `now`, so the stand-in's clock moves with it.
    expect(await canAdd()).toBe(false); // the grace period is over
    await provider.succeedPayment(id);
    expect(await canAdd()).toBe(true);
  });

  it("a payment event for a subscription not seen yet is asked to come back (409), and then it is applied", async () => {
    await sql.unsafe("truncate public.subscriptions");
    const other = new StandInProvider({
      secret: SECRET,
      now: () => clock.t,
      deliver: async () => {},
    });
    const checkout = await other.createCheckout({
      orgId: ORG_A,
      planId: "small",
      interval: "month",
    });
    const id = await other.completeCheckout(checkout.id);
    const created = other.last!;
    await other.failPayment(id);
    const early = await post(other.last!);
    expect(early.status).toBe(409);
    expect(early.headers.get("retry-after")).toBe("30");
    expect((await post(created)).status).toBe(200);
    expect((await post(other.last!)).status).toBe(200);
    expect(statuses.at(-1)).toBe("applied");
    expect((await withService(app.sql, (tx) => getSubscription(tx, ORG_A)))?.status).toBe(
      "past_due",
    );
  });

  it("a webhook for an organisation that does not exist is acknowledged and stores nothing", async () => {
    const ghost = new StandInProvider({ secret: SECRET, now: () => clock.t, deliver: post });
    const before = (await sql`select count(*)::int as n from public.billing_events`)[0]!.n;
    const c = await ghost.createCheckout({
      orgId: "0c000000-0000-4000-8000-00000000000c",
      planId: "small",
      interval: "month",
    });
    await ghost.completeCheckout(c.id);
    expect(statuses.at(-1)).toBe("unknown_org");
    expect((await sql`select count(*)::int as n from public.billing_events`)[0]!.n).toBe(before);
  });

  it("the server answers 500 when the database fails, so the provider retries", async () => {
    const extra = await appLogin(sql);
    const sent: Delivery[] = [];
    const quiet = new StandInProvider({
      secret: SECRET,
      now: () => clock.t,
      deliver: async (x) => void sent.push(x),
    });
    await quiet.completeCheckout(
      (await quiet.createCheckout({ orgId: ORG_A, planId: "small", interval: "month" })).id,
    );
    await extra.sql.end();
    const res = await postWebhook(
      new Request("https://hosted.example/api/v1/billing/webhook", {
        method: "POST",
        headers: sent[0]!.headers,
        body: sent[0]!.body,
      }),
      { ...deps(), sql: extra.sql },
    );
    expect(res.status).toBe(500);
    await extra.drop();
  });
});
