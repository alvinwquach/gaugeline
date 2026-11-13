/**
 * An agent's message in the worker (AG-13 and AG-14; ADR-0005, ADR-0014). Two messages, both plain code with
 * no model: the regression watcher's alert when a night's run got worse than the one before, and the morning
 * digest of the drafts waiting in the inbox. This file queues them and builds their words. It makes no
 * request: a queued row is sent by notify.ts's deliverDue, through the one sender every notification uses
 * (core's notify/post.ts), to the address on the channel and nowhere else.
 *
 * The outbox row (migration 0016) says WHICH message and what it is about, never the words. The words are
 * built here when the row is sent, from the organisation's own rows, so they are always that organisation's
 * and a stale queue cannot send stale text. An agent never queues a row: it returns text, and this file, which
 * runs as service_role in the worker, queues. A row is queued only for a Slack channel that takes agent
 * messages (`agent_messages`, off until the owner's app turns it on).
 *
 * What is page-derived is data: a finding's title and a draft's title are cleaned and cut by core's
 * sanitise (in the report and the digest) and escaped here for Slack, where a mention, a link or a bold
 * marker in them is plain text.
 */
import {
  type ApprovalsDigest,
  buildApprovalsDigest,
  buildRegressionReport,
  forSlack,
  forSlackPlain,
  redact,
  type RegressionReport,
  SEVERITY_LABEL,
} from "@gaugeline/core";
import { type Sql, type Tx, withService } from "../lib/api/db.js";
import { localMorning } from "./email/morning.js";
import { notRunIn } from "./diff.js";
import { sendAfter } from "./quiet-hours.js";

/** The words in a Slack section may be this long (Slack's own limit is 3000). */
const SECTION_MAX = 2800;
const LISTED = 8;
const MAX_PENDING_ROWS = 2000;
const HOUR_MS = 3_600_000;

type SlackBlock = { type: "section"; text: { type: "mrkdwn"; text: string } };
export interface SlackAgentPayload {
  text: string;
  blocks: SlackBlock[];
  /** Slack is asked to make no preview of any address in the message (unverified for webhooks, see the page). */
  unfurl_links: false;
  unfurl_media: false;
}

/** Cut a section without leaving half an entity (&am) or an open code span behind. */
const cut = (s: string, max = SECTION_MAX): string => {
  if (s.length <= max) return s;
  let out = s.slice(0, max - 2).replace(/&[a-z]{0,4}$/, "");
  if ((out.match(/`/g) ?? []).length % 2 === 1) out += "`";
  return `${out}\u2026`;
};
const section = (text: string): SlackBlock => ({
  type: "section",
  text: { type: "mrkdwn", text: cut(text) },
});
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SITE_NAME_MAX = 80;
const TITLE_MAX = 120;

/**
 * Text from a page or from an agent, made safe to show in Slack. Two layers: an address in it is defanged
 * (its scheme is written `scheme[:]//` and `www.` as `www[.]`), and the whole text goes inside a code span,
 * where Slack makes no link of a bare address, a domain or a mention. Characters that mean something to
 * Slack (&, <, >) are entities, and a backtick in the text cannot close the span (forSlack makes it an
 * apostrophe). The only links in a message are the ones this file builds from the app's own address.
 */
const defang = (t: string): string =>
  t.replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, "$1[:]//").replace(/\bwww\./gi, "www[.]");
const untrusted = (t: string, max: number): string => `\`${forSlack(defang(t), max)}\``;
/** The same text for a place that cannot hold a span (Slack's plain notification line). */
const plain = (t: string, max: number): string => forSlackPlain(defang(t), max);

/** What each message carries about the message itself. Links off, so no address gets a preview. */
const payload = (text: string, blocks: SlackBlock[]): SlackAgentPayload => ({
  text,
  blocks,
  unfurl_links: false,
  unfurl_media: false,
});

/** At most this many alerts a channel is sent in a day: many sites worse in one night are not many pings. */
export const ALERTS_PER_CHANNEL_PER_DAY = 10;

// --- The two Slack messages (pure) ------------------------------------------------------------------

/**
 * The alert for a report that got worse: what went up, what is new, how many were fixed. `capped` adds the
 * line saying this channel's allowance of alerts for the day is used.
 */
export function slackRegressionPayload(
  report: RegressionReport,
  siteName: string,
  siteLink?: string,
  capped = false,
): SlackAgentPayload {
  const worse = report.counts.added + report.counts.worsened;
  const what = `${plural(worse, "finding", "findings")} got worse`;
  const blocks: SlackBlock[] = [
    section(`*Gaugeline*: ${untrusted(siteName, SITE_NAME_MAX)}: *${what}*`),
  ];
  const up = report.worsened
    .slice(0, LISTED)
    .map(
      (w) =>
        `*${SEVERITY_LABEL[w.severity]}* (was ${SEVERITY_LABEL[w.from]}): ${untrusted(w.title, TITLE_MAX)}`,
    );
  if (up.length > 0) {
    const more = report.counts.worsened - up.length;
    blocks.push(
      section(["Went up in severity", ...up, ...(more > 0 ? [`and ${more} more`] : [])].join("\n")),
    );
  }
  const fresh = report.added
    .slice(0, LISTED)
    .map((a) => `*${SEVERITY_LABEL[a.severity]}*: ${untrusted(a.title, TITLE_MAX)}`);
  if (fresh.length > 0) {
    const more = report.counts.added - fresh.length;
    blocks.push(section(["New", ...fresh, ...(more > 0 ? [`and ${more} more`] : [])].join("\n")));
  }
  const tail = [
    report.counts.resolved > 0 ? `${report.counts.resolved} fixed since the last run` : "",
    capped
      ? `This channel gets at most ${ALERTS_PER_CHANNEL_PER_DAY} alerts a day: other sites may have got worse too`
      : "",
    siteLink ? `<${siteLink}|Open in Gaugeline>` : "",
  ].filter((t) => t !== "");
  if (tail.length > 0) blocks.push(section(tail.join(" \u00B7 ")));
  return payload(`Gaugeline: ${plain(siteName, SITE_NAME_MAX)}: ${what}`, blocks);
}

/** The morning digest: the headline, the busiest sites, and the drafts that need a decision first. */
export function slackDigestPayload(d: ApprovalsDigest): SlackAgentPayload {
  const head = `Gaugeline: ${d.headline}`;
  const blocks: SlackBlock[] = [section(`*${head}*`)];
  const sites = d.sites.slice(0, LISTED).map((s) => {
    const name = s.name === null ? `Site ${s.siteId.slice(0, 8)}` : s.name;
    const parts = [
      plural(s.pending, "draft waits", "drafts wait"),
      s.overdue > 0 ? `${s.overdue} older than ${d.staleAfterHours} h` : "",
      s.expiring > 0 ? `${s.expiring} expire within ${d.expiringWithinHours} h` : "",
    ].filter((p) => p !== "");
    return `${untrusted(name, SITE_NAME_MAX)}: ${parts.join(", ")}`;
  });
  if (sites.length > 0) {
    const more = d.sites.length - sites.length;
    blocks.push(section([...sites, ...(more > 0 ? [`and ${more} more sites`] : [])].join("\n")));
  }
  const items = d.attention.slice(0, LISTED).map((i) => {
    const left =
      i.hoursLeft === 0 ? "under 1 hour left" : `${plural(i.hoursLeft, "hour", "hours")} left`;
    const link = i.link ? ` <${i.link}|Open>` : "";
    return `${i.kind.replace("_", " ")}, ${plural(i.ageHours, "hour", "hours")} old, ${left}: ${untrusted(i.title, TITLE_MAX)}${link}`;
  });
  if (items.length > 0) {
    const more = d.attention.length - items.length + d.attentionOmitted;
    blocks.push(
      section(
        [
          "Needs a decision first",
          ...items,
          ...(more > 0 ? [`and ${more} more in the inbox`] : []),
        ].join("\n"),
      ),
    );
  }
  const tail = [
    d.totals.expired > 0
      ? `${plural(d.totals.expired, "draft", "drafts")} passed the 72-hour window and can no longer be approved`
      : "",
    d.inboxUrl ? `<${d.inboxUrl}|Open the inbox>` : "",
    "Nothing here approves anything: a person decides each draft",
  ].filter((t) => t !== "");
  blocks.push(section(tail.join(" \u00B7 ")));
  return payload(head, blocks);
}

// --- Which channels take them -----------------------------------------------------------------------

/** Turn agent messages on or off for one Slack channel of the organisation. The database refuses Sentry. */
export async function setAgentMessages(
  deps: { sql: Sql },
  orgId: string,
  channelId: string,
  on: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await withService(
    deps.sql,
    (tx) =>
      tx`select kind from public.notification_channels where id = ${channelId} and org_id = ${orgId}`,
  );
  if (rows.length === 0) return { ok: false, error: "no such channel" };
  if (on && rows[0]!.kind !== "slack")
    return { ok: false, error: "only a Slack channel takes agent messages" };
  await withService(
    deps.sql,
    (tx) => tx`update public.notification_channels set agent_messages = ${on}
      where id = ${channelId} and org_id = ${orgId}`,
  );
  return { ok: true };
}

const channelsFor = (tx: Tx, orgId: string) =>
  tx`select id from public.notification_channels
    where org_id = ${orgId} and kind = 'slack' and status = 'active' and agent_messages
    order by id`;

// --- The regression alert ---------------------------------------------------------------------------

interface RunSide {
  id: string;
  startedAt: string;
}

/**
 * The run before this one: the last a worker made for the site (an upload from the customer's CI is never
 * "last night"). The same rule the run's own change summary uses (worker.ts).
 */
async function previousWorkerRun(
  tx: Tx,
  runId: string,
): Promise<{ run: RunSide; summary: unknown } | null> {
  const prev = await tx`select r.id, r.summary,
      to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started
    from public.runs r, public.runs cur
    where cur.id = ${runId} and r.site_id = cur.site_id and r.id <> cur.id
      and (r.started_at, r.id) < (cur.started_at, cur.id)
      and exists (select 1 from public.jobs j
        where j.run_id = r.id and j.site_id = r.site_id and j.status = 'done')
    order by r.started_at desc, r.id desc limit 1`;
  return prev[0]
    ? {
        run: { id: prev[0].id as string, startedAt: prev[0].started as string },
        summary: prev[0].summary,
      }
    : null;
}

/**
 * Tonight's run against the one before it, by finding fingerprint and severity. Findings of a check that
 * did not run in one of the two runs are left out of both (a crashed check is not a regression), as the
 * run's own change summary does. Null when there is no earlier run.
 */
export async function regressionReportFor(tx: Tx, runId: string): Promise<RegressionReport | null> {
  const prev = await previousWorkerRun(tx, runId);
  if (!prev) return null;
  const [cur] = await tx`select summary,
      to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started
    from public.runs where id = ${runId}`;
  if (!cur) return null;
  const skipped = new Set([...notRunIn(prev.summary), ...notRunIn(cur.summary)]);
  const rows = async (id: string) =>
    (
      await tx`select check_id, fingerprint, severity, title from public.findings where run_id = ${id}`
    )
      .filter((r) => !skipped.has(r.check_id as string))
      .map((r) => ({
        id: r.fingerprint as string,
        severity: r.severity as string,
        title: r.title as string,
      }));
  return buildRegressionReport(
    { runId: prev.run.id, takenAt: prev.run.startedAt, findings: await rows(prev.run.id) },
    { runId, takenAt: cur.started as string, findings: await rows(runId) },
  );
}

/**
 * Alerts already queued or sent for a channel in the day around `at`: the allowance is counted on when the
 * alert is due (send_after), a day either side of the time asked about.
 */
async function alertsForChannel(tx: Tx, channelId: string, at: Date): Promise<number> {
  const rows = await tx`select count(*)::int as n from public.notification_deliveries
    where channel_id = ${channelId} and agent_kind = 'regression-alert'
      and send_after > ${new Date(at.getTime() - 24 * HOUR_MS)}
      and send_after <= ${new Date(at.getTime() + 24 * HOUR_MS)}`;
  return rows[0]!.n as number;
}

/**
 * In the transaction that stores a night's run: when the run got worse than the one before, queue one alert
 * per channel that takes agent messages, if the channel has not had its ${ALERTS_PER_CHANNEL_PER_DAY} for the
 * day. Nothing when it did not get worse, so a quiet night sends nothing. An alert waits for the end of the
 * quiet hours of the channel's rules for the site (the same rule findings follow), and is idempotent per
 * channel and run. Returns how many rows it queued.
 */
export async function queueRegressionAlert(
  tx: Tx,
  run: { orgId: string; siteId: string; runId: string; now: Date },
): Promise<number> {
  const channels = await channelsFor(tx, run.orgId);
  if (channels.length === 0) return 0;
  const report = await regressionReportFor(tx, run.runId);
  if (!report || !report.worse) return 0;
  const worse = report.counts.added + report.counts.worsened;
  const zone = (await tx`select timezone from public.sites where id = ${run.siteId}`)[0]
    ?.timezone as string | undefined;
  let queued = 0;
  for (const c of channels) {
    if ((await alertsForChannel(tx, c.id as string, run.now)) >= ALERTS_PER_CHANNEL_PER_DAY)
      continue;
    // The latest end of the channel's quiet hours wins, so no rule's quiet time is broken.
    const rules = await tx`select quiet_start, quiet_end from public.notification_rules
      where channel_id = ${c.id} and org_id = ${run.orgId} and (site_id = ${run.siteId} or site_id is null)`;
    const at = rules
      .map((r) =>
        sendAfter(
          run.now,
          zone ?? "UTC",
          (r.quiet_start as number | null) ?? null,
          (r.quiet_end as number | null) ?? null,
        ),
      )
      .reduce((a, b) => (b > a ? b : a), run.now);
    const r =
      await tx`insert into public.notification_deliveries (org_id, channel_id, kind, site_id, agent_kind,
        subject_run_id, send_after, findings)
      values (${run.orgId}, ${c.id}, 'agent', ${run.siteId}, 'regression-alert', ${run.runId}, ${at}, ${worse})
      on conflict do nothing returning id`;
    queued += r.length;
  }
  return queued;
}

// --- The morning digest -----------------------------------------------------------------------------

/** The drafts of the organisation waiting for a decision, as the digest reads them (the inbox's own rule). */
async function pendingDrafts(tx: Tx, orgId: string, now: Date) {
  const rows = await tx`select d.id, d.site_id, d.kind, d.title,
      to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created,
      to_char((d.created_at + interval '72 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires
    from (
      select x.id, x.site_id, x.kind, x.created_at,
        case x.kind
          when 'email' then x.payload ->> 'subject'
          when 'pull_request' then x.payload ->> 'title'
          when 'sanity_draft' then (x.payload ->> 'documentType') || ' ' || (x.payload ->> 'documentId')
        end as title
      from public.drafts x
      where x.org_id = ${orgId} and x.created_at > ${new Date(now.getTime() - 72 * HOUR_MS)}
        and not exists (select 1 from public.decisions y where y.draft_id = x.id)
      order by x.created_at desc, x.id desc
      limit ${MAX_PENDING_ROWS}
    ) d`;
  return rows.map((r) => ({
    id: r.id as string,
    siteId: r.site_id as string,
    kind: r.kind as string,
    // A draft's title is an agent's words: key-shaped strings out, as in the agent reads (AG-08).
    title: redact((r.title as string | null) ?? ""),
    createdAt: r.created as string,
    expiresAt: r.expires as string,
  }));
}

const validApp = (appUrl: string | undefined): string | undefined => {
  if (!appUrl) return undefined;
  try {
    buildApprovalsDigest([], new Date(0), { appUrl });
    return appUrl;
  } catch {
    return undefined;
  }
};

/**
 * The morning step: for each organisation with a channel that takes agent messages, when it is 07:00 to 11:00
 * where most of its sites are, and a draft is waiting, queue that day's digest for each such channel. One
 * per channel per local day (the database's unique index), so looking again, a restart or a second worker
 * is one row. The clock is a parameter. Returns how many rows it queued.
 */
export async function queueMorningDigests(sql: Sql, now: Date): Promise<number> {
  const orgs = await withService(
    sql,
    (tx) => tx`select c.org_id, z.zone
      from (select distinct org_id from public.notification_channels
        where kind = 'slack' and status = 'active' and agent_messages) c
      left join lateral (
        select mode() within group (order by s.timezone) as zone
        from public.sites s where s.org_id = c.org_id and s.active
      ) z on true`,
  );
  let queued = 0;
  for (const o of orgs) {
    const morning = localMorning(now, (o.zone as string | null) ?? "UTC");
    if (!morning?.due) continue;
    queued += await withService(sql, async (tx) => {
      const orgId = o.org_id as string;
      const waiting = await tx`select 1 from public.drafts x
        where x.org_id = ${orgId} and x.created_at > ${new Date(now.getTime() - 72 * HOUR_MS)}
          and not exists (select 1 from public.decisions y where y.draft_id = x.id) limit 1`;
      if (waiting.length === 0) return 0;
      let n = 0;
      for (const c of await channelsFor(tx, orgId)) {
        const r =
          await tx`insert into public.notification_deliveries (org_id, channel_id, kind, agent_kind,
            digest_date, send_after)
          values (${orgId}, ${c.id}, 'agent', 'approvals-digest', ${morning.localDate}, ${now})
          on conflict do nothing returning id`;
        n += r.length;
      }
      return n;
    });
  }
  return queued;
}

// --- Building the words at send time ----------------------------------------------------------------

/** The part of a claimed delivery this file needs. */
export interface AgentDelivery {
  id: string;
  orgId: string;
  channelId: string;
  kind: "run" | "test" | "agent";
  runId: string | null;
  siteId: string | null;
  agentKind: "regression-alert" | "approvals-digest" | null;
  subjectRunId: string | null;
  digestDate: string | null;
}

/**
 * The Slack message for one claimed agent delivery, rebuilt from the organisation's rows, or none: a run that
 * is gone, a night that is no longer worse, or a digest with nothing waiting is sent as nothing (the row is
 * logged as sent with 0). Not an agent row: none.
 */
export async function agentBodies(
  deps: { sql: Sql; now?: () => Date; appUrl?: string },
  d: AgentDelivery,
): Promise<{ bodies: unknown[]; findings: number }> {
  if (d.kind !== "agent") return { bodies: [], findings: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const appUrl = validApp(deps.appUrl);
  if (d.agentKind === "regression-alert" && d.subjectRunId && d.siteId)
    return withService(deps.sql, async (tx) => {
      const report = await regressionReportFor(tx, d.subjectRunId!);
      if (!report?.worse) return { bodies: [], findings: 0 };
      const site = (
        await tx`select name from public.sites where id = ${d.siteId} and org_id = ${d.orgId}`
      )[0];
      if (!site) return { bodies: [], findings: 0 };
      return {
        bodies: [
          slackRegressionPayload(
            report,
            site.name as string,
            appUrl ? `${appUrl}/sites/${d.siteId}` : undefined,
            // The channel's allowance for the day is used: say that other sites may have got worse too.
            (await alertsForChannel(tx, d.channelId, now)) >= ALERTS_PER_CHANNEL_PER_DAY,
          ),
        ],
        findings: report.counts.added + report.counts.worsened,
      };
    });
  if (d.agentKind === "approvals-digest")
    return withService(deps.sql, async (tx) => {
      const drafts = await pendingDrafts(tx, d.orgId, now);
      const names = new Map(
        (await tx`select id, name from public.sites where org_id = ${d.orgId}`).map((s) => [
          s.id as string,
          s.name as string,
        ]),
      );
      const digest = buildApprovalsDigest(drafts, now, {
        ...(appUrl ? { appUrl } : {}),
        siteNames: names,
      });
      return digest.totals.pending === 0
        ? { bodies: [], findings: 0 }
        : { bodies: [slackDigestPayload(digest)], findings: digest.totals.pending };
    });
  return { bodies: [], findings: 0 };
}
