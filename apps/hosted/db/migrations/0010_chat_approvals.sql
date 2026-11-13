-- 0010: approve where you already talk (X69, part 1 of 3: verification and the decision core). Renumber at
-- merge if another migration lands first (the migrator refuses gaps).
-- A chat button press arrives as a signed request to the hosted app. The app's chat login can do three
-- things only: read ONE connection's signing secret, claim a request once, and look up which member a chat
-- user is. It does that through the functions below, as the role gaugeline_chat, which holds no privilege on
-- any table. The decision itself is written the way the inbox writes it: as the signed-in member
-- (`authenticated`, row-level security), never as the server. The signing secret lives in Vault (0006) like
-- every other secret; these tables keep only its name.

do $$ begin create role gaugeline_chat nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;

-- One chat workspace an organisation connected. The id is in the request address, so it names a row and
-- is not a credential: knowing it lets nobody do anything without the signing secret.
create table public.chat_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  provider text not null check (provider in ('slack', 'discord', 'teams')),
  label text not null check (char_length(label) between 1 and 80),
  -- The provider's own id for the workspace (a Slack team id, a Discord server id, a Teams tenant id).
  -- A signed request that names another one is refused. Null means "not checked".
  workspace_ref text check (workspace_ref ~ '^[A-Za-z0-9_.-]{1,64}$'),
  -- The Vault secret (kind signing_secret) that signs this workspace's requests. Deleting the secret
  -- deletes the connection, so a connection never outlives the key that proves its requests.
  secret_name text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (org_id, secret_name) references private.secret_refs (org_id, name) on delete cascade
);

-- Which member a chat user is. An organisation's owner or admin links them. A member who leaves takes
-- their links with them (the foreign key), and a client viewer who is linked still cannot decide.
create table public.chat_identities (
  org_id uuid not null,
  connection_id uuid not null,
  chat_user_id text not null check (chat_user_id ~ '^[A-Za-z0-9_.@-]{1,128}$'),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (connection_id, chat_user_id),
  foreign key (connection_id, org_id) references public.chat_connections (id, org_id) on delete cascade,
  foreign key (org_id, user_id) references public.members (org_id, user_id) on delete cascade
);
create index chat_identities_user_idx on public.chat_identities (org_id, user_id);

-- Requests already accepted, so a recorded request cannot be sent again. The key is whatever the provider
-- signs and never repeats (Slack: the signature). Rows older than a day are removed by the next claim: the
-- timestamp window (5 minutes) refuses an old request before it gets here.
create table private.chat_requests (
  connection_id uuid not null references public.chat_connections (id) on delete cascade,
  request_key text not null check (char_length(request_key) between 8 and 128),
  org_id uuid not null,
  received_at timestamptz not null default now(),
  primary key (connection_id, request_key)
);
create index chat_requests_received_idx on private.chat_requests (received_at);

alter table public.chat_connections enable row level security;
alter table public.chat_identities enable row level security;
alter table private.chat_requests enable row level security;

revoke all on public.chat_connections, public.chat_identities, private.chat_requests
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker;

-- Owners and admins read their organisation's connections (the secret's name, never its value) and link
-- chat users to members. The server stores a connection after it has stored the secret (service_role).
create policy chat_connections_select on public.chat_connections for select to authenticated
  using (org_id in (select private.admin_org_ids()));
grant select on public.chat_connections to authenticated;
grant select, insert, delete on public.chat_connections to service_role;
grant update (label, workspace_ref, status) on public.chat_connections to service_role;

create policy chat_identities_select on public.chat_identities for select to authenticated
  using (org_id in (select private.admin_org_ids()));
create policy chat_identities_insert on public.chat_identities for insert to authenticated
  with check (org_id in (select private.admin_org_ids()));
create policy chat_identities_delete on public.chat_identities for delete to authenticated
  using (org_id in (select private.admin_org_ids()));
grant select, insert, delete on public.chat_identities to authenticated;
grant select, insert, delete on public.chat_identities to service_role;

-- The only doors for gaugeline_chat. SECURITY DEFINER with an empty search_path, like every function in
-- private. Each takes the connection id from the request address and nothing a request body says.

-- The connection a request names: its organisation and provider, or no row when it is unknown or disabled.
create function private.chat_connection(p_id uuid)
returns table (org_id uuid, provider text, workspace_ref text)
language sql stable security definer set search_path = ''
as $$
  select c.org_id, c.provider, c.workspace_ref
  from public.chat_connections c where c.id = p_id and c.status = 'active'
$$;

-- The signing secret of one active connection, or null. Only a secret of kind signing_secret: a
-- connection that points at a webhook URL gets nothing.
create function private.chat_signing_secret(p_id uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select private.get_secret(c.org_id, c.secret_name)
  from public.chat_connections c
  join private.secret_refs r on r.org_id = c.org_id and r.name = c.secret_name
  where c.id = p_id and c.status = 'active' and r.kind = 'signing_secret'
$$;

-- True the first time a request key is seen for an active connection, false every time after.
create function private.chat_claim_request(p_id uuid, p_key text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows integer;
begin
  delete from private.chat_requests where ctid in (
    select q.ctid from private.chat_requests q
    where q.received_at < pg_catalog.now() - interval '1 day' limit 50);
  insert into private.chat_requests (connection_id, request_key, org_id)
    select c.id, p_key, c.org_id from public.chat_connections c
    where c.id = p_id and c.status = 'active'
    on conflict do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;

-- The member a chat user is linked to in this connection's organisation, with their role. No row when the
-- chat user is not linked (or the member has gone).
create function private.chat_member(p_id uuid, p_chat_user text)
returns table (user_id uuid, role text)
language sql stable security definer set search_path = ''
as $$
  select i.user_id, m.role
  from public.chat_identities i
  join public.members m on m.org_id = i.org_id and m.user_id = i.user_id
  where i.connection_id = p_id and i.chat_user_id = p_chat_user
$$;

revoke all on function private.chat_connection(uuid), private.chat_signing_secret(uuid),
  private.chat_claim_request(uuid, text), private.chat_member(uuid, text)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker;
grant usage on schema private to gaugeline_chat;
grant execute on function private.chat_connection(uuid), private.chat_signing_secret(uuid),
  private.chat_claim_request(uuid, text), private.chat_member(uuid, text)
  to gaugeline_chat;
