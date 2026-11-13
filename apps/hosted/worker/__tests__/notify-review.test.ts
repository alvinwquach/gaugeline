/**
 * Notifications (X67), the independent review's findings as tests: a time zone the runtime does not know
 * never fails the night; a notification failure never rolls back the run; the delivery log is per
 * organisation with rows on both sides; the production sender refuses a name that resolves to loopback; a
 * Vault outage is transient; a claimed row never stays "sending" and is never sent twice; an admin's label
 * cannot ping a Slack channel; start-up checks the worker can really use gaugeline_worker.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildResult, postJson, type Result } from "@gaugeline/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appLogin } from "../../app/api/__tests__/app-login.js";
import type { Tx } from "../../lib/api/db.js";
import {
  as,
  errorOf,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  SITE_A2,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_B_OWNER,
} from "../../db/__tests__/harness.js";
import {
  deliverDue,
  type NotifyDeps,
  notifyDepsFrom,
  saveChannel,
  SENDING_LEASE_MS,
  sendTestMessage,
} from "../notify.js";
import { memorySecretStore, type SecretStore } from "../secrets.js";
import { workOnce } from "../worker.js";

const slackUrl = (marker: string) =>
  ["https://hooks.slack.com/services", "T0NORTHGATE", "B0REVIEW", marker].join("/");
const NOW = new Date("2026-11-13T12:00:00Z");

describe.skipIf(!HAS_DATABASE)("hosted notifications: review findings", () => {
  let db: TestDatabase;
  let owner: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  let server: Server;
  let port = 0;
  let bodies: string[] = [];
  let secrets: SecretStore;

  const deps = (over: Partial<NotifyDeps> = {}): NotifyDeps => ({
    sql: app.sql,
    secrets,
    now: () => NOW,
    sleep: async () => {},
    send: (endpoint, body, headers) =>
      postJson(`http://127.0.0.1:${port}${new URL(endpoint).pathname}`, body, { headers }),
    ...over,
  });

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    app = await appLogin(owner);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(async () => {
    bodies = [];
    secrets = memorySecretStore();
    await owner`delete from public.notification_channels`;
    await owner`delete from public.jobs`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await app?.drop();
    await db?.drop();
  });

  async function channel(org: string, label = "#review", marker = "markerreview") {
    const r = await saveChannel(deps(), org, { kind: "slack", label, address: slackUrl(marker) });
    if (!r.ok) throw new Error(r.error);
    return r.channel.id;
  }
  const deliveryRow = async (id: string) =>
    (
      await owner`select status, attempts, error_code, locked_at from public.notification_deliveries
        where id = ${id}`
    )[0]!;
  async function queuedTest(
    org: string,
    ch: string,
    over: { status?: string; attempts?: number; lockedAt?: Date } = {},
  ) {
    const r = await owner`insert into public.notification_deliveries
        (org_id, channel_id, kind, status, attempts, locked_at, send_after)
      values (${org}, ${ch}, 'test', ${over.status ?? "queued"}, ${over.attempts ?? 0},
        ${over.lockedAt ?? null}, ${new Date(NOW.getTime() - 60_000)})
      returning id`;
    return r[0]!.id as string;
  }

  it("A: a site whose time zone the runtime does not know still stores its run and queues the message (UTC)", async () => {
    await owner`update public.sites set timezone = 'Factory' where id = ${SITE_A2}`;
    try {
      const ch = await channel(ORG_A);
      await owner`insert into public.notification_rules (org_id, channel_id, site_id, min_severity,
          only_changes, quiet_start, quiet_end)
        values (${ORG_A}, ${ch}, ${SITE_A2}, 'low', false, 22, 7)`;
      await owner`insert into public.jobs (org_id, site_id, kind, run_after)
        values (${ORG_A}, ${SITE_A2}, 'manual', ${NOW})`;
      const runSite = async (): Promise<Result> =>
        buildResult({
          url: "https://juniper-popup.test",
          startedAt: NOW,
          findings: [
            {
              checkId: "broken-links",
              severity: "high",
              title: "Broken link",
              evidence: "/menu links to /old (404)",
              url: "https://juniper-popup.test/menu",
            },
          ],
          passed: [],
          failed: [],
        });
      expect(await workOnce({ sql: app.sql, now: () => NOW, runSite })).toBe(1);
      const [job] = await owner`select status, last_error from public.jobs`;
      expect(job).toMatchObject({ status: "done", last_error: null });
      const [d] = await owner`select send_after from public.notification_deliveries
        where channel_id = ${ch}`;
      expect((d!.send_after as Date).toISOString()).toBe(NOW.toISOString()); // 12:00 UTC: not quiet
    } finally {
      await owner`update public.sites set timezone = 'Europe/London' where id = ${SITE_A2}`;
    }
  });

  it("A: a notification failure never fails or rolls back the night's run", async () => {
    await owner`insert into public.jobs (org_id, site_id, kind, run_after)
      values (${ORG_A}, ${SITE_A2}, 'manual', ${NOW})`;
    const runs = async () =>
      Number(
        (await owner`select count(*)::int as n from public.runs where site_id = ${SITE_A2}`)[0]!.n,
      );
    const before = await runs();
    const runSite = async (): Promise<Result> =>
      buildResult({
        url: "https://juniper-popup.test",
        startedAt: NOW,
        findings: [],
        passed: [],
        failed: [],
      });
    const broken = async (tx: Tx) => {
      await tx`select 1 / 0`; // a database error inside the run's transaction
      return 0;
    };
    expect(
      await workOnce({ sql: app.sql, now: () => NOW, runSite, queueNotifications: broken }),
    ).toBe(1);
    expect((await owner`select status from public.jobs`)[0]!.status).toBe("done");
    expect(await runs()).toBe(before + 1);
  });

  it("B: with log rows in both organisations, each sees only its own; a client viewer sees none", async () => {
    const a = await channel(ORG_A, "#a", "markera");
    const b = await channel(ORG_B, "#b", "markerb");
    await queuedTest(ORG_A, a, { status: "failed" });
    await queuedTest(ORG_B, b, { status: "failed" });
    await owner`insert into public.notification_rules (org_id, channel_id) values (${ORG_A}, ${a}), (${ORG_B}, ${b})`;
    const read = (who: { role: "authenticated"; userId: string }) =>
      as(owner, who, async (tx) => ({
        log: (await tx`select org_id from public.notification_deliveries`).map((r) => r.org_id),
        channels: (await tx`select org_id from public.notification_channels`).map((r) => r.org_id),
        rules: (await tx`select org_id from public.notification_rules`).map((r) => r.org_id),
      }));
    const ownerB = await read({ role: "authenticated", userId: USER_B_OWNER });
    expect(ownerB).toEqual({ log: [ORG_B], channels: [ORG_B], rules: [ORG_B] });
    const memberA = await read({ role: "authenticated", userId: USER_A_MEMBER });
    expect(memberA).toEqual({ log: [ORG_A], channels: [ORG_A], rules: [ORG_A] });
    const client = await read({ role: "authenticated", userId: USER_A_CLIENT });
    expect(client).toEqual({ log: [], channels: [], rules: [] });
  });

  it("C: the production sender (no send override) refuses a name that resolves to loopback before connecting", async () => {
    const ch = await channel(ORG_A);
    const id = await queuedTest(ORG_A, ch);
    const asked: string[] = [];
    const d = deps({
      // Production's sender, with only the name lookup stood in: hooks.slack.com "resolves" to 127.0.0.1.
      lookup: (hostname, _options, callback) => {
        asked.push(hostname);
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    });
    delete d.send;
    expect(await deliverDue(d)).toBe(1);
    expect(asked).toContain("hooks.slack.com");
    // address-refused (the lookup refused it), not unreachable (a refused connection to 127.0.0.1:443).
    expect(await deliveryRow(id)).toMatchObject({
      status: "failed",
      error_code: "address-refused",
    });
    expect(bodies).toHaveLength(0);
  });

  it("D: a Vault outage is transient: the delivery is queued again and the channel stays on", async () => {
    const ch = await channel(ORG_A);
    const id = await queuedTest(ORG_A, ch);
    const down: SecretStore = {
      ...secrets,
      get: async () => {
        throw new Error("vault unavailable");
      },
    };
    await deliverDue(deps({ secrets: down }));
    expect(await deliveryRow(id)).toMatchObject({
      status: "queued",
      error_code: "secret-unavailable",
    });
    const [c] =
      await owner`select status, failures, disabled_reason from public.notification_channels where id = ${ch}`;
    expect(c).toMatchObject({ status: "active", failures: 0, disabled_reason: null });
    // Vault is back: the next pass after the wait sends it.
    await deliverDue(deps({ now: () => new Date(NOW.getTime() + 60 * 60_000) }));
    expect(await deliveryRow(id)).toMatchObject({ status: "sent" });
    expect(bodies).toHaveLength(1);
  });

  it("E: a send that throws fails that row only; the other claimed rows are still sent", async () => {
    const ch = await channel(ORG_A);
    const first = await queuedTest(ORG_A, ch);
    const second = await queuedTest(ORG_A, ch);
    let calls = 0;
    const d = deps();
    const real = d.send!;
    d.send = async (...args) => {
      if (++calls === 1) throw new Error("socket exploded");
      return real(...args);
    };
    expect(await deliverDue(d)).toBe(2);
    const rows = [await deliveryRow(first), await deliveryRow(second)].map((r) => r.status).sort();
    expect(rows).toEqual(["failed", "sent"]);
    expect(
      (
        await owner`select count(*)::int as n from public.notification_deliveries where status = 'sending'`
      )[0]!.n,
    ).toBe(0);
  });

  it("E: a row left 'sending' by a crash is sent again only if no POST was started (at most once)", async () => {
    const ch = await channel(ORG_A);
    const stale = new Date(NOW.getTime() - SENDING_LEASE_MS - 60_000);
    const beforePost = await queuedTest(ORG_A, ch, {
      status: "sending",
      attempts: 0,
      lockedAt: stale,
    });
    const afterPost = await queuedTest(ORG_A, ch, {
      status: "sending",
      attempts: 1,
      lockedAt: stale,
    });
    const fresh = await queuedTest(ORG_A, ch, { status: "sending", attempts: 0, lockedAt: NOW });
    await deliverDue(deps());
    expect(await deliveryRow(beforePost)).toMatchObject({ status: "sent" });
    expect(await deliveryRow(afterPost)).toMatchObject({
      status: "failed",
      error_code: "interrupted",
    });
    expect(await deliveryRow(fresh)).toMatchObject({ status: "sending" }); // another worker holds it
    expect(bodies).toHaveLength(1);
  });

  it("F: an admin's label in the Slack test message cannot ping or format", async () => {
    const ch = await channel(ORG_A, "<!channel> *ops* <https://evil.test|x>");
    expect(await sendTestMessage(deps(), ORG_A, ch)).toMatchObject({ ok: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("<!channel>");
    expect(bodies[0]).not.toContain("<https://evil.test|");
    expect(bodies[0]).not.toContain("*ops*");
  });

  /** notifyDepsFrom's error as `role`, inside a transaction that is always rolled back (roles are cluster-wide). */
  async function startUpAs(setup: string): Promise<string> {
    let seen = "";
    await owner
      .begin(async (tx) => {
        await tx.unsafe(setup);
        seen = await errorOf(
          notifyDepsFrom({ GAUGELINE_SECRET_STORE: "vault" }, tx as unknown as Sql),
        );
        throw new Error("rollback");
      })
      .catch(() => undefined);
    return seen;
  }

  it("G: start-up refuses a login that is a member of gaugeline_worker but cannot SET it", async () => {
    const role = `gl_x67_${Math.random().toString(36).slice(2, 10)}`;
    expect(
      await startUpAs(
        `create role ${role} nologin; grant gaugeline_worker to ${role} with set false; set local role ${role}`,
      ),
    ).toMatch(/cannot use gaugeline_worker/);
    expect(
      await startUpAs(
        `create role ${role} nologin; grant gaugeline_worker to ${role}; set local role ${role}`,
      ),
    ).toBe("");
  });

  it("G: start-up refuses when gaugeline_worker cannot execute get_secret", async () => {
    expect(
      await startUpAs(
        "revoke execute on function private.get_secret(uuid, text) from gaugeline_worker",
      ),
    ).toMatch(/cannot use gaugeline_worker/);
  });
});
