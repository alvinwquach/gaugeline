-- 0003: site upload tokens and idempotency keys for the runs API (G35).
--
-- Both tables are for the server only: nobody signed in (a browser) can read or write them, because a
-- token hash is a credential. The API reaches them as service_role (apps/hosted/lib/api/db.ts), never as
-- the table owner. RLS is on and forced; with no policy and no grant for anon or authenticated there is
-- nothing for those roles to reach, and a later policy has to be written on purpose.

-- One upload token per row. The token itself (glt_<prefix>_<43 random characters>) is shown once when it
-- is minted and never stored: token_hash is the SHA-256 of the whole token, prefix is the 8 characters
-- that find the row. A token belongs to one site, and its organisation is that site's organisation.
create table public.tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  site_id uuid not null,
  prefix text not null unique check (prefix ~ '^[0-9a-f]{8}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade
);
create index tokens_site_idx on public.tokens (site_id);

-- An Idempotency-Key a site's token has used on POST /runs, with the hash of the body it came with and
-- the run it made. The same key and body again returns that run; the same key and another body is a
-- conflict. Keys are per site. Rows can be pruned (service_role may delete) once a client no longer retries.
create table public.idempotency_keys (
  site_id uuid not null,
  key text not null check (length(key) between 1 and 255),
  org_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  run_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (site_id, key),
  foreign key (run_id, site_id, org_id) references public.runs (id, site_id, org_id) on delete cascade
);
create index idempotency_keys_created_idx on public.idempotency_keys (created_at);

alter table public.tokens enable row level security;
alter table public.tokens force row level security;
alter table public.idempotency_keys enable row level security;
alter table public.idempotency_keys force row level security;

-- Take back whatever default privileges gave, then grant exactly what the API does.
revoke all on public.tokens, public.idempotency_keys from public, anon, authenticated, service_role;
grant select, insert on public.tokens to service_role;
grant update (revoked_at) on public.tokens to service_role;
grant select, insert, delete on public.idempotency_keys to service_role;
