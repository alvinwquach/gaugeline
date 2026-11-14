/**
 * The weekly client update's life (X66): drafted on Friday from the week's runs into the drafts inbox (G37,
 * kind "email"), approved or edited there by a person, and only then sent and recorded. The database refuses
 * a send record without an approving decision and fills its text from that decision (0006), so this module
 * cannot send words nobody approved even by mistake.
 *
 * Sending goes through `WeeklyMailer`, an interface: the morning-email path (X64) plugs its Resend sender in
 * here once it has merged. Nothing in this file makes a network request.
 */
import type postgres from "postgres";
import { composeWeeklyUpdate, type WeekFinding, type WeekInput } from "./weekly-update.js";

type Q = postgres.Sql | postgres.TransactionSql;

/** Runs `fn` in one transaction on the server's connection (service_role); commits when it returns. */
export type ServiceRunner = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => Promise<T>;

export interface WeeklyMessage {
  orgId: string;
  clientId: string;
  /** The display name the message is sent from: the agency, never Gaugeline. */
  fromName: string;
  subject: string;
  body: string;
}

/** The mail path. It resolves the client's recipients itself; a throw leaves the update unsent. */
export interface WeeklyMailer {
  send(message: WeeklyMessage): Promise<void>;
}

/** A test inbox: keeps what was sent. */
export class MemoryInbox implements WeeklyMailer {
  readonly sent: WeeklyMessage[] = [];
  async send(message: WeeklyMessage): Promise<void> {
    this.sent.push(message);
  }
}

const DAY_MS = 86_400_000;

/** The Monday (UTC) of the week `at` falls in, as YYYY-MM-DD. */
export function weekStartOf(at: Date): string {
  const day = (at.getUTCDay() + 6) % 7; // Monday 0 .. Sunday 6
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - day * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * One client's week as the caller may read it (the policies apply when `q` is a signed-in person). Returns
 * null when the client is not visible or has no site.
 */
export async function loadClientWeek(
  q: Q,
  clientId: string,
  weekStart: string,
): Promise<{ input: WeekInput; orgId: string; siteIds: string[] } | null> {
  const [client] = await q`
    select c.org_id, c.name, o.name as org_name from public.clients c
    join public.organisations o on o.org_id = c.org_id where c.id = ${clientId}`;
  if (!client) return null;
  const sites = await q`select id, name, url from public.sites
    where client_id = ${clientId} and org_id = ${client.org_id} order by id`;
  if (sites.length === 0) return null;
  const siteIds = sites.map((s) => s.id as string);
  const from = new Date(`${weekStart}T00:00:00Z`);
  const to = new Date(from.getTime() + 7 * DAY_MS);
  const runs = await q`
    select r.id, r.site_id, r.started_at, (r.started_at < ${from}) as before from public.runs r
    where r.site_id = any(${siteIds}::uuid[]) and r.started_at < ${to}
      and (r.started_at >= ${from} or r.id = (select p.id from public.runs p where p.site_id = r.site_id
           and p.started_at < ${from} order by p.started_at desc, p.id desc limit 1))`;
  const findings = runs.length
    ? await q`select run_id, fingerprint, title, url, severity from public.findings
        where run_id = any(${runs.map((r) => r.id as string)}::uuid[])`
    : [];
  // run id -> its findings. A Map: one lookup per run instead of a scan of every finding.
  const byRun = new Map<string, WeekFinding[]>();
  for (const f of findings) {
    const list = byRun.get(f.run_id as string) ?? [];
    list.push({
      fingerprint: f.fingerprint as string,
      title: f.title as string,
      url: f.url as string,
      severity: f.severity as WeekFinding["severity"],
    });
    byRun.set(f.run_id as string, list);
  }
  const input: WeekInput = {
    agencyName: client.org_name as string,
    clientName: client.name as string,
    weekStart,
    sites: sites.map((s) => {
      const own = runs.filter((r) => r.site_id === s.id);
      const prior = own.find((r) => r.before === true);
      return {
        name: s.name as string,
        url: s.url as string,
        before: prior ? (byRun.get(prior.id as string) ?? []) : [],
        runs: own
          .filter((r) => r.before !== true)
          .map((r) => ({
            startedAt: (r.started_at as Date).toISOString(),
            findings: byRun.get(r.id as string) ?? [],
          })),
      };
    }),
  };
  return { input, orgId: client.org_id as string, siteIds };
}

/**
 * Draft this week's update for every client that has a site and none yet: one email draft in the inbox
 * (attached to the client's first site by id, since a draft names a site) and one weekly_updates row.
 * Run on Friday by the worker as service_role. Returns the new update ids; a second call adds none.
 */
export async function draftWeeklyUpdates(run: ServiceRunner, weekStart: string): Promise<string[]> {
  const clients = await run(
    (tx) => tx`select c.id from public.clients c
      where exists (select 1 from public.sites s where s.client_id = c.id)
        and not exists (select 1 from public.weekly_updates u where u.client_id = c.id and u.week_start = ${weekStart})
      order by c.org_id, c.id`,
  );
  const made: string[] = [];
  for (const c of clients) {
    const id = await run(async (tx) => {
      const week = await loadClientWeek(tx, c.id as string, weekStart);
      if (!week) return null;
      const text = composeWeeklyUpdate(week.input);
      const [draft] = await tx`insert into public.drafts (org_id, site_id, kind, payload)
        values (${week.orgId}, ${week.siteIds[0]!}, 'email', ${tx.json(text)}) returning id`;
      const [update] = await tx`insert into public.weekly_updates
          (org_id, client_id, week_start, site_ids, subject, body, draft_id)
        values (${week.orgId}, ${c.id as string}, ${weekStart}, ${week.siteIds}::uuid[], ${text.subject},
          ${text.body}, ${draft!.id as string}) returning id`;
      return update!.id as string;
    }).catch((e: unknown) => {
      // Another worker drafted this client's week first: its whole transaction (draft included) rolled back.
      if ((e as { code?: string }).code === "23505") return null;
      // Any other failure is this client's alone: log its id (never the error, which may quote text) and go on,
      // so one client cannot stop every later client's update.
      console.error(`weekly update not drafted for client ${c.id as string}`);
      return null;
    });
    if (id) made.push(id);
  }
  return made;
}

/**
 * Send every update a person has approved (or edited and approved) and that is not sent yet. Each one is a
 * transaction: the send record is written first (the database checks the approval and fills the approved
 * text), then the mailer sends that text, then it commits. A mailer failure rolls the record back, so the
 * update is tried again next time. Returns how many were sent.
 */
export async function sendApprovedUpdates(
  run: ServiceRunner,
  mailer: WeeklyMailer,
): Promise<number> {
  const ready = await run(
    (tx) => tx`select u.id, u.org_id, x.id as decision_id from public.weekly_updates u
      join public.decisions x on x.draft_id = u.draft_id and x.decision in ('approved', 'edited')
      where not exists (select 1 from public.weekly_update_sends s where s.update_id = u.id)
      order by u.created_at, u.id`,
  );
  let sent = 0;
  for (const u of ready) {
    await run(async (tx) => {
      const [row] = await tx`insert into public.weekly_update_sends (org_id, update_id, decision_id)
        values (${u.org_id as string}, ${u.id as string}, ${u.decision_id as string})
        on conflict (update_id) do nothing returning client_id, subject, body`;
      if (!row) return;
      const [org] =
        await tx`select name from public.organisations where org_id = ${u.org_id as string}`;
      await mailer.send({
        orgId: u.org_id as string,
        clientId: row.client_id as string,
        fromName: org!.name as string,
        subject: row.subject as string,
        body: row.body as string,
      });
      sent++;
    });
  }
  return sent;
}
