/**
 * X67's acceptance, through the real worker: a finding found one night is sent to the organisation's
 * Sentry project once; the next night it is fixed and nothing new is sent; when it comes back it goes to
 * the same Sentry issue (the same fingerprint). The checks and Sentry are stood in for.
 */
import { buildResult, type Result } from "@gaugeline/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appLogin } from "../../app/api/__tests__/app-login.js";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  seed,
  SITE_A2,
  type Sql,
  type TestDatabase,
} from "../../db/__tests__/harness.js";
import { deliverDue, type NotifyDeps, saveChannel } from "../notify.js";
import { memorySecretStore } from "../secrets.js";
import { workOnce } from "../worker.js";

type Finding = Result["findings"][number];
const T0 = Date.parse("2026-11-12T12:00:00Z");
const DSN = `https://${"d".repeat(32)}@o4500000000000001.ingest.sentry.io/4500000000000003`;
const brokenMenu: Finding = {
  checkId: "broken-links",
  severity: "high",
  title: "Broken link on the pop-up's menu",
  evidence: "/menu links to /winter-specials (404)",
  url: "https://juniper-popup.test/menu",
};

describe.skipIf(!HAS_DATABASE)("notifications through the nightly worker", () => {
  let db: TestDatabase;
  let owner: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  const sent: { fingerprint: unknown }[] = [];

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    app = await appLogin(owner);
  });
  afterAll(async () => {
    await app?.drop();
    await db?.drop();
  });

  it("opens one Sentry issue, sends nothing when it is fixed, and reopens the same issue", async () => {
    const notify: NotifyDeps = {
      sql: app.sql,
      secrets: memorySecretStore(),
      sleep: async () => {},
      send: async (_endpoint, body) => {
        sent.push(body as { fingerprint: unknown });
        return { ok: true, status: 200 };
      },
    };
    const saved = await saveChannel(notify, ORG_A, {
      kind: "sentry",
      label: "Juniper",
      address: DSN,
    });
    expect(saved.ok).toBe(true);
    await owner`insert into public.notification_rules (org_id, channel_id, site_id, min_severity)
      values (${ORG_A}, ${saved.ok ? saved.channel.id : ""}, ${SITE_A2}, 'high')`;

    const nights = [[brokenMenu], [], [brokenMenu]];
    for (const [i, findings] of nights.entries()) {
      const now = () => new Date(T0 + i * 86_400_000);
      await owner`insert into public.jobs (org_id, site_id, kind, run_after)
        values (${ORG_A}, ${SITE_A2}, 'manual', ${now()})`;
      const runSite = async (): Promise<Result> =>
        buildResult({
          url: "https://juniper-popup.test",
          startedAt: now(),
          findings,
          passed: findings.length === 0 ? ["broken-links"] : [],
          failed: [],
        });
      expect(await workOnce({ sql: app.sql, now, runSite, notify: { ...notify, now } })).toBe(1);
      await deliverDue({ ...notify, now });
      expect(sent, `night ${i + 1}`).toHaveLength([1, 1, 2][i]!);
    }
    expect(sent[0]!.fingerprint).toEqual(sent[1]!.fingerprint);
    const log = await owner`select kind, status, findings from public.notification_deliveries
      order by created_at`;
    expect(log.map((r) => `${r.kind}:${r.status}:${r.findings}`)).toEqual([
      "run:sent:1",
      "run:sent:1",
    ]);
  });
});
