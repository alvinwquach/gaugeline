-- 0007: the morning email (X64): each person's email settings, and a log that makes "once a day" a fact
-- the database keeps, so a restart or a second worker never sends the same morning twice.
--
-- Both tables are about people's email addresses, so neither is open to a browser beyond a person's own
-- row. The address is never read from anything a page said: it is set by the server when the person
-- confirms it (signing in with it) and read by the worker from this row.

create table public.email_preferences (
  org_id uuid not null,
  user_id uuid not null,
  -- Null until known. Plain shape check only (the sender checks again); no line breaks or header characters.
  email text check (email is null or (length(email) <= 254
    and email ~ '^[^\s@<>()\[\],;:"\\]+@[^\s@<>()\[\],;:"\\]+\.[^\s@<>()\[\],;:"\\]+$')),
  -- Nothing is sent to an address that has not been confirmed.
  email_confirmed_at timestamptz,
  -- Null means "the default for the role": every change for owners and admins, off for members. A client
  -- viewer is never mailed whatever this says (the worker only reads owner, admin and member rows).
  frequency text check (frequency in ('every_change', 'fix_first', 'off')),
  -- Where 07:00 is. Null means the time zone most of the organisation's sites are in.
  timezone text check (length(timezone) <= 64),
  -- Set when the mail service reports the address bounced: nothing more is sent to it.
  bounced_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (org_id, user_id) references public.members (org_id, user_id) on delete cascade,
  check (email_confirmed_at is null or email is not null)
);

-- One row per person, per organisation, per local day. The primary key is the idempotency key: the claim
-- is an insert, and only the one that inserts (or takes a failed row back) sends. A row left 'sending'
-- by a crash is never sent again: better one missed morning than two copies. The next email still
-- covers everything since the last one that was sent (covers_from), so no news is lost.
create table public.email_sends (
  org_id uuid not null,
  user_id uuid not null,
  local_date date not null,
  kind text not null default 'morning' check (kind in ('morning')),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  -- The run_changes this email reports: created after covers_from, up to covers_to.
  covers_from timestamptz not null,
  covers_to timestamptz not null,
  retry_after timestamptz,
  -- A short code, never a message: a provider's message can quote an address.
  last_error text check (last_error ~ '^[a-z][a-z0-9_-]{0,63}$'),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (org_id, user_id, local_date, kind),
  foreign key (org_id, user_id) references public.members (org_id, user_id) on delete cascade,
  check (covers_from < covers_to),
  check ((status = 'sent') = (sent_at is not null))
);
create index email_sends_last_idx on public.email_sends (org_id, user_id, covers_to desc)
  where status = 'sent';

alter table public.email_preferences enable row level security;
alter table public.email_sends enable row level security;

revoke all on public.email_preferences, public.email_sends from public, anon, authenticated, service_role;

-- A person reads and changes their own setting and time zone, and nothing else about the row: not the
-- address, not whether it is confirmed, not whether it bounced. Only the server creates the row.
create policy email_preferences_select on public.email_preferences for select to authenticated
  using (user_id = (select auth.uid()));
create policy email_preferences_update on public.email_preferences for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select on public.email_preferences to authenticated;
grant update (frequency, timezone) on public.email_preferences to authenticated;

grant select, insert on public.email_preferences to service_role;
grant update (email, email_confirmed_at, frequency, timezone, bounced_at)
  on public.email_preferences to service_role;

-- The send log is the server's: no policy and no grant for anon or authenticated. created_at, sent_at
-- and the status are the database's and the claim's to set, never an insert's.
grant select on public.email_sends to service_role;
grant insert (org_id, user_id, local_date, kind, covers_from, covers_to) on public.email_sends
  to service_role;
grant update (status, attempts, retry_after, last_error, sent_at) on public.email_sends
  to service_role;
