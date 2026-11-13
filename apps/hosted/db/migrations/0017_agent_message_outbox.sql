-- 0017: a kind of outbox row for an agent's message (AG-13, AG-14; ADR-0005, ADR-0014). Run as the schema owner
-- ("postgres" on Supabase). The file takes the next free number when it merges (the migrator refuses gaps
-- and repeats).
--
-- What this adds, and nothing else: the existing outbox, public.notification_deliveries (0009), may now hold
-- a row of kind 'agent', for one of two messages an agent has built:
--   regression-alert   the regression watcher found something worse in one run (AG-13)
--   approvals-digest   the morning summary of the drafts waiting in the inbox (AG-14)
-- and a Slack channel may say whether it takes such messages (public.notification_channels.agent_messages,
-- off by default). Nothing here sends anything. Sending is the worker's, through the sender it already has.
--
-- Same rules as the kinds that exist:
--   * No message body is stored. A row says WHICH message (its kind, and the run or the day it is about); the
--     worker builds the words at send time, from the organisation's own rows, as it does for 'run'. So no
--     column can hold an address or a message, and the log keeps a status, a number and a short code.
--   * One row per channel and per subject (a run, or a local day), by a partial unique index: queueing it
--     twice, or from two workers, is one row.
--   * No new role, no new login and no new grant on the table. The table-level grants of 0009 already cover
--     the new columns: signed-in staff of the organisation SELECT through the same policy, and only
--     service_role inserts, and updates the same eight delivery columns. gaugeline_agent still holds nothing
--     on this table, and an agent never queues a row: it returns text, and the worker queues.
--   * The database enforces the rules a worker's bug could break, for agent rows only, in one trigger
--     (private.agent_delivery_guard, run by the caller, executable by no role): a row is inserted as queued
--     and untouched, for a Slack channel that is active and takes agent messages RIGHT NOW (the opt-in is
--     the database's, not only the worker's); a channel never has more than three digests waiting (queued or
--     sending, in two groups, the days around today and the rest, so far-off dates cannot starve today's); the channel row
--     is locked while the guard counts and checks, so concurrent inserts and a concurrent opt-out cannot race
--     it; and a row only moves forward: queued to sending, sending to sent, failed, or back to queued (the
--     worker's retry); a sent or failed row is final, and never goes straight from queued to sent.
--   * The same tenancy: the channel, the run and the site are tied to the row's organisation by composite
--     foreign keys, so an agent message for one organisation cannot point at another's channel or run.
--
-- The one grant added is the column the owner turns on: service_role may update notification_channels
-- .agent_messages, like the other channel columns the app changes.

alter table public.notification_channels
  add column agent_messages boolean not null default false;
-- A digest or an alert is Slack text: a Sentry project takes events, not messages.
alter table public.notification_channels
  add constraint notification_channels_agent_messages_slack check (not agent_messages or kind = 'slack');
grant update (agent_messages) on public.notification_channels to service_role;

alter table public.notification_deliveries drop constraint notification_deliveries_kind_check;
alter table public.notification_deliveries
  add constraint notification_deliveries_kind_check check (kind in ('run', 'test', 'agent'));

alter table public.notification_deliveries
  -- Which agent message. Null for 'run' and 'test'.
  add column agent_kind text constraint notification_deliveries_agent_kind_known
    check (agent_kind in ('regression-alert', 'approvals-digest')),
  -- A regression alert: the run it is about (the later of the two runs compared). A separate column from
  -- run_id, which 0009 ties to kind 'run'.
  add column subject_run_id uuid,
  -- A digest: the local day it is for, so one channel gets one digest a day.
  add column digest_date date;

alter table public.notification_deliveries
  add constraint notification_deliveries_agent_shape check (
    (kind = 'agent') = (agent_kind is not null)
    and (agent_kind is distinct from 'regression-alert'
      or (subject_run_id is not null and site_id is not null and digest_date is null))
    and (agent_kind is distinct from 'approvals-digest'
      or (digest_date is not null and subject_run_id is null and site_id is null))
    and (agent_kind is not null or (subject_run_id is null and digest_date is null))
  );

-- The same composite key 0009 uses for run_id: the run belongs to this site and this organisation.
alter table public.notification_deliveries
  add constraint notification_deliveries_subject_run_fkey
  foreign key (subject_run_id, site_id, org_id) references public.runs (id, site_id, org_id)
  on delete cascade;

create unique index notification_deliveries_agent_alert_once
  on public.notification_deliveries (channel_id, subject_run_id) where agent_kind = 'regression-alert';
create unique index notification_deliveries_agent_digest_once
  on public.notification_deliveries (channel_id, digest_date) where agent_kind = 'approvals-digest';

-- A digest's day must be one the table could hold: not before this table existed and not past the century.
-- A check cannot use the clock (the worker's clock is injected, so is every test's), so this rejects
-- absurd days; the trigger's cap of three waiting digests per channel bounds how many can sit in the queue.
alter table public.notification_deliveries
  add constraint notification_deliveries_digest_date_sane
  check (digest_date is null or digest_date between date '2026-11-01' and date '2099-12-31');

create function private.agent_delivery_guard() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_waiting integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' or new.attempts <> 0 or new.locked_at is not null or new.sent_at is not null
       or new.http_status is not null or new.error_code is not null then
      raise exception 'an agent message is queued, not sent' using errcode = '23514';
    end if;
    -- The opt-in is read now, in the inserting transaction: a channel that is off, disabled, another
    -- organisation's or not Slack takes nothing. The channel row is LOCKED first (for update): two inserts
    -- for one channel run one after the other, so the count below sees the other's row, and a channel that
    -- is being turned off in another transaction is waited for, then read again.
    perform 1 from public.notification_channels c
      where c.id = new.channel_id and c.org_id = new.org_id and c.kind = 'slack'
        and c.status = 'active' and c.agent_messages
      for update;
    if not found then
      raise exception 'the channel does not take agent messages' using errcode = '23514';
    end if;
    -- The cap is three waiting digests per channel in each of two groups: those dated today or within two
    -- days either side (by the database's UTC date), and those dated further out. A worker's mistake in its
    -- dates can fill the far group, never the allowance for today's digest.
    if new.agent_kind = 'approvals-digest' then
      select pg_catalog.count(*) into v_waiting from public.notification_deliveries d
        where d.channel_id = new.channel_id and d.agent_kind = 'approvals-digest'
          and d.status in ('queued', 'sending')
          and (d.digest_date between (pg_catalog.now() at time zone 'UTC')::date - 2
            and (pg_catalog.now() at time zone 'UTC')::date + 2)
            = (new.digest_date between (pg_catalog.now() at time zone 'UTC')::date - 2
            and (pg_catalog.now() at time zone 'UTC')::date + 2);
      if v_waiting >= 3 then
        raise exception 'the channel already has three digests waiting' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  -- A row that is sent or failed is final: not rewritten, not even with the status it has.
  if old.status in ('sent', 'failed') then
    raise exception 'an agent message that is sent or failed is final' using errcode = '23514';
  end if;
  if old.status = new.status
     or (old.status = 'queued' and new.status = 'sending')
     or (old.status = 'sending' and new.status in ('queued', 'sent', 'failed')) then
    return new;
  end if;
  raise exception 'an agent message only moves forward' using errcode = '23514';
end;
$$;
revoke all on function private.agent_delivery_guard() from public, anon, authenticated, service_role, gaugeline_agent;

create trigger notification_deliveries_agent_guard
  before insert or update on public.notification_deliveries
  for each row when (new.kind = 'agent')
  execute function private.agent_delivery_guard();
