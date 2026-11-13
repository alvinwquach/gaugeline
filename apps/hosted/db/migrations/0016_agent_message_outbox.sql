-- 0016: a kind of outbox row for an agent's message (AG-13, AG-14; ADR-0005, ADR-0014). Run as the schema owner
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
--   * No new role, no new login, no new function and no new grant. The table-level grants of 0009 already
--     cover the new columns: signed-in staff of the organisation SELECT through the same policy, and only
--     service_role inserts, and updates the same five delivery columns. gaugeline_agent still holds nothing
--     on this table, and an agent never queues a row: it returns text, and the worker queues.
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
