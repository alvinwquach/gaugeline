-- 0007: what a team has paid for (X68, part 1). Numbered 0007 because 0004 to 0006 are in other pull
-- requests; the migrator refuses a gap, so this one only applies once those have merged.
--
-- Only the payment provider's own ids are stored: no card number, no name or address on a card, no
-- invoice. A card never reaches this database or this server (the provider's hosted page takes it).
-- Both tables are written by the server only (service_role, from the signed webhook). The owner of an
-- organisation can read its subscription; nobody else can, and nobody signed in can write either table.

create table public.subscriptions (
  org_id uuid primary key references public.organisations (org_id) on delete restrict,
  -- Which provider the ids belong to. 'stand-in' is the local fake; the real provider's name is added by
  -- a later migration, when the owner has an account.
  provider text not null check (provider in ('stand-in')),
  -- Ids only, and never a run of digits the length of a card number.
  provider_customer_id text not null check (provider_customer_id ~ '^[A-Za-z0-9_.:-]{1,255}$'
    and provider_customer_id !~ '^[0-9]{12,19}$'),
  provider_subscription_id text not null unique check (provider_subscription_id ~ '^[A-Za-z0-9_.:-]{1,255}$'
    and provider_subscription_id !~ '^[0-9]{12,19}$'),
  plan_id text not null check (plan_id ~ '^[a-z0-9-]{1,64}$'),
  billing_interval text check (billing_interval in ('month', 'year')),
  status text not null check (status in ('trialing', 'active', 'past_due', 'canceled')),
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  -- Set when a payment fails: nothing is paused before this time.
  grace_ends_at timestamptz,
  cancel_at_period_end boolean not null default false,
  -- The provider's time of the newest event applied. An event older than this is stale and changes nothing.
  last_event_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Every webhook event that has been handled, by the provider's event id. The primary key is what makes a
-- repeated delivery change nothing. Append-only.
create table public.billing_events (
  provider text not null check (provider in ('stand-in')),
  event_id text not null check (event_id ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  org_id uuid not null references public.organisations (org_id) on delete restrict,
  type text not null check (type ~ '^[a-z_.]{1,64}$'),
  event_at timestamptz not null,
  outcome text not null check (outcome in ('applied', 'stale')),
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);
create index billing_events_org_idx on public.billing_events (org_id, received_at desc);

alter table public.subscriptions enable row level security;
alter table public.billing_events enable row level security;

-- Owners only: billing is not for admins, members or a client viewer.
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (org_id in (select private.owner_org_ids()));

revoke all on public.subscriptions, public.billing_events from public, anon, authenticated, service_role;
grant select on public.subscriptions to authenticated;
grant select, insert, update on public.subscriptions to service_role;
grant select, insert on public.billing_events to service_role;

create trigger billing_events_append_only before update or delete on public.billing_events
  for each row execute function private.refuse_change();
create trigger billing_events_no_truncate before truncate on public.billing_events
  for each statement execute function private.refuse_change();
