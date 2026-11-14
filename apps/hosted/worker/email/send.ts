/**
 * The morning email step of the worker (X64). Each pass finds the people it is morning for (07:00 to 11:00
 * where they are), reads what changed for their organisation since their last email, and sends one
 * message. It sends nothing when nothing changed, and a person gets at most one a day per organisation.
 *
 * The digest of the drafts waiting in the inbox (AG-14) rides in the same email: one message a day, built
 * from counts, draft titles and ids, never a draft's body. It is read in the same transaction as the plan.
 *
 * Sending goes through `Sender`. In production that is core's notifier (postEmail in
 * packages/core/src/notify/email.ts, ADR-0005): this file makes no request of its own. The key comes from
 * the environment only (RESEND_API_KEY), is held by the sender closure and goes nowhere else: not into
 * the database, a log or an error.
 *
 * Once a day is a fact the database keeps. email_sends has one row per person, organisation and local day
 * (its primary key). The claim is an insert (or taking back a row that failed and may be retried); only
 * the worker whose claim succeeds sends. A crash after the claim leaves the row 'sending', and it is never
 * sent again: one missed morning is better than two copies. Every query runs as service_role in its own
 * transaction, as the rest of the worker does.
 */
import {
  buildApprovalsDigest,
  EMAIL_FROM_ENV,
  postEmail,
  RESEND_KEY_ENV,
  type ApprovalsDigest,
  type BuiltEmail,
} from "@gaugeline/core";
import { type Sql, type Tx, withService } from "../../lib/api/db.js";
import { pendingDrafts } from "../agent-messages.js";
import { checkTokenSecret, signToken, TOKEN_SECRET_ENV } from "../../lib/email/token.js";
import {
  buildMorningEmail,
  effectiveFrequency,
  forFrequency,
  httpsAddress,
  localMorning,
  mergeBySite,
  waitingFor,
  type ChangeRow,
  type Frequency,
  type Role,
} from "./morning.js";

export interface SendRequest {
  /** The address on the member's row: never anything from a page. */
  to: string;
  mail: BuiltEmail;
  /** The same for every attempt at one person's email of one local day: the provider drops a repeat. */
  idempotencyKey?: string;
}
export type Sender = (
  req: SendRequest,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

export interface MorningDeps {
  sql: Sql;
  send: Sender;
  /** Where the dashboard is (configuration). */
  dashboardUrl: string;
  /** Where the preference page is; the dashboard's address when the app is served from the same place. */
  appUrl?: string;
  /** Signs the preference link (GAUGELINE_EMAIL_TOKEN_SECRET). */
  tokenSecret: string;
  /** Why this pass sends nothing (a fixed code, never a message): set while the sender domain is the placeholder. */
  refusal?: string;
}

export interface MorningReport {
  sent: number;
  failed: number;
  /** Set when the pass was refused before it read anything (MorningDeps.refusal). */
  refused?: string;
}

/** A failed send is tried again after 10 minutes, then 20, and gives up after the third attempt. */
export const MAX_SEND_ATTEMPTS = 3;
const RETRY_STEP_MS = 10 * 60_000;
/** Runs written in the last two minutes are left for the next email: a transaction may still be open. */
const SETTLE_MS = 2 * 60_000;
/** The most a first email, or one after a long gap, looks back. */
const FIRST_LOOKBACK_MS = 86_400_000;
const MAX_LOOKBACK_MS = 3 * 86_400_000;

/**
 * The domain every hosted email is sent from until the owner swaps it. `.invalid` is reserved (RFC 2606): it
 * cannot be registered or delivered to, so nothing can leave from a real domain by accident. To go live, set
 * GAUGELINE_EMAIL_FROM to an address on a domain verified in Resend (docs/hosted/morning-email.md).
 */
export const MAIL_DOMAIN_PLACEHOLDER = "mail.gaugeline.invalid";
export const DEFAULT_MAIL_FROM = `Gaugeline <morning@${MAIL_DOMAIN_PLACEHOLDER}>`;
/** The fixed result of a send refused for its sender: no request was made. */
export const SENDER_NOT_CONFIGURED = "sender-domain-not-configured";

/** Characters that cannot be in a sender: controls, and the invisible and direction marks that look like text. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/;

/** `Name <a@b.c>` or `a@b.c`: the raw domain, or null when it is not an address. */
function domainOf(from: string): string | null {
  const t = from.trim();
  const m = /<([^<>\s@]+@([^<>\s@]+))>$/.exec(t) ?? /^([^<>\s@]+@([^<>\s@]+))$/.exec(t);
  return m ? m[2]! : null;
}

/**
 * The sender, and whether it is one a real message may go from. The domain is normalised first (lower case,
 * trailing dots dropped) and must be plain ASCII letters, digits, hyphens and dots. Not configured: unset (the
 * placeholder), the placeholder or any name under it or under `.invalid`, Resend's shared test domain
 * `resend.dev` and anything under it (it delivers only to its own account, not to a member), a value with a
 * control, hidden or direction character anywhere (a header cannot be injected through the display name), or
 * something that is not an address.
 */
export function mailFrom(env: Record<string, string | undefined>): {
  from: string;
  configured: boolean;
} {
  const from = env[EMAIL_FROM_ENV]?.trim() ?? "";
  if (from === "") return { from: DEFAULT_MAIL_FROM, configured: false };
  const raw = HIDDEN.test(from) ? null : domainOf(from);
  const domain = raw?.toLowerCase().replace(/\.+$/, "") ?? null;
  const plain =
    domain !== null &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain) &&
    !/(^|\.)-|-(\.|$)/.test(domain);
  const under = (d: string, root: string) => d === root || d.endsWith(`.${root}`);
  const fake =
    !plain ||
    under(domain!, MAIL_DOMAIN_PLACEHOLDER) ||
    under(domain!, "invalid") ||
    under(domain!, "resend.dev");
  return { from, configured: !fake };
}

/** The notifier a Sender posts with. Production is core's postEmail; a test passes one that stands in. */
export type PostEmail = typeof postEmail;

/**
 * Core's notifier as a Sender. The key is captured here and sent in the Authorization header by
 * postEmail, which also scrubs it from any error. Null when no key is set: the step is then off. While the
 * sender domain is not configured the Sender makes no request and answers SENDER_NOT_CONFIGURED. The settings
 * it posts with are fixed here: the address is core's api.resend.com constant, no endpoint can be set, and a
 * name that resolves to a private address is refused (`publicOnly`). `post` is for tests only.
 */
export function resendSender(
  env: Record<string, string | undefined>,
  post: PostEmail = postEmail,
): Sender | null {
  const apiKey = env[RESEND_KEY_ENV]?.trim();
  if (!apiKey) return null;
  const { from, configured } = mailFrom(env);
  return async ({ to, mail, idempotencyKey }) => {
    if (!configured) return { ok: false, error: SENDER_NOT_CONFIGURED };
    return post(
      { to: [to], apiKey, from, publicOnly: true, ...(idempotencyKey ? { idempotencyKey } : {}) },
      mail,
    );
  };
}

export const DASHBOARD_URL_ENV = "GAUGELINE_DASHBOARD_URL";
export const APP_URL_ENV = "GAUGELINE_APP_URL";
/** How often the worker looks for people whose morning it is. */
export const MORNING_EVERY_MS = 5 * 60_000;

/**
 * The morning email's settings from the environment, or null when no Resend key is set (the step is off).
 * A key with a missing or wrong address or secret stops the worker at start-up, so a half-set-up email
 * never fails quietly at 07:00.
 */
export function morningFromEnv(
  sql: Sql,
  env: Record<string, string | undefined>,
  post?: PostEmail,
): MorningDeps | null {
  const send = resendSender(env, post);
  if (!send) return null;
  const dashboardUrl = httpsAddress(env[DASHBOARD_URL_ENV] ?? "", DASHBOARD_URL_ENV);
  const appUrl = env[APP_URL_ENV] ? httpsAddress(env[APP_URL_ENV]!, APP_URL_ENV) : undefined;
  return {
    sql,
    send,
    dashboardUrl,
    ...(appUrl ? { appUrl } : {}),
    tokenSecret: checkTokenSecret(env[TOKEN_SECRET_ENV]),
    ...(mailFrom(env).configured ? {} : { refusal: SENDER_NOT_CONFIGURED }),
  };
}

interface Recipient {
  orgId: string;
  userId: string;
  role: Role;
  orgName: string;
  email: string;
  frequency: Frequency | null;
  zone: string;
}

/** Owners, admins and members with a confirmed address that has not bounced. Never a client viewer. */
async function recipients(sql: Sql): Promise<Recipient[]> {
  const rows = await withService(
    sql,
    (tx) => tx`select m.org_id, m.user_id, m.role, o.name as org_name, p.email, p.frequency,
        coalesce(p.timezone, z.zone, 'UTC') as zone
      from public.members m
      join public.email_preferences p on p.org_id = m.org_id and p.user_id = m.user_id
      join public.organisations o on o.org_id = m.org_id
      left join lateral (
        select mode() within group (order by s.timezone) as zone
        from public.sites s where s.org_id = m.org_id and s.active
      ) z on true
      where m.role in ('owner', 'admin', 'member')
        and p.email is not null and p.email_confirmed_at is not null and p.bounced_at is null`,
  );
  return rows.map((r) => ({
    orgId: r.org_id as string,
    userId: r.user_id as string,
    role: r.role as Role,
    orgName: r.org_name as string,
    email: r.email as string,
    frequency: (r.frequency as Frequency | null) ?? null,
    zone: r.zone as string,
  }));
}

interface Window {
  from: Date;
  to: Date;
}

/** Today's row, if any, and whether this pass may (re)try it. */
async function todaysRow(tx: Tx, r: Recipient, day: string) {
  const rows = await tx`select status, attempts, retry_after, covers_from, covers_to
    from public.email_sends
    where org_id = ${r.orgId} and user_id = ${r.userId} and local_date = ${day} and kind = 'morning'`;
  return rows[0] as
    | {
        status: string;
        attempts: number;
        retry_after: Date | null;
        covers_from: Date;
        covers_to: Date;
      }
    | undefined;
}

/** The end of the last email that was sent to this person for this organisation, or null if none was. */
async function lastSentAt(tx: Tx, r: Recipient): Promise<Date | null> {
  const last = await tx`select max(covers_to) as at from public.email_sends
    where org_id = ${r.orgId} and user_id = ${r.userId} and kind = 'morning' and status = 'sent'`;
  return (last[0]?.at as Date | null) ?? null;
}

/** From the end of the last email that was sent (at most three days back) to two minutes ago. */
async function windowFor(tx: Tx, r: Recipient, now: Date): Promise<Window> {
  const to = new Date(now.getTime() - SETTLE_MS);
  const since = (await lastSentAt(tx, r)) ?? new Date(to.getTime() - FIRST_LOOKBACK_MS);
  return { from: new Date(Math.max(since.getTime(), to.getTime() - MAX_LOOKBACK_MS)), to };
}

/** What changed in the organisation's sites in the window: counts, and the most urgent new title. */
async function readChanges(tx: Tx, r: Recipient, w: Window): Promise<ChangeRow[]> {
  const rows = await tx`select rc.site_id, s.name as site_name, rc.opened, rc.closed,
      (select count(distinct f.fingerprint)::int from public.findings f
        where f.run_id = rc.run_id and f.fingerprint = any(rc.opened_fingerprints)
          and f.severity = 'high') as opened_high,
      (select f.title from public.findings f
        where f.run_id = rc.run_id and f.fingerprint = any(rc.opened_fingerprints)
        order by case f.severity when 'high' then 0 when 'medium' then 1 else 2 end, f.id
        limit 1) as top_title
    from public.run_changes rc
    join public.sites s on s.id = rc.site_id and s.org_id = rc.org_id
    where rc.org_id = ${r.orgId} and s.active and rc.created_at > ${w.from} and rc.created_at <= ${w.to}
    order by rc.created_at, rc.id`;
  return rows.map((x) => ({
    siteId: x.site_id as string,
    siteName: x.site_name as string,
    opened: x.opened as number,
    openedHigh: x.opened_high as number,
    closed: x.closed as number,
    topTitle: (x.top_title as string | null) ?? null,
  }));
}

/** Insert today's row, or take back one that failed and may be retried. True only for the one claimer. */
async function claim(
  tx: Tx,
  r: Recipient,
  day: string,
  w: Window,
  now: Date,
): Promise<number | null> {
  const rows =
    await tx`insert into public.email_sends (org_id, user_id, local_date, covers_from, covers_to)
    values (${r.orgId}, ${r.userId}, ${day}, ${w.from}, ${w.to})
    on conflict (org_id, user_id, local_date, kind) do update
      set status = 'sending', attempts = public.email_sends.attempts + 1, last_error = null,
        retry_after = null
      where public.email_sends.status = 'failed' and public.email_sends.retry_after <= ${now}
        and public.email_sends.attempts < ${MAX_SEND_ATTEMPTS}
    returning attempts`;
  return rows.length === 1 ? (rows[0]!.attempts as number) : null;
}

/** A short code for the log, and whether trying again could help. Never the provider's words. */
function failure(res: { status?: number; error?: string } | "threw"): {
  code: string;
  retry: boolean;
} {
  if (res === "threw") return { code: "send-threw", retry: true };
  if (res.error === SENDER_NOT_CONFIGURED) return { code: SENDER_NOT_CONFIGURED, retry: false };
  if (res.status === undefined) return { code: "unreachable", retry: true };
  if (res.status === 429 || res.status >= 500) return { code: "provider-busy", retry: true };
  return { code: "rejected", retry: false };
}

/** The inbox's waiting drafts as the digest reads them. A malformed app address leaves the links out. */
function digestOf(drafts: Awaited<ReturnType<typeof pendingDrafts>>, now: Date, base: string) {
  try {
    return buildApprovalsDigest(drafts, now, { appUrl: base });
  } catch {
    return buildApprovalsDigest(drafts, now);
  }
}

/** One pass: send the morning email to everyone it is due for. Never throws for one person's failure. */
export async function sendMorningEmails(deps: MorningDeps, now: Date): Promise<MorningReport> {
  const report: MorningReport = { sent: 0, failed: 0 };
  // Fail closed before anything is read or claimed: a refused morning is not used up, so the same morning
  // still goes out once the sender is configured.
  if (deps.refusal) return { ...report, refused: deps.refusal };
  const base = deps.appUrl ?? deps.dashboardUrl;
  for (const r of await recipients(deps.sql)) {
    try {
      const morning = localMorning(now, r.zone);
      if (!morning?.due) continue;
      const frequency = effectiveFrequency(r.frequency, r.role);
      if (frequency === "off") continue;
      const day = morning.localDate;

      const plan = await withService(deps.sql, async (tx) => {
        const had = await todaysRow(tx, r, day);
        if (
          had &&
          !(
            had.status === "failed" &&
            had.retry_after !== null &&
            had.retry_after <= now &&
            had.attempts < MAX_SEND_ATTEMPTS
          )
        )
          return null;
        const window = had
          ? { from: had.covers_from, to: had.covers_to }
          : await windowFor(tx, r, now);
        const changes = forFrequency(mergeBySite(await readChanges(tx, r, window)), frequency);
        // The digest is sent when a draft is NEW since the last email that was sent (or none was sent yet), not
        // every morning the same undecided drafts wait: the send log holds that time (covers_to), so no column.
        const drafts = await pendingDrafts(tx, r.orgId, now);
        const since = await lastSentAt(tx, r);
        const fresh =
          since === null || drafts.some((d) => Date.parse(d.createdAt) >= since.getTime());
        const waiting: ApprovalsDigest | null = fresh
          ? waitingFor(frequency, digestOf(drafts, now, base))
          : null;
        return changes.length === 0 && !waiting ? null : { window, changes, waiting };
      });
      if (!plan) continue;
      const mail = buildMorningEmail({
        orgName: r.orgName,
        changes: plan.changes,
        waiting: plan.waiting,
        dashboardUrl: deps.dashboardUrl,
        preferencesUrl: new URL(
          `email/preferences?t=${encodeURIComponent(signToken(deps.tokenSecret, { orgId: r.orgId, userId: r.userId }, now))}`,
          base,
        ).href,
      });
      if (!mail) continue;

      const attempt = await withService(deps.sql, (tx) => claim(tx, r, day, plan.window, now));
      if (attempt === null) continue; // another worker claimed it, or it was sent: nothing more to do
      let outcome: { code: string; retry: boolean } | null;
      try {
        const res = await deps.send({
          to: r.email,
          mail,
          idempotencyKey: `morning/${r.orgId}/${r.userId}/${day}`,
        });
        outcome = res.ok ? null : failure(res);
      } catch {
        // The message is dropped on purpose: what a send throws can carry the key or the address.
        outcome = failure("threw");
      }
      await withService(deps.sql, (tx) =>
        outcome === null
          ? tx`update public.email_sends set status = 'sent', sent_at = ${now}, last_error = null
              where org_id = ${r.orgId} and user_id = ${r.userId} and local_date = ${day}
                and kind = 'morning' and status = 'sending' and attempts = ${attempt}`
          : tx`update public.email_sends set status = 'failed', last_error = ${outcome.code},
              retry_after = ${outcome.retry && attempt < MAX_SEND_ATTEMPTS ? new Date(now.getTime() + RETRY_STEP_MS * attempt) : null}
              where org_id = ${r.orgId} and user_id = ${r.userId} and local_date = ${day}
                and kind = 'morning' and status = 'sending' and attempts = ${attempt}`,
      );
      if (outcome === null) report.sent += 1;
      else report.failed += 1;
    } catch (e) {
      // The database is away, or one row is odd: this person waits for the next pass.
      console.error(`morning email: ${e instanceof Error ? e.name : "error"} for one recipient`);
    }
  }
  return report;
}
