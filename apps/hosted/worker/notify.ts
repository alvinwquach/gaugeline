/**
 * Findings where the team already looks (X67): an organisation's own Slack channel (incoming webhook) or
 * Sentry project (DSN). The address is a secret: it is saved through the SecretStore (Vault, V-01) and read
 * back only here, in the worker, just before a send. Every send goes through core's one POST module
 * (notify/post.ts, ADR-0005) with publicOnly, after the address is checked again (checkDestination).
 *
 * A night's run queues one delivery per matching channel in the transaction that stores the run (an
 * outbox: a crash cannot lose it or send it twice), and deliverDue sends what is due. The delivery log
 * keeps a status, a count, an HTTP status and a short code: never an address, a header or a message body.
 * A channel that fails three deliveries in a row, or is refused outright (a revoked webhook), is disabled
 * with a reason; a test message that gets through turns it back on.
 *
 * An agent's message (AG-13 regression alert, AG-14 morning digest) is a delivery of kind "agent": agent-messages.ts
 * queues it and builds its words; the sending below is the same, to the same address, through the same POST module.
 * No other file sends it, and nothing here adds a host or a request of another shape.
 */
import { randomUUID } from "node:crypto";
import {
  type ChangedFinding,
  checkDestination,
  type Delivered,
  forSlackPlain,
  type NameResolver,
  type DestinationKind,
  postJson,
  sendWithRetry,
  sentryEvent,
  SEVERITY_ORDER,
  type Severity,
  slackChangesPayload,
} from "@gaugeline/core";
import { type Sql, type Tx, withService } from "../lib/api/db.js";
import { type AgentDelivery, agentBodies } from "./agent-messages.js";
import { SecretError, type SecretStore, secretStoreFrom } from "./secrets.js";

type PostResult = Awaited<ReturnType<typeof postJson>>;

export interface NotifyDeps {
  sql: Sql;
  secrets: SecretStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The hosted app's address, for the "Open in Gaugeline" link. */
  appUrl?: string;
  /** Tests map the vendor's host to a local stand-in; production posts with publicOnly. */
  send?: (endpoint: string, body: unknown, headers: Record<string, string>) => Promise<PostResult>;
  /** Tests only: the name lookup production's sender checks (node:dns lookup by default). */
  lookup?: NameResolver;
}

/**
 * The worker's notification set-up, called once at start-up next to the database check (V-01's required
 * item): a missing or wrong GAUGELINE_SECRET_STORE, or a vault store on a login that is not a member of
 * gaugeline_worker, stops the worker before its first job instead of failing a notification later.
 */
export async function notifyDepsFrom(
  env: Record<string, string | undefined>,
  sql: Sql,
): Promise<NotifyDeps> {
  const secrets = secretStoreFrom(env, sql);
  if (env.GAUGELINE_SECRET_STORE === "vault") {
    // Membership is not enough: the login must be allowed to SET the role (PG16 grants can say WITH SET
    // FALSE), and the role must be able to execute get_secret. Anything else fails closed, here.
    const usable = await sql`select
        pg_has_role(current_user, 'gaugeline_worker', 'SET') as can_set,
        has_function_privilege('gaugeline_worker', 'private.get_secret(uuid, text)', 'EXECUTE') as can_read`
      .then((r) => r[0]?.can_set === true && r[0]?.can_read === true)
      // A login that cannot even look (no usage on the schema) cannot use the role either.
      .catch(() => false);
    if (!usable)
      throw new Error(
        "the worker's database login cannot use gaugeline_worker to read notification addresses: grant the role with SET, and EXECUTE on private.get_secret to the role (docs/hosted/secrets.md)",
      );
  }
  return { sql, secrets, ...(env.GAUGELINE_APP_URL ? { appUrl: env.GAUGELINE_APP_URL } : {}) };
}

/** Deliveries in a row that fail after every retry before a channel is disabled. */
export const MAX_FAILURES = 3;
/** Sentry events per delivery: the most urgent new findings. */
const SENTRY_EVENTS = 10;

/** How long a claimed delivery may stay "sending" before another worker deals with it. */
export const SENDING_LEASE_MS = 30 * 60_000;
/** A delivery waits this long after the SecretStore could not answer, then tries again. */
export const SECRET_RETRY_MS = 15 * 60_000;
/** After this long without the SecretStore, a delivery is given up (failed), the channel left on. */
const SECRET_GIVE_UP_MS = 24 * 60 * 60_000;

/** Production's sender: the one POST module, refusing any address that is or resolves to a non-public one. */
const sender = (deps: NotifyDeps): NonNullable<NotifyDeps["send"]> =>
  deps.send ??
  ((endpoint, body, headers) =>
    postJson(endpoint, body, {
      headers,
      publicOnly: true,
      ...(deps.lookup ? { resolve: deps.lookup } : {}),
    }));

// --- Rules and quiet hours (pure) -------------------------------------------------------------------

export interface RuleFilter {
  minSeverity: Severity;
  checkIds: string[] | null;
}

export function matchesRule(rule: RuleFilter, f: { checkId: string; severity: Severity }): boolean {
  if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[rule.minSeverity]) return false;
  return rule.checkIds === null || rule.checkIds.includes(f.checkId);
}

/** The zone if this runtime knows it, else UTC (as the dashboard does): Postgres knows names ICU does not. */
function knownZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

function localHour(at: Date, zone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(at)
    .find((p) => p.type === "hour")?.value;
  return Number(h ?? "0");
}

/**
 * When a message may go: now, or the first minute after quiet hours end in the site's own zone. Hours are
 * whole local hours, start inclusive and end exclusive; a span that crosses midnight (22 to 7) works, and
 * the walk is by minute, so a clock change cannot skip or repeat the end hour.
 */
export function sendAfter(now: Date, zone: string, start: number | null, end: number | null): Date {
  if (start === null || end === null || start === end) return now;
  zone = knownZone(zone);
  const quiet = (h: number) => (start < end ? h >= start && h < end : h >= start || h < end);
  if (!quiet(localHour(now, zone))) return now;
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 26 * 60; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (!quiet(localHour(t, zone))) return t;
  }
  return now;
}

/** The delivery log's code for a send: never the error text, which names a host and could carry more. */
export function deliveryCode(r: Delivered): string | null {
  if (r.ok) return null;
  if (r.status !== undefined) return `http-${r.status}`;
  const e = r.error ?? "";
  if (e === "secret-unavailable" || e === "error") return e;
  if (/not a public address/.test(e)) return "address-refused";
  if (/did not answer/.test(e)) return "timeout";
  if (/could not be reached/.test(e)) return "unreachable";
  return "failed";
}

// --- Channels ---------------------------------------------------------------------------------------

export interface ChannelView {
  id: string;
  kind: DestinationKind;
  label: string;
  /** hooks.slack.com or the Sentry ingest host: the only part of the address anyone sees again. */
  host: string;
  status: "active" | "disabled";
  disabledReason: string | null;
}

const view = (r: Record<string, unknown>): ChannelView => ({
  id: r.id as string,
  kind: r.kind as DestinationKind,
  label: r.label as string,
  host: r.host as string,
  status: r.status as "active" | "disabled",
  disabledReason: (r.disabled_reason as string | null) ?? null,
});

/** Save a destination: check the address, put it in the SecretStore, then the row (name and host only). */
export async function saveChannel(
  deps: NotifyDeps,
  orgId: string,
  input: { kind: DestinationKind; label: string; address: string },
): Promise<{ ok: true; channel: ChannelView } | { ok: false; error: string }> {
  const label = input.label.replace(/\s+/g, " ").trim().slice(0, 80);
  if (label === "") return { ok: false, error: "give the channel a name" };
  const d = checkDestination(input.kind, input.address);
  if (!d.ok) return { ok: false, error: d.error };
  const secretName = `notify-${randomUUID().slice(0, 8)}`;
  try {
    await deps.secrets.put(orgId, secretName, "webhook_url", input.address.trim());
  } catch (e) {
    return {
      ok: false,
      error: e instanceof SecretError ? e.message : "the address could not be saved",
    };
  }
  try {
    const rows = await withService(
      deps.sql,
      (tx) => tx`insert into public.notification_channels (org_id, kind, label, host, secret_name)
        values (${orgId}, ${d.kind}, ${label}, ${d.host}, ${secretName})
        returning id, kind, label, host, status, disabled_reason`,
    );
    return { ok: true, channel: view(rows[0]!) };
  } catch {
    await deps.secrets.delete(orgId, secretName).catch(() => false);
    return { ok: false, error: "the channel could not be saved" };
  }
}

/** Remove a destination and its secret. */
export async function removeChannel(
  deps: NotifyDeps,
  orgId: string,
  channelId: string,
): Promise<boolean> {
  const rows = await withService(
    deps.sql,
    (
      tx,
    ) => tx`delete from public.notification_channels where id = ${channelId} and org_id = ${orgId}
      returning secret_name`,
  );
  if (rows.length === 0) return false;
  await deps.secrets.delete(orgId, rows[0]!.secret_name as string);
  return true;
}

// --- Queueing (inside the worker's run transaction) -------------------------------------------------

interface RuleRow extends RuleFilter {
  channelId: string;
  onlyChanges: boolean;
  quietStart: number | null;
  quietEnd: number | null;
}

async function rulesFor(tx: Tx, orgId: string, siteId: string): Promise<RuleRow[]> {
  const rows =
    await tx`select r.channel_id, r.min_severity, r.check_ids, r.only_changes, r.quiet_start,
      r.quiet_end
    from public.notification_rules r
    join public.notification_channels c on c.id = r.channel_id and c.org_id = r.org_id
    where r.org_id = ${orgId} and (r.site_id = ${siteId} or r.site_id is null) and c.status = 'active'
    order by r.channel_id, r.id`;
  return rows.map((r) => ({
    channelId: r.channel_id as string,
    minSeverity: r.min_severity as Severity,
    checkIds: (r.check_ids as string[] | null) ?? null,
    onlyChanges: r.only_changes as boolean,
    quietStart: (r.quiet_start as number | null) ?? null,
    quietEnd: (r.quiet_end as number | null) ?? null,
  }));
}

interface RunFindings {
  findings: ChangedFinding[];
  opened: Set<string>;
  closed: number;
  stillOpen: number;
}

async function runFindings(tx: Tx, runId: string): Promise<RunFindings> {
  const rows = await tx`select check_id, severity, title, evidence, url, fingerprint
    from public.findings where run_id = ${runId} order by id`;
  const change = await tx`select opened_fingerprints, closed, still_open from public.run_changes
    where run_id = ${runId}`;
  return {
    findings: rows.map((r) => ({
      checkId: r.check_id as string,
      severity: r.severity as Severity,
      title: r.title as string,
      evidence: r.evidence as string,
      fingerprint: r.fingerprint as string,
      ...(r.url ? { url: r.url as string } : {}),
    })),
    opened: new Set((change[0]?.opened_fingerprints as string[] | undefined) ?? []),
    closed: (change[0]?.closed as number | undefined) ?? 0,
    stillOpen: (change[0]?.still_open as number | undefined) ?? 0,
  };
}

/** The findings a channel gets for a run, by its rules: only new ones unless a rule says every night. */
function forChannel(
  rules: RuleRow[],
  run: RunFindings,
): { list: ChangedFinding[]; closed: number } {
  const list = run.findings.filter((f) =>
    rules.some((r) => (!r.onlyChanges || run.opened.has(f.fingerprint)) && matchesRule(r, f)),
  );
  return { list, closed: run.closed };
}

/**
 * Queue one delivery per active channel whose rules match something this run opened (or, for a rule
 * that is not "only what changed", anything it found). Idempotent per channel and run. Returns how many.
 */
export async function queueRunNotifications(
  tx: Tx,
  run: { orgId: string; siteId: string; runId: string; now: Date },
): Promise<number> {
  const rules = await rulesFor(tx, run.orgId, run.siteId);
  if (rules.length === 0) return 0;
  const found = await runFindings(tx, run.runId);
  const zone = (await tx`select timezone from public.sites where id = ${run.siteId}`)[0]
    ?.timezone as string;
  const byChannel = new Map<string, RuleRow[]>();
  for (const r of rules) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) ?? []), r]);
  let queued = 0;
  for (const [channelId, channelRules] of byChannel) {
    const { list } = forChannel(channelRules, found);
    if (list.length === 0) continue;
    // The latest end of the channel's quiet hours wins, so no rule's quiet time is broken.
    const at = channelRules
      .map((r) => sendAfter(run.now, zone, r.quietStart, r.quietEnd))
      .reduce((a, b) => (b > a ? b : a));
    const r = await tx`insert into public.notification_deliveries (org_id, channel_id, kind, run_id,
        site_id, send_after, findings)
      values (${run.orgId}, ${channelId}, 'run', ${run.runId}, ${run.siteId}, ${at}, ${list.length})
      on conflict (channel_id, run_id) do nothing returning id`;
    queued += r.length;
  }
  return queued;
}

// --- Sending ----------------------------------------------------------------------------------------

/** A delivery a worker has claimed. A row of kind "agent" (0016) says which agent message, never its words. */
type Claimed = AgentDelivery;

/** Build the bodies for one delivery: one Slack message, or one Sentry event per finding. */
async function bodies(
  deps: NotifyDeps,
  d: Claimed,
  kind: DestinationKind,
  label: string,
): Promise<{ bodies: unknown[]; findings: number }> {
  const now = (deps.now ?? (() => new Date()))();
  // An agent's message (AG-13, AG-14): its words are built here, as a night's findings are, and sent below
  // by the same loop through the same sender as everything else in this file.
  if (d.kind === "agent") return agentBodies(deps, d);
  if (d.kind === "test") {
    const testFinding: ChangedFinding = {
      checkId: "test-message",
      severity: "low",
      title: `Gaugeline test message for ${label}`,
      evidence: "If you can read this, findings will arrive here.",
      fingerprint: "test-message",
    };
    return {
      bodies: [
        kind === "slack"
          ? {
              text: `Gaugeline test message for ${forSlackPlain(label, 80)}: findings will arrive here.`,
            }
          : sentryEvent(testFinding, label, now),
      ],
      findings: 0,
    };
  }
  return withService(deps.sql, async (tx) => {
    const site = (await tx`select name, url from public.sites where id = ${d.siteId}`)[0];
    const rules = (await rulesFor(tx, d.orgId, d.siteId!)).filter(
      (r) => r.channelId === d.channelId,
    );
    const run = await runFindings(tx, d.runId!);
    const { list, closed } = forChannel(rules, run);
    if (list.length === 0) return { bodies: [], findings: 0 };
    if (kind === "slack")
      return {
        bodies: [
          slackChangesPayload(
            {
              site: site?.name as string,
              siteUrl: site?.url as string,
              opened: list,
              closed,
              stillOpen: run.stillOpen,
            },
            deps.appUrl ? `${deps.appUrl}/sites/${d.siteId}` : undefined,
          ),
        ],
        findings: list.length,
      };
    const urgent = [...list].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    return {
      bodies: urgent.slice(0, SENTRY_EVENTS).map((f) => sentryEvent(f, site?.name as string, now)),
      findings: list.length,
    };
  });
}

/** Send one claimed delivery and record the outcome on it and on its channel. */
async function deliver(deps: NotifyDeps, d: Claimed): Promise<Delivered> {
  const send = sender(deps);
  const chRows = await withService(
    deps.sql,
    (
      tx,
    ) => tx`select kind, label, secret_name, status, agent_messages from public.notification_channels
      where id = ${d.channelId} and org_id = ${d.orgId}`,
  );
  const ch = chRows[0];
  let outcome: Delivered;
  let findings = 0;
  // A channel that is off, or no longer takes agent messages, is not asked: not its fault, so no strike.
  if (
    !ch ||
    (ch.status !== "active" && d.kind !== "test") ||
    (d.kind === "agent" && ch.agent_messages !== true)
  ) {
    outcome = { ok: false, attempts: 0, error: "channel-disabled" };
  } else {
    let address: string | null;
    try {
      address = await deps.secrets.get(d.orgId, ch.secret_name as string);
    } catch {
      // The SecretStore did not answer (a Vault outage): not the channel's fault. Try again later.
      await requeueAfterSecretError(deps, d);
      return { ok: false, attempts: 0, error: "secret-unavailable" };
    }
    const dest = address ? checkDestination(ch.kind as DestinationKind, address) : undefined;
    if (!dest || !dest.ok) {
      outcome = { ok: false, attempts: 0, permanent: true, error: "not a public address" };
    } else {
      const built = await bodies(deps, d, dest.kind, ch.label as string);
      findings = built.findings;
      outcome = { ok: true, attempts: 0 };
      // Recorded before the first POST: a crash after this point is never sent again (at most once).
      if (built.bodies.length > 0)
        await withService(
          deps.sql,
          (tx) => tx`update public.notification_deliveries set attempts = 1 where id = ${d.id}`,
        );
      for (const body of built.bodies) {
        const r = await sendWithRetry(() => send(dest.endpoint, body, dest.headers), {
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        });
        outcome = { ...r, attempts: outcome.attempts + r.attempts };
        if (!r.ok) break;
      }
    }
  }
  const code = outcome.error === "channel-disabled" ? "channel-disabled" : deliveryCode(outcome);
  const now = (deps.now ?? (() => new Date()))();
  await withService(deps.sql, async (tx) => {
    await tx`update public.notification_deliveries set status = ${outcome.ok ? "sent" : "failed"},
        attempts = ${outcome.attempts}, http_status = ${outcome.status ?? null}, error_code = ${code},
        findings = ${findings}, sent_at = ${outcome.ok ? now : null}, locked_at = null
      where id = ${d.id}`;
    if (!ch || code === "channel-disabled") return;
    if (outcome.ok)
      await tx`update public.notification_channels set failures = 0, status = 'active',
          disabled_reason = null, disabled_at = null where id = ${d.channelId}`;
    else {
      const reason =
        code === "address-refused" ? "address-refused" : outcome.permanent ? "rejected" : null;
      await tx`update public.notification_channels set failures = failures + 1,
          status = case when ${reason}::text is not null or failures + 1 >= ${MAX_FAILURES}
            then 'disabled' else status end,
          disabled_reason = case when ${reason}::text is not null then ${reason}::text
            when failures + 1 >= ${MAX_FAILURES} then 'failed-repeatedly' else disabled_reason end,
          disabled_at = case when ${reason}::text is not null or failures + 1 >= ${MAX_FAILURES}
            then coalesce(disabled_at, ${now}) else disabled_at end
        where id = ${d.channelId}`;
    }
  });
  if (!outcome.ok)
    console.error(`notify: delivery ${d.id} to channel ${d.channelId} failed: ${code ?? "failed"}`);
  return outcome;
}

/** Claim the deliveries that are due (skip-locked, so two workers never send one twice) and send them. */
export async function deliverDue(deps: NotifyDeps, limit = 20): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  await reclaimStale(deps, now);
  const claimed = await withService(
    deps.sql,
    (tx) => tx`update public.notification_deliveries d set status = 'sending', locked_at = ${now}
      where d.id in (select id from public.notification_deliveries
        where status = 'queued' and send_after <= ${now}
        order by send_after, id limit ${limit} for update skip locked)
      returning id, org_id, channel_id, kind, run_id, site_id, agent_kind, subject_run_id,
        digest_date::text as digest_date`,
  );
  for (const r of claimed)
    await deliverSafely(deps, {
      id: r.id as string,
      orgId: r.org_id as string,
      channelId: r.channel_id as string,
      kind: r.kind as "run" | "test" | "agent",
      runId: (r.run_id as string | null) ?? null,
      siteId: (r.site_id as string | null) ?? null,
      agentKind: (r.agent_kind as Claimed["agentKind"]) ?? null,
      subjectRunId: (r.subject_run_id as string | null) ?? null,
      digestDate: (r.digest_date as string | null) ?? null,
    });
  return claimed.length;
}

/**
 * Rows a worker claimed and never finished (it crashed, or the database went away), past the lease. A row
 * whose POST had not started (attempts = 0) is queued again; one whose POST had started is marked failed
 * ("interrupted") and not sent again: the channel may already have it, and a duplicate is worse than a
 * gap the log shows. At most once.
 */
async function reclaimStale(deps: NotifyDeps, now: Date): Promise<void> {
  const before = new Date(now.getTime() - SENDING_LEASE_MS);
  await withService(
    deps.sql,
    (tx) => tx`update public.notification_deliveries
      set status = case when attempts = 0 then 'queued' else 'failed' end,
        error_code = case when attempts = 0 then error_code else 'interrupted' end,
        locked_at = null
      where status = 'sending' and locked_at < ${before}`,
  );
}

/** A delivery that throws (a bug, a lost connection) releases its row the same way, and never stops the rest. */
async function deliverSafely(deps: NotifyDeps, d: Claimed): Promise<Delivered> {
  try {
    return await deliver(deps, d);
  } catch {
    console.error(`notify: delivery ${d.id} to channel ${d.channelId} failed: error`);
    const now = (deps.now ?? (() => new Date()))();
    await withService(
      deps.sql,
      (tx) => tx`update public.notification_deliveries
        set status = case when attempts = 0 then 'queued' else 'failed' end,
          error_code = case when attempts = 0 then 'error' else 'interrupted' end,
          send_after = ${new Date(now.getTime() + SECRET_RETRY_MS)}, locked_at = null
        where id = ${d.id} and status = 'sending'`,
    ).catch(() => undefined);
    return { ok: false, attempts: 0, error: "error" };
  }
}

/** The SecretStore failed: queue the row again (channel untouched), or give up after a day. */
async function requeueAfterSecretError(deps: NotifyDeps, d: Claimed): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  console.error(`notify: delivery ${d.id} to channel ${d.channelId} waits: secret-unavailable`);
  await withService(
    deps.sql,
    (tx) => tx`update public.notification_deliveries
      set status = case when created_at < ${new Date(now.getTime() - SECRET_GIVE_UP_MS)}
          then 'failed' else 'queued' end,
        error_code = 'secret-unavailable', locked_at = null,
        send_after = ${new Date(now.getTime() + SECRET_RETRY_MS)}
      where id = ${d.id}`,
  );
}

/** The "Send test message" action: one message now, logged like any delivery. */
export async function sendTestMessage(
  deps: NotifyDeps,
  orgId: string,
  channelId: string,
): Promise<{ ok: boolean; code: string | null }> {
  const rows = await withService(
    deps.sql,
    (
      tx,
    ) => tx`insert into public.notification_deliveries (org_id, channel_id, kind, status, locked_at)
      select org_id, id, 'test', 'sending', now() from public.notification_channels
      where id = ${channelId} and org_id = ${orgId}
      returning id`,
  );
  if (rows.length === 0) return { ok: false, code: "no-channel" };
  const r = await deliverSafely(deps, {
    id: rows[0]!.id as string,
    orgId,
    channelId,
    kind: "test",
    runId: null,
    siteId: null,
    agentKind: null,
    subjectRunId: null,
    digestDate: null,
  });
  return { ok: r.ok, code: deliveryCode(r) };
}
