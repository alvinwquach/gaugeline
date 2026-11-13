/**
 * Notifications (X67) against the database and the Vault stand-in: saving a channel keeps the address in
 * Vault only; another organisation, a client viewer or a signed-in person never reads it; a night's change
 * queues one delivery per channel; the sender posts to stand-ins for Slack and Sentry, retries, logs a code
 * and never an address, and disables a channel that keeps failing.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { postJson } from "@gaugeline/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  RUN_A1,
  seed,
  SITE_A1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
} from "../../db/__tests__/harness.js";
import {
  deliverDue,
  type NotifyDeps,
  notifyDepsFrom,
  queueRunNotifications,
  removeChannel,
  saveChannel,
  sendTestMessage,
} from "../notify.js";
import { vaultSecretStore } from "../secrets.js";

// Invented addresses (rule 12), built at run time so nothing key-shaped sits in the source.
const TOKEN = ["marker", "x67", "tidewater"].join("");
const SLACK = ["https://hooks.slack.com/services", "T0NORTHGATE", "B0TIDEWATER", TOKEN].join("/");
const KEY = "c".repeat(32);
const DSN = `https://${KEY}@o4500000000000001.ingest.sentry.io/4500000000000002`;
const RUN_2 = "a1a20000-0000-4000-8000-0000000000a2";

interface Hit {
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

describe.skipIf(!HAS_DATABASE)("hosted notifications: database, Vault and stand-ins", () => {
  let db: TestDatabase;
  let sql: Sql;
  let server: Server;
  let port = 0;
  const hits: Hit[] = [];
  let answer = 200;
  const logs: string[] = [];
  const origError = console.error;

  const deps = (over: Partial<NotifyDeps> = {}): NotifyDeps => ({
    sql,
    secrets: vaultSecretStore(sql),
    now: () => new Date("2026-11-13T12:00:00Z"),
    sleep: async () => {},
    appUrl: "https://app.gaugeline.test",
    // The stand-in: the real POST module, with the vendor's host mapped to the local server.
    send: (endpoint, body, headers) => {
      const u = new URL(endpoint);
      return postJson(`http://127.0.0.1:${port}${u.pathname}`, body, {
        headers: { ...headers, "x-original-host": u.hostname },
      });
    },
    ...over,
  });

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        hits.push({
          path: req.url ?? "",
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
        res.writeHead(answer).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  });
  afterEach(() => {
    hits.length = 0;
    answer = 200;
  });
  afterAll(async () => {
    console.error = origError;
    await new Promise<void>((r) => server?.close(() => r()));
    await db?.drop();
  });

  const everything = async () =>
    JSON.stringify([
      await sql`select * from public.notification_channels`,
      await sql`select * from public.notification_rules`,
      await sql`select * from public.notification_deliveries`,
      await sql`select * from private.secret_refs`,
      await sql`select * from private.secret_events`,
    ]);

  it("start-up: no store, or a vault store on a login without gaugeline_worker, stops the worker", async () => {
    expect(await errorOf(notifyDepsFrom({}, sql))).toMatch(/GAUGELINE_SECRET_STORE must be/);
    // The test login is a superuser, so pg_has_role is true: the check passes; a plain login fails it.
    await expect(notifyDepsFrom({ GAUGELINE_SECRET_STORE: "vault" }, sql)).resolves.toBeTruthy();
    await sql
      .begin(async (tx) => {
        await tx.unsafe("create role gl_x67_plain nologin");
        await tx.unsafe("set local role gl_x67_plain");
        expect(
          await errorOf(notifyDepsFrom({ GAUGELINE_SECRET_STORE: "vault" }, tx as unknown as Sql)),
        ).toMatch(/cannot use gaugeline_worker/);
        throw new Error("rollback");
      })
      .catch((e: Error) => expect(e.message).toBe("rollback"));
  });

  it("refuses an address that is not the vendor's, and stores nothing", async () => {
    const r = await saveChannel(deps(), ORG_A, {
      kind: "slack",
      label: "#tidewater",
      address: SLACK.replace("hooks.slack.com", "hooks.slack.com.evil.test"),
    });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect((await sql`select count(*)::int as n from private.secret_refs`)[0]!.n).toBe(0);
  });

  it("saves a channel: the address in Vault, the row with its host and label only", async () => {
    const r = await saveChannel(deps(), ORG_A, {
      kind: "slack",
      label: "#tidewater",
      address: SLACK,
    });
    expect(r).toMatchObject({
      ok: true,
      channel: { host: "hooks.slack.com", label: "#tidewater" },
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const all = await everything();
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("/services/");
  });

  it("another organisation, a client viewer and a signed-in person never read the address", async () => {
    const [ch] = await sql`select id, secret_name from public.notification_channels`;
    await sql`insert into public.notification_rules (org_id, channel_id, site_id, min_severity)
      values (${ORG_A}, ${ch!.id}, ${SITE_A1}, 'high')`;
    const ownerB = { role: "authenticated" as const, userId: USER_B_OWNER };
    const seen = await as(sql, ownerB, async (tx) => ({
      channels: await tx`select * from public.notification_channels`,
      rules: await tx`select * from public.notification_rules`,
      log: await tx`select * from public.notification_deliveries`,
    }));
    for (const [t, rows] of Object.entries(seen)) expect(rows.length, t).toBe(0);
    const client = { role: "authenticated" as const, userId: USER_A_CLIENT };
    expect(
      (await as(sql, client, (tx) => tx`select * from public.notification_channels`)).length,
    ).toBe(0);
    const member = { role: "authenticated" as const, userId: USER_A_MEMBER };
    expect(
      (await as(sql, member, (tx) => tx`select * from public.notification_channels`)).length,
    ).toBe(1);
    expect(
      await errorOf(
        as(
          sql,
          { role: "authenticated", userId: USER_A_OWNER },
          (tx) => tx`select private.get_secret(${ORG_A}, ${ch!.secret_name as string})`,
        ),
      ),
    ).toMatch(/permission denied/);
    // Writing a channel row directly (bypassing Vault) is the worker's job only.
    expect(
      await errorOf(
        as(
          sql,
          { role: "authenticated", userId: USER_A_OWNER },
          (tx) =>
            tx`insert into public.notification_channels (org_id, kind, label, host, secret_name)
            values (${ORG_A}, 'slack', 'x', 'hooks.slack.com', 'x')`,
        ),
      ),
    ).toMatch(/permission denied/);
    // Rules: an admin of A may write A's; a member may not; nobody may point at B's site.
    expect(
      await errorOf(
        as(
          sql,
          member,
          (tx) =>
            tx`insert into public.notification_rules (org_id, channel_id) values (${ORG_A}, ${ch!.id})`,
        ),
      ),
    ).toMatch(/row-level security/);
    expect(
      await errorOf(
        as(
          sql,
          ownerB,
          (tx) =>
            tx`insert into public.notification_rules (org_id, channel_id) values (${ORG_B}, ${ch!.id})`,
        ),
      ),
    ).toMatch(/foreign key/);
  });

  it("a night that opened a finding queues one delivery, sent once with the evidence and a link", async () => {
    await sql`insert into public.run_changes (org_id, site_id, run_id, opened, still_open, closed,
        opened_fingerprints, closed_fingerprints)
      values (${ORG_A}, ${SITE_A1}, ${RUN_A1}, 1, 0, 0, ${["0123456789abcdef"]}, ${[]})`;
    const queued = await sql.begin((tx) =>
      queueRunNotifications(tx, {
        orgId: ORG_A,
        siteId: SITE_A1,
        runId: RUN_A1,
        now: new Date("2026-11-13T12:00:00Z"),
      }),
    );
    expect(queued).toBe(1);
    // Queuing twice (a retried job) adds nothing.
    await sql.begin((tx) =>
      queueRunNotifications(tx, { orgId: ORG_A, siteId: SITE_A1, runId: RUN_A1, now: new Date() }),
    );
    expect(await deliverDue(deps())).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers["x-original-host"]).toBe("hooks.slack.com");
    const text = JSON.stringify(hits[0]!.body);
    expect(text).toContain("Broken link on the menu page");
    expect(text).toContain("/menu links to /drinks-2025 (404)");
    expect(text).toContain("https://app.gaugeline.test/");
    expect(await deliverDue(deps())).toBe(0);
    const [d] =
      await sql`select status, attempts, findings, error_code from public.notification_deliveries`;
    expect(d).toMatchObject({ status: "sent", attempts: 1, findings: 1, error_code: null });
    expect(await everything()).not.toContain(TOKEN);
  });

  it("a destination that rejects the request is retried, then reported; three failed nights disable it", async () => {
    answer = 503;
    const [ch] = await sql`select id from public.notification_channels where org_id = ${ORG_A}`;
    for (let i = 0; i < 3; i++) {
      const r = await sendTestMessage(deps(), ORG_A, ch!.id as string);
      expect(r).toMatchObject({ ok: false, code: "http-503" });
    }
    expect(hits).toHaveLength(9); // three tries each
    const [c] =
      await sql`select status, failures, disabled_reason from public.notification_channels where id = ${ch!.id}`;
    expect(c).toMatchObject({
      status: "disabled",
      failures: 3,
      disabled_reason: "failed-repeatedly",
    });
    // A disabled channel gets nothing queued; a test message that works turns it back on.
    answer = 200;
    expect(await sendTestMessage(deps(), ORG_A, ch!.id as string)).toMatchObject({ ok: true });
    const [c2] =
      await sql`select status, failures, disabled_reason from public.notification_channels where id = ${ch!.id}`;
    expect(c2).toMatchObject({ status: "active", failures: 0, disabled_reason: null });
    const log =
      await sql`select error_code, http_status from public.notification_deliveries where kind = 'test'`;
    expect(log.map((r) => r.error_code)).toEqual(["http-503", "http-503", "http-503", null]);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(await everything()).not.toContain(TOKEN);
  });

  it("a revoked webhook (404) disables the channel at once, with a clear reason", async () => {
    answer = 404;
    const [ch] = await sql`select id from public.notification_channels where org_id = ${ORG_A}`;
    expect(await sendTestMessage(deps(), ORG_A, ch!.id as string)).toMatchObject({
      ok: false,
      code: "http-404",
    });
    expect(hits).toHaveLength(1);
    const [c] =
      await sql`select status, disabled_reason from public.notification_channels where id = ${ch!.id}`;
    expect(c).toMatchObject({ status: "disabled", disabled_reason: "rejected" });
  });

  it("Sentry: the same finding on two nights is one issue (one fingerprint), and comes back the same", async () => {
    const saved = await saveChannel(deps(), ORG_A, {
      kind: "sentry",
      label: "Tidewater",
      address: DSN,
    });
    expect(saved.ok).toBe(true);
    const id = saved.ok ? saved.channel.id : "";
    await sql`insert into public.notification_rules (org_id, channel_id, site_id, min_severity, only_changes)
      values (${ORG_A}, ${id}, ${SITE_A1}, 'low', false)`;
    await sql`insert into public.runs (id, org_id, site_id, started_at, finished_at, summary) values
      (${RUN_2}, ${ORG_A}, ${SITE_A1}, '2026-11-11T03:00:00Z', '2026-11-11T03:01:00Z', '{"high":1}')`;
    await sql`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint)
      values (${ORG_A}, ${SITE_A1}, ${RUN_2}, 'broken-links', 'high', 'Broken link on the menu page',
        '/menu links to /drinks-2025 (404)', 'https://tidewater-bar.test/menu', '0123456789abcdef')`;
    for (const run of [RUN_A1, RUN_2])
      await sql.begin((tx) =>
        queueRunNotifications(tx, { orgId: ORG_A, siteId: SITE_A1, runId: run, now: new Date() }),
      );
    await deliverDue(deps());
    const sentry = hits.filter((h) => h.path === "/api/4500000000000002/store/");
    expect(sentry).toHaveLength(2);
    expect(sentry[0]!.headers["x-sentry-auth"]).toContain(`sentry_key=${KEY}`);
    const fps = sentry.map((h) => JSON.stringify((h.body as { fingerprint: unknown }).fingerprint));
    expect(fps[0]).toBe(fps[1]);
    expect(await everything()).not.toContain(KEY);
    // Removing the channel removes its Vault secret too.
    expect(await removeChannel(deps(), ORG_A, id)).toBe(true);
    expect(await vaultSecretStore(sql).list(ORG_A)).toHaveLength(1);
  });
});
