-- 0009: findings in the team's own Slack channel or Sentry project (X67). Renumber at merge if another
-- migration lands first (the migrator refuses gaps).
-- The address (a Slack webhook URL or a Sentry DSN) is a secret: it lives in Supabase Vault through
-- private.put_secret (0006), and these tables keep only its name and its host. No table here has a column
-- that can hold an address or a message body: the delivery log keeps a status, a number and a short code.

-- An organisation's destinations. Written by the worker's role only (saving one stores a Vault secret).
create table public.notification_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  kind text not null check (kind in ('slack', 'sentry')),
  label text not null check (char_length(label) between 1 and 80),
  -- The host alone (hooks.slack.com, o123.ingest.sentry.io): never a path, which is the secret part.
  host text not null check (host ~ '^[a-z0-9.-]{1,253}$'),
  secret_name text not null check (secret_name ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- Deliveries in a row that failed after every retry. Three disable the channel.
  failures integer not null default 0 check (failures >= 0),
  disabled_reason text check (disabled_reason in ('rejected', 'failed-repeatedly', 'address-refused')),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'disabled') = (disabled_reason is not null)),
  unique (org_id, secret_name),
  unique (id, org_id)
);

-- Which findings go to which channel: a site (or every site), the lowest severity, optionally only some
-- checks, only what changed since last night, and quiet hours in the site's own time zone.
create table public.notification_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  channel_id uuid not null,
  site_id uuid,
  min_severity text not null default 'high' check (min_severity in ('high', 'medium', 'low')),
  check_ids text[] check (check_ids is null or cardinality(check_ids) between 1 and 200),
  only_changes boolean not null default true,
  quiet_start smallint check (quiet_start between 0 and 23),
  quiet_end smallint check (quiet_end between 0 and 23),
  created_at timestamptz not null default now(),
  check ((quiet_start is null) = (quiet_end is null)),
  foreign key (channel_id, org_id) references public.notification_channels (id, org_id) on delete cascade,
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade
);
create index notification_rules_channel_idx on public.notification_rules (channel_id);

-- The outbox and the delivery log in one: a row is queued in the transaction that stores the night's run,
-- and the sender marks it sent or failed. The message is built at send time from the run's findings, so it
-- is never stored; error_code is a short fixed code (no ':' or '/', so it cannot hold an address).
create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  channel_id uuid not null,
  kind text not null check (kind in ('run', 'test')),
  run_id uuid,
  site_id uuid,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  send_after timestamptz not null default now(),
  locked_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  http_status integer check (http_status between 100 and 599),
  error_code text check (error_code ~ '^[a-z0-9-]{1,40}$'),
  findings integer not null default 0 check (findings >= 0),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'run') = (run_id is not null)),
  unique (channel_id, run_id),
  foreign key (channel_id, org_id) references public.notification_channels (id, org_id) on delete cascade,
  foreign key (run_id, site_id, org_id) references public.runs (id, site_id, org_id) on delete cascade
);
create index notification_deliveries_due_idx on public.notification_deliveries (send_after)
  where status = 'queued';
create index notification_deliveries_channel_idx on public.notification_deliveries (channel_id, created_at desc);

alter table public.notification_channels enable row level security;
alter table public.notification_rules enable row level security;
alter table public.notification_deliveries enable row level security;

revoke all on public.notification_channels, public.notification_rules, public.notification_deliveries
  from public, anon, authenticated, service_role, gaugeline_agent;

-- Staff of the organisation read its channels and the log (a client viewer does not). Only the worker's
-- role writes channels and deliveries; owners and admins write rules.
create policy notification_channels_select on public.notification_channels for select to authenticated
  using (org_id in (select private.staff_org_ids()));
grant select on public.notification_channels to authenticated;
grant select, insert, delete on public.notification_channels to service_role;
grant update (label, status, failures, disabled_reason, disabled_at) on public.notification_channels
  to service_role;

create policy notification_rules_select on public.notification_rules for select to authenticated
  using (org_id in (select private.staff_org_ids()));
create policy notification_rules_insert on public.notification_rules for insert to authenticated
  with check (org_id in (select private.admin_org_ids()));
create policy notification_rules_update on public.notification_rules for update to authenticated
  using (org_id in (select private.admin_org_ids()))
  with check (org_id in (select private.admin_org_ids()));
create policy notification_rules_delete on public.notification_rules for delete to authenticated
  using (org_id in (select private.admin_org_ids()));
grant select, insert, delete on public.notification_rules to authenticated;
grant update (site_id, min_severity, check_ids, only_changes, quiet_start, quiet_end)
  on public.notification_rules to authenticated;
grant select on public.notification_rules to service_role;

create policy notification_deliveries_select on public.notification_deliveries for select to authenticated
  using (org_id in (select private.staff_org_ids()));
grant select on public.notification_deliveries to authenticated;
grant select, insert on public.notification_deliveries to service_role;
grant update (status, send_after, locked_at, attempts, http_status, error_code, findings, sent_at)
  on public.notification_deliveries to service_role;
