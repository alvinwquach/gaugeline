-- 0001: the hosted tables and their indexes (G34).
--
-- Every table has org_id. A row that points at another row repeats its org_id and the foreign key covers
-- both columns, so a finding cannot belong to organisation A and a site of organisation B even before
-- row-level security (0002) is considered.
-- No page content is stored anywhere: findings keep one evidence line, a URL and a fingerprint.

create table public.organisations (
  org_id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  url text not null check (url ~ '^https?://' and length(url) <= 2048),
  -- The worker schedules the nightly run at 03:00 in this zone (G36).
  timezone text not null default 'UTC' check (length(timezone) <= 64),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, url)
);

-- A user's place in an organisation. user_id is the Supabase auth user id; there is no foreign key to
-- auth.users so the decision log keeps its "who" after an account is deleted.
-- A client viewer is tied to exactly one site; nobody else is tied to a site.
create table public.members (
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member', 'client')),
  site_id uuid,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id),
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade,
  check ((role = 'client') = (site_id is not null))
);
create index members_user_id_idx on public.members (user_id);

-- One run of the checks against one site. summary is the CLI's schema-1 summary (counts), not the report.
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  site_id uuid not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 16384),
  created_at timestamptz not null default now(),
  unique (id, site_id, org_id),
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade
);
create index runs_site_started_idx on public.runs (site_id, started_at desc);

-- What a run found. fingerprint is core's fingerprint() (16 hex characters): the join key for opened,
-- still open and closed between runs, the same hash baselines use (G29).
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  site_id uuid not null,
  run_id uuid not null,
  check_id text not null check (check_id ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  severity text not null check (severity in ('high', 'medium', 'low')),
  title text not null check (length(title) between 1 and 300),
  evidence text not null default '' check (length(evidence) <= 1000),
  url text not null check (length(url) <= 2048),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{16}$'),
  created_at timestamptz not null default now(),
  foreign key (run_id, site_id, org_id) references public.runs (id, site_id, org_id) on delete cascade
);
create index findings_site_fingerprint_idx on public.findings (site_id, fingerprint);
create index findings_run_idx on public.findings (run_id);

-- A proposed change waiting for a person (G37). Its state is not a column: it is the latest decision.
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  site_id uuid not null,
  kind text not null check (kind ~ '^[a-z][a-z0-9-]{0,39}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384),
  finding_ids uuid[] not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade
);
create index drafts_site_idx on public.drafts (site_id, created_at desc);

-- Who decided what about a draft, and when. Append-only (0002): rows are inserted and read, never
-- changed or removed. The identity column gives the log its order.
create table public.decisions (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  draft_id uuid not null,
  decision text not null check (decision in ('approved', 'edited', 'declined')),
  edited_payload jsonb check (edited_payload is null or jsonb_typeof(edited_payload) = 'object'),
  reason text check (length(reason) <= 1000),
  decided_by uuid not null,
  decided_at timestamptz not null default now(),
  check ((decision = 'edited') = (edited_payload is not null)),
  foreign key (draft_id, org_id) references public.drafts (id, org_id) on delete restrict
);
create index decisions_draft_idx on public.decisions (draft_id, id desc);

-- The site owner's consent to probing checks (non-public paths, a site's keys against its own APIs).
-- Append-only like decisions: a withdrawal is a new row. The current consent is the latest row for the
-- site; the worker (G36) refuses a probing check unless that row is "granted" for the current wording.
create table public.site_consents (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  site_id uuid not null,
  action text not null check (action in ('granted', 'withdrawn')),
  wording_version text not null check (wording_version ~ '^[0-9A-Za-z.-]{1,40}$'),
  recorded_by uuid not null,
  recorded_at timestamptz not null default now(),
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete restrict
);
create index site_consents_site_idx on public.site_consents (site_id, id desc);
