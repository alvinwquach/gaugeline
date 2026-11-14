/**
 * The weekly update end to end against a real Postgres (X66): drafted from the week's runs into the inbox,
 * edited and approved by a person, then sent to a test inbox from the agency's name. Nothing is sent before
 * the approval, nothing twice, and a mail failure leaves it unsent.
 */
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  draftWeeklyUpdates,
  MemoryInbox,
  sendApprovedUpdates,
  weekStartOf,
  type ServiceRunner,
} from "../../agency/weekly-store.js";
import { decide, listWaiting, MemoryApplyQueue } from "../../inbox/inbox.js";
import {
  as,
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  SITE_A1,
  SITE_A2,
  SITE_B1,
  type Sql,
  type TestDatabase,
  USER_A_CLIENT,
  USER_A_MEMBER,
} from "./harness.js";

/** True when `text` has a control character other than newline, or a bidirectional control. */
const hasControl = (text: string): boolean =>
  [...text].some((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      (c < 0x20 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });

const CLIENT_BAR = "c1000000-0000-4000-8000-0000000000c1";
const CLIENT_KITCHEN = "c2000000-0000-4000-8000-0000000000c2";
const MONDAY = "2026-11-09";

describe.skipIf(!HAS_DATABASE)("the weekly update: draft, edit, approve, send", () => {
  let db: TestDatabase;
  let sql: Sql;
  let service: ServiceRunner;

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
    await sql.unsafe(`
      insert into public.clients (id, org_id, name) values
        ('${CLIENT_BAR}', '${ORG_A}', 'Tidewater Hospitality'),
        ('${CLIENT_KITCHEN}', '${ORG_A}', 'Juniper Kitchens');
      update public.sites set client_id = '${CLIENT_BAR}' where id = '${SITE_A1}';
      update public.sites set client_id = '${CLIENT_KITCHEN}' where id = '${SITE_A2}';
      insert into public.runs (org_id, site_id, started_at, finished_at) values
        ('${ORG_A}', '${SITE_A2}', '2026-11-11T03:00:00Z', '2026-11-11T03:01:00Z');
    `);
    // The server's connection: every statement as service_role, committed (not rolled back like `as`).
    service = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        return fn(tx);
      }) as Promise<T>;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("the week starts on the Monday, whatever day the job runs", () => {
    expect(weekStartOf(new Date("2026-11-13T17:00:00Z"))).toBe(MONDAY);
    expect(weekStartOf(new Date("2026-11-15T23:59:00Z"))).toBe(MONDAY);
    expect(weekStartOf(new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
  });

  it("drafts one update per client into the inbox, once, and sends nothing until a person approves", async () => {
    const made = await draftWeeklyUpdates(service, MONDAY);
    expect(made).toHaveLength(2);
    expect(await draftWeeklyUpdates(service, MONDAY)).toEqual([]);

    const updates =
      await sql`select client_id, subject, body from public.weekly_updates order by subject`;
    expect(updates.map((u) => u.subject)).toEqual([
      "Juniper Kitchens: your sites, week of Mon 9 Nov",
      "Tidewater Hospitality: your sites, week of Mon 9 Nov",
    ]);
    // The pop-up had a clean run: the short "all checked, nothing found".
    expect(updates[0]!.body).toContain("Checked once, on Wed 11 Nov.\nAll checked, nothing found.");
    // The bar's first run, on Tuesday, found the broken menu link.
    expect(updates[1]!.body).toContain("New this week:\n- Broken link on the menu page");

    const inbox = new MemoryInbox();
    expect(await sendApprovedUpdates(service, inbox)).toBe(0);
    expect(inbox.sent).toEqual([]);
  });

  it("an edit is approved in the inbox, and the edited words are what is sent, from the agency's name", async () => {
    const waiting = await listWaiting(sql, { userId: USER_A_MEMBER });
    const kitchen = waiting.find((d) => d.siteId === SITE_A2)!;
    expect(kitchen.kind).toBe("email");
    const edited = {
      subject: "Juniper Kitchens: your week",
      body: "All checked, nothing found. See you Friday.",
    };
    const queue = new MemoryApplyQueue();
    const result = await decide(
      sql,
      { userId: USER_A_MEMBER },
      kitchen.id,
      { kind: "edit", payload: edited },
      queue,
    );
    expect(result.status).toBe("recorded");
    // The writer never sees it: a weekly update is sent by sendApprovedUpdates only, never as an apply job.
    expect([...queue.jobs.keys()]).toEqual([]);

    const inbox = new MemoryInbox();
    expect(await sendApprovedUpdates(service, inbox)).toBe(1);
    expect(inbox.sent).toEqual([
      { orgId: ORG_A, clientId: CLIENT_KITCHEN, fromName: "Northgate Studio", ...edited },
    ]);
    expect(await sendApprovedUpdates(service, inbox)).toBe(0);
  });

  it("a mail failure leaves the update unsent, so it is tried again", async () => {
    const waiting = await listWaiting(sql, { userId: USER_A_MEMBER });
    const bar = waiting.find((d) => d.siteId === SITE_A1)!;
    await decide(
      sql,
      { userId: USER_A_MEMBER },
      bar.id,
      { kind: "approve" },
      new MemoryApplyQueue(),
    );
    const failing = { send: async () => Promise.reject(new Error("mail service down")) };
    await expect(sendApprovedUpdates(service, failing)).rejects.toThrow(/mail service down/);
    const inbox = new MemoryInbox();
    expect(await sendApprovedUpdates(service, inbox)).toBe(1);
    expect(inbox.sent[0]!.clientId).toBe(CLIENT_BAR);
  });

  it("each client viewer reads only their own sent update", async () => {
    const bar = await as(
      sql,
      { role: "authenticated", userId: USER_A_CLIENT },
      (tx) => tx`select client_id from public.weekly_update_sends`,
    );
    expect(bar.map((r) => r.client_id)).toEqual([CLIENT_BAR]);
  });
});

describe.skipIf(!HAS_DATABASE)("the weekly update: odd names and one client failing", () => {
  let db: TestDatabase;
  const CLINIC = "c3000000-0000-4000-8000-0000000000c3";

  beforeAll(async () => {
    db = await freshDatabase();
    await seed(db.sql);
    // Organisation and site names are not held to one line by the database; client names are (0008).
    await db.sql`update public.organisations set name = ${"Northgate\u202EStudio"} where org_id = ${ORG_A}`;
    await db.sql`update public.sites set name = ${"The Tidewater\u0007Bar"} where id = ${SITE_A1}`;
    await db.sql.unsafe(`
      insert into public.clients (id, org_id, name) values
        ('${CLIENT_BAR}', '${ORG_A}', 'Tidewater Hospitality'),
        ('${CLIENT_KITCHEN}', '${ORG_A}', 'Juniper Kitchens'),
        ('${CLINIC}', '${ORG_B}', 'Maple Street Health');
      update public.sites set client_id = '${CLIENT_BAR}' where id = '${SITE_A1}';
      update public.sites set client_id = '${CLIENT_KITCHEN}' where id = '${SITE_A2}';
      update public.sites set client_id = '${CLINIC}' where id = '${SITE_B1}';
      -- One client whose drafting fails for a reason no cleaning can fix.
      create function public.fail_kitchen() returns trigger language plpgsql as $f$
      begin
        if new.client_id = '${CLIENT_KITCHEN}' then raise exception 'injected failure'; end if;
        return new;
      end $f$;
      create trigger fail_kitchen before insert on public.weekly_updates
        for each row execute function public.fail_kitchen();
    `);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.drop();
  });

  it("odd names are cleaned to one line, a failing client is skipped and logged by id, and org B still gets its update", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service: ServiceRunner = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      db.sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        return fn(tx);
      }) as Promise<T>;
    const made = await draftWeeklyUpdates(service, MONDAY);
    expect(made).toHaveLength(2);
    const rows =
      await db.sql`select client_id, subject, body from public.weekly_updates order by client_id`;
    expect(rows.map((r) => r.client_id)).toEqual([CLIENT_BAR, CLINIC]);
    expect(rows[0]!.body).toContain("Hello from Northgate");
    expect(hasControl(rows[0]!.body as string)).toBe(false);
    expect(logged.mock.calls.map((c) => c.join(" "))).toEqual([
      `weekly update not drafted for client ${CLIENT_KITCHEN}`,
    ]);
  });
});
