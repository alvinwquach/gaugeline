-- 0004: the nightly queue (G36): a jobs table, the 03:00 fan-out pg_cron calls, and one summary row per
-- run that changed something.
--
-- The queue is a table: no extra service, and a job's state commits in the same transaction as the run it
-- produced. Workers claim with FOR UPDATE SKIP LOCKED (apps/hosted/worker/queue.ts), so two workers never
-- take the same row; a claim is a lease (status 'running', locked_at) that a later worker may take back
-- after 15 minutes.

-- A site can be paused: a paused site gets no nightly job.
alter table public.sites add column active boolean not null default true;

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  site_id uuid not null,
  kind text not null check (kind in ('nightly', 'manual')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- Claims so far. Each claim adds one, so (id, attempts) names one claim: a worker that lost its lease
  -- cannot complete a job another worker has claimed since.
  attempts integer not null default 0 check (attempts between 0 and 3),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  -- The job asks for probing checks. The worker still refuses them without a current consent row.
  probing boolean not null default false,
  -- A nightly job's date in the site's own time zone: one job per site per local night, whatever the clocks do.
  scheduled_for date,
  run_id uuid references public.runs (id) on delete set null,
  -- A short code (an error class or fetch refusal), never a message: messages can quote a page or a key.
  last_error text check (last_error ~ '^[a-z][a-z0-9_-]{0,63}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade,
  unique (site_id, kind, scheduled_for),
  check ((kind = 'nightly') = (scheduled_for is not null)),
  check ((status = 'running') = (locked_at is not null))
);
create index jobs_claim_idx on public.jobs (run_after, id) where status = 'queued';
create index jobs_lease_idx on public.jobs (locked_at) where status = 'running';

-- What changed since the site's previous run, by fingerprint (core's fingerprint(), stored on findings).
-- Written only when something opened or closed: an unchanged site has no row, so it gets no message (X64
-- sends the messages). Fingerprints and counts only; the words are on the findings rows.
create table public.run_changes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  site_id uuid not null,
  run_id uuid not null unique,
  previous_run_id uuid references public.runs (id) on delete set null,
  opened integer not null check (opened >= 0),
  still_open integer not null check (still_open >= 0),
  closed integer not null check (closed >= 0),
  opened_fingerprints text[] not null check (cardinality(opened_fingerprints) <= 10000),
  closed_fingerprints text[] not null check (cardinality(closed_fingerprints) <= 10000),
  created_at timestamptz not null default now(),
  check (opened + closed > 0),
  foreign key (run_id, site_id, org_id) references public.runs (id, site_id, org_id) on delete cascade
);
create index run_changes_site_idx on public.run_changes (site_id, created_at desc);

alter table public.jobs enable row level security;
alter table public.run_changes enable row level security;

-- jobs is server-only: no policy and no grant for anon or authenticated. The worker runs as service_role
-- and may change only the columns a claim, a retry or a completion touches; no delete.
revoke all on public.jobs, public.run_changes from public, anon, authenticated, service_role;
grant select, insert on public.jobs to service_role;
grant update (status, attempts, run_after, locked_at, run_id, last_error, finished_at)
  on public.jobs to service_role;

-- run_changes: read like runs (staff, or the site's client viewer); written by the worker only.
create policy run_changes_select on public.run_changes for select to authenticated
  using (org_id in (select private.staff_org_ids()) or site_id in (select private.client_site_ids()));
grant select on public.run_changes to authenticated;
grant select, insert on public.run_changes to service_role;

-- The fan-out. pg_cron runs in one time zone for the whole server (GMT unless cron.timezone is set), so it
-- calls this every 15 minutes and this decides, per site, whether it is now between 03:00 and 07:00 in the
-- site's own zone. The first call in that window makes the night's job; later calls find it there (the
-- unique key on site, kind and local date). Spring forward cannot skip a night and fall back cannot run
-- one twice, a site added at 02:59 is picked up at 03:00, and a missed call is caught up until 07:00.
-- A site whose zone Postgres does not know is left out instead of failing the fan-out for every site.
create function private.enqueue_nightly(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  made integer;
begin
  insert into public.jobs (org_id, site_id, kind, scheduled_for, run_after)
  select s.org_id, s.id, 'nightly', s.local_now::date, p_now
  from (
    select v.org_id, v.id, (p_now at time zone v.timezone) as local_now
    from (
      select s0.org_id, s0.id, s0.timezone from public.sites s0
      where s0.active
        and s0.timezone in (select z.name from pg_catalog.pg_timezone_names z)
      offset 0  -- keeps the zone filter ahead of "at time zone", which fails on an unknown zone
    ) v
  ) s
  where s.local_now::time >= time '03:00' and s.local_now::time < time '07:00'
  on conflict (site_id, kind, scheduled_for) do nothing;
  get diagnostics made = row_count;
  return made;
end
$$;

-- Registers the fan-out with pg_cron. Called below when the extension is there; otherwise the owner
-- calls it once after enabling pg_cron (docs/hosted/schedules.md).
create function private.schedule_nightly() returns void
language plpgsql set search_path = ''
as $$
begin
  perform cron.schedule('gaugeline-nightly', '*/15 * * * *', 'select private.enqueue_nightly()');
end
$$;

revoke all on function private.enqueue_nightly(timestamptz), private.schedule_nightly()
  from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform private.schedule_nightly();
  end if;
end
$$;
