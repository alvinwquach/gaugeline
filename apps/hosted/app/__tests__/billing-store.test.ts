/**
 * Billing against a real Postgres: events saved once however often they arrive, in whatever order, and
 * the table fenced by row-level security. Skipped without GAUGELINE_TEST_DATABASE_URL, like the other
 * database tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
  type Sql,
  type TestDatabase,
} from "../../db/__tests__/harness.js";
import { withService } from "../../lib/api/db.js";
import { checkSiteLimit, getSubscription, recordEvent } from "../../lib/billing/store.js";
import type { BillingEvent } from "../../lib/billing/state.js";
import { appLogin } from "../api/__tests__/app-login.js";
import { at, created, event, T0, TEST_CONFIG } from "./billing-fixtures.js";

describe.skipIf(!HAS_DATABASE)("billing: the subscription table", () => {
  let db: TestDatabase;
  let sql: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  const record = (ev: BillingEvent) =>
    withService(app.sql, (tx) => recordEvent(tx, ev, TEST_CONFIG));
  const sub = (orgId = ORG_A) => withService(app.sql, (tx) => getSubscription(tx, orgId));
  const ledger = async () =>
    (
      await sql`select event_id, outcome from public.billing_events order by received_at, event_id`
    ).map((r) => `${r.event_id}:${r.outcome}`);

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
    app = await appLogin(sql);
  });
  afterAll(async () => {
    await app?.drop();
    await db?.drop();
  });

  it("a created subscription is saved with the provider's ids and nothing else", async () => {
    await sql.unsafe("truncate public.subscriptions");
    const r = await record(created({ id: "evt_a1" }));
    expect(r).toEqual({ outcome: "applied", effects: [] });
    expect(await sub()).toMatchObject({
      orgId: ORG_A,
      customerId: "cus_northgate",
      subscriptionId: "sub_northgate",
      planId: "small",
      status: "active",
    });
    const cols = await sql`select column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('subscriptions', 'billing_events')`;
    expect(cols.map((c) => c.column_name as string).join(" ")).not.toMatch(
      /card|pan|number|last4|brand|cvc|expiry|address|name|email|invoice/i,
    );
  });

  it("the same webhook twice changes nothing and sends nothing twice", async () => {
    await sql.unsafe("truncate public.subscriptions");
    const failed = event("payment.failed", { id: "evt_dup", createdAt: at(1) });
    await record(created({ id: "evt_dup_c" }));
    const first = await record(failed);
    expect(first.outcome).toBe("applied");
    expect(first.effects).toHaveLength(1);
    const before = await sub();
    const second = await record(failed);
    expect(second).toEqual({ outcome: "duplicate", effects: [] });
    expect(await sub()).toEqual(before);
    expect((await ledger()).filter((l) => l.startsWith("evt_dup:"))).toEqual(["evt_dup:applied"]);
  });

  it("five deliveries of one event at the same moment apply it once", async () => {
    await sql.unsafe("truncate public.subscriptions");
    await record(created({ id: "evt_race_c" }));
    const ev = event("payment.failed", { id: "evt_race", createdAt: at(2) });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => record(ev)));
    expect(results.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(4);
    expect(results.flatMap((r) => r.effects)).toHaveLength(1);
  });

  it("events out of order: the newer state wins and the older one is recorded as stale", async () => {
    await sql.unsafe("truncate public.subscriptions");
    const update = {
      ...created({ id: "evt_ooo_u", createdAt: at(10) }),
      type: "subscription.updated" as const,
      subscription: { ...created().subscription, planId: "large" },
    };
    expect((await record(update)).outcome).toBe("applied");
    expect((await record(created({ id: "evt_ooo_c", createdAt: at(0) }))).outcome).toBe("stale");
    expect((await sub())?.planId).toBe("large");
    expect(await ledger()).toContain("evt_ooo_c:stale");
  });

  it("a webhook that arrives before the checkout page returns is enough: the page only reads", async () => {
    await sql.unsafe("truncate public.subscriptions");
    await record(created({ id: "evt_early" }));
    // The browser comes back from checkout afterwards and finds the plan already there.
    expect((await sub())?.status).toBe("active");
  });

  it("a payment event for a subscription not seen yet is not recorded, so its retry works", async () => {
    await sql.unsafe("truncate public.subscriptions");
    const failed = event("payment.failed", { id: "evt_early_fail", createdAt: at(1) });
    expect(await record(failed)).toEqual({ outcome: "needs_subscription", effects: [] });
    expect(await ledger()).not.toContain("evt_early_fail:applied");
    await record(created({ id: "evt_late_created" }));
    expect((await record(failed)).outcome).toBe("applied");
    expect((await sub())?.status).toBe("past_due");
  });

  it("an event for an organisation that does not exist is ignored and stores nothing", async () => {
    const r = await record(
      created({ id: "evt_nobody", orgId: "0c000000-0000-4000-8000-00000000000c" }),
    );
    expect(r).toEqual({ outcome: "unknown_org", effects: [] });
    expect(await ledger()).not.toContain("evt_nobody:applied");
  });

  it("the site limit is counted from the real sites, and a downgrade keeps the sites it cannot add to", async () => {
    await sql.unsafe("truncate public.subscriptions");
    const check = () => withService(app.sql, (tx) => checkSiteLimit(tx, ORG_A, TEST_CONFIG, T0));
    expect(await check()).toEqual({ allowed: true }); // no subscription yet
    await record(created({ id: "evt_lim_c" })); // "small": 2 sites, and Northgate has 2
    expect(await check()).toMatchObject({ allowed: false, reason: "limit" });
    await record({
      ...created({ id: "evt_lim_up", createdAt: at(1) }),
      type: "subscription.updated",
      subscription: { ...created().subscription, planId: "large" },
    });
    expect(await check()).toEqual({ allowed: true });
    // Back down: the two sites stay, a third is refused, and nothing was removed.
    await record({
      ...created({ id: "evt_lim_down", createdAt: at(2) }),
      type: "subscription.updated",
      subscription: { ...created().subscription, planId: "small" },
    });
    expect(await check()).toMatchObject({ allowed: false, reason: "limit" });
    expect(
      (await sql`select count(*)::int as n from public.sites where org_id = ${ORG_A}`)[0]!.n,
    ).toBe(2);
  });

  it("another organisation's sites and subscription are not counted", async () => {
    await sql.unsafe("truncate public.subscriptions");
    await record(created({ id: "evt_a_only" }));
    expect(await sub(ORG_B)).toBeNull();
    const b = await withService(app.sql, (tx) => checkSiteLimit(tx, ORG_B, TEST_CONFIG, T0));
    expect(b).toEqual({ allowed: true });
  });

  it("the limit check refuses to run as anyone but the server", async () => {
    const msg = await errorOf(
      as(sql, { role: "authenticated", userId: USER_A_OWNER }, (tx) =>
        checkSiteLimit(tx, ORG_A, TEST_CONFIG, T0),
      ),
    );
    expect(msg).toMatch(/service_role/);
  });

  describe("who can see and change it", () => {
    beforeAll(async () => {
      await sql.unsafe("truncate public.subscriptions");
      await record(created({ id: "evt_rls_c" }));
    });
    const read = (userId: string) =>
      as(
        sql,
        { role: "authenticated", userId },
        (tx) => tx`select org_id, plan_id from public.subscriptions`,
      );

    it("an organisation's owner reads its subscription; no one else does, in or out of the organisation", async () => {
      expect(await read(USER_A_OWNER)).toHaveLength(1);
      expect(await read(USER_A_MEMBER)).toHaveLength(0);
      expect(await read(USER_A_CLIENT)).toHaveLength(0);
      expect(await read(USER_B_OWNER)).toHaveLength(0);
    });

    it("nobody signed in can write the table or read the ledger, not even the owner", async () => {
      const owner = { role: "authenticated" as const, userId: USER_A_OWNER };
      for (const stmt of [
        "update public.subscriptions set plan_id = 'large'",
        "delete from public.subscriptions",
        `insert into public.subscriptions (org_id, provider, provider_customer_id, provider_subscription_id, plan_id, status, last_event_at) values ('${ORG_B}', 'stand-in', 'c', 's', 'large', 'active', now())`,
        "select * from public.billing_events",
      ]) {
        expect(await errorOf(as(sql, owner, (tx) => tx.unsafe(stmt))), stmt).toMatch(
          /permission denied|row-level/,
        );
      }
      expect(
        await errorOf(as(sql, { role: "anon" }, (tx) => tx`select * from public.subscriptions`)),
      ).toMatch(/permission denied/);
    });

    it("the event ledger cannot be changed afterwards, by the server either", async () => {
      for (const stmt of [
        "update public.billing_events set outcome = 'stale'",
        "delete from public.billing_events",
      ]) {
        expect(
          await errorOf(as(sql, { role: "service_role" }, (tx) => tx.unsafe(stmt))),
          stmt,
        ).toMatch(/permission denied|append-only/);
      }
      expect(
        await errorOf(sql.unsafe("update public.billing_events set outcome = 'stale'")),
      ).toMatch(/append-only/);
    });

    it("an id that looks like a card number is refused", async () => {
      const msg = await errorOf(
        sql.unsafe(
          `insert into public.subscriptions (org_id, provider, provider_customer_id, provider_subscription_id, plan_id, status, last_event_at) values ('${ORG_B}', 'stand-in', '${"4".repeat(16)}', 's_1', 'large', 'active', now())`,
        ),
      );
      expect(msg).toMatch(/provider_customer_id_check/);
    });
  });
});
