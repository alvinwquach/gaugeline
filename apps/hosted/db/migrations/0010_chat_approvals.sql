-- 0010: approve where you already talk (X69, part 1 of 3: verification and the decision core). Renumber at
-- merge if another migration lands first (the migrator refuses gaps).
-- A chat button press arrives as a signed request to the hosted app. The app's chat login is a member of
-- gaugeline_chat and of NOTHING else (never `authenticated`: a login that can become `authenticated` can
-- claim to be any person, and write a decision in their name). gaugeline_chat holds no privilege on any
-- table and may run four functions: read ONE connection's signing secret, claim a request once, name a
-- connection, and decide. private.chat_decide finds the member from a link that member confirmed, inside
-- the function, and applies the inbox's own rules (the same SQL functions the inbox calls), so a chat
-- login can only ever record what a confirmed, allowed member's own press would. The signing secret lives
-- in Vault (0006) like every other secret; these tables keep only its name.

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

-- Which member a chat user is. An owner or admin PROPOSES a link; it counts only after that member, signed
-- in, confirms it (confirmed_at, which only the member can set). Otherwise an admin could link any chat
-- user to the owner and record decisions in the owner's name. A member who leaves takes their links with
-- them (the foreign key), and a client viewer who is linked still cannot decide.
create table public.chat_identities (
  org_id uuid not null,
  connection_id uuid not null,
  chat_user_id text not null check (chat_user_id ~ '^[A-Za-z0-9_.@-]{1,128}$'),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
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

-- Owners and admins read the links of their organisation and propose new ones (unconfirmed: the column is
-- not insertable). A member reads, confirms (once, and only their own) and removes their own links.
create policy chat_identities_select on public.chat_identities for select to authenticated
  using (org_id in (select private.admin_org_ids()) or user_id = (select auth.uid()));
create policy chat_identities_insert on public.chat_identities for insert to authenticated
  with check (org_id in (select private.admin_org_ids()) and confirmed_at is null);
create policy chat_identities_confirm on public.chat_identities for update to authenticated
  using (user_id = (select auth.uid()) and confirmed_at is null)
  with check (user_id = (select auth.uid()) and confirmed_at is not null);
create policy chat_identities_delete on public.chat_identities for delete to authenticated
  using (org_id in (select private.admin_org_ids()) or user_id = (select auth.uid()));
grant select, delete on public.chat_identities to authenticated, service_role;
grant insert (org_id, connection_id, chat_user_id, user_id) on public.chat_identities
  to authenticated, service_role;
grant update (confirmed_at) on public.chat_identities to authenticated;

-- A confirmation is stamped by the database, so it cannot be backdated or cleared.
create function private.chat_identity_confirm() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.confirmed_at := pg_catalog.now();
  return new;
end
$$;
revoke all on function private.chat_identity_confirm() from public;
create trigger chat_identities_confirm before update on public.chat_identities
  for each row execute function private.chat_identity_confirm();

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

-- The inbox's own rules in SQL, so the inbox (as the signed-in person, under row-level security) and
-- private.chat_decide (as the function owner) call the same text. SECURITY INVOKER: they read as whoever
-- calls them.

-- The draft's findings (by id) that are not findings of this organisation and site. [] means all are its own.
create function private.own_findings(p_org uuid, p_site uuid, p_ids uuid[]) returns boolean
language sql stable set search_path = ''
as $$
  select (select pg_catalog.count(*) from public.findings f
          where f.id = any (select pg_catalog.unnest(p_ids) as id) and f.org_id = p_org and f.site_id = p_site)
       = (select pg_catalog.count(distinct i) from pg_catalog.unnest(p_ids) as i)
$$;

-- The draft's findings that have since closed: a later run of the same site that finished cleanly no longer
-- reports their fingerprint (see docs/hosted/inbox.md, "When the finding has already closed").
create function private.closed_findings(p_site uuid, p_finding_ids uuid[]) returns setof uuid
language sql stable set search_path = ''
as $$
  select f.id from public.findings f join public.runs r on r.id = f.run_id
  where f.id = any (p_finding_ids) and f.site_id = p_site
    and exists (
      select 1 from public.runs later
      cross join lateral (
        select coalesce(case when pg_catalog.jsonb_typeof(later.summary -> 'couldNotCheck') = 'array'
                                        then later.summary -> 'couldNotCheck' end, '[]'::pg_catalog.jsonb) as skipped) c
      where later.site_id = f.site_id and later.finished_at is not null
        and later.summary ->> 'partial' is distinct from 'true'
        and later.summary ->> 'error' is null
        and pg_catalog.jsonb_array_length(c.skipped) < 20
        and not exists (select 1 from pg_catalog.jsonb_array_elements(c.skipped) s where s ->> 'id' = f.check_id)
        and later.started_at > r.started_at
        and not exists (select 1 from public.findings g where g.run_id = later.id and g.fingerprint = f.fingerprint))
  order by f.id
$$;
revoke all on function private.own_findings(uuid, uuid, uuid[]), private.closed_findings(uuid, uuid[])
  from public, anon, service_role, gaugeline_agent, gaugeline_worker;
grant execute on function private.own_findings(uuid, uuid, uuid[]), private.closed_findings(uuid, uuid[])
  to authenticated;

-- A chat press, decided. The member is found HERE, from a link they confirmed, never taken from the caller:
-- the caller (the chat login) supplies only what the signed request said. Refuses, in this order and
-- writing nothing: an unknown or switched-off connection; a chat user with no confirmed link; a member who
-- is not staff (a client viewer); a draft that is not this connection's organisation's; a draft already
-- decided (reports who); an approval of a proposal older than 72 hours (ADR-0010; uncited), a draft whose
-- findings are not its site's, a finding that has since closed (the inbox's confirming click stays in the
-- inbox). Then it writes the one decision row the inbox would, as that member; the shape checks and the
-- payload hash are the triggers of 0005. It returns what the apply queue needs, in the caller's own
-- transaction (the caller enqueues; the writer re-checks everything: ADR-0010).
create function private.chat_decide(p_connection uuid, p_chat_user text, p_draft uuid, p_choice text)
returns table (
  r_status text, r_decision text, r_decision_id bigint, r_user_id uuid, r_decided_by uuid,
  r_kind text, r_org_id uuid, r_payload text, r_sha text, r_enqueue boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_user uuid;
  v_role text;
  v_draft public.drafts;
  v_state record;
  v_decision text;
  v_id bigint;
  v_sha text;
begin
  if p_choice is null or p_choice not in ('approve', 'decline') then
    raise exception 'choice must be approve or decline' using errcode = '22023';
  end if;
  r_status := null; r_decision := null; r_decision_id := null; r_user_id := null; r_decided_by := null;
  r_kind := null; r_org_id := null; r_payload := null; r_sha := null; r_enqueue := false;

  select c.org_id into v_org from public.chat_connections c where c.id = p_connection and c.status = 'active';
  if not found then r_status := 'not-found'; return next; return; end if;

  select i.user_id, m.role into v_user, v_role
  from public.chat_identities i
  join public.members m on m.org_id = i.org_id and m.user_id = i.user_id
  where i.connection_id = p_connection and i.chat_user_id = p_chat_user and i.confirmed_at is not null;
  if not found then r_status := 'unknown-user'; return next; return; end if;
  if v_role not in ('owner', 'admin', 'member') then r_status := 'not-allowed'; return next; return; end if;

  select * into v_draft from public.drafts d where d.id = p_draft and d.org_id = v_org;
  if not found then r_status := 'not-found'; return next; return; end if;

  select s.decision, s.decided_by into v_state from public.draft_state s where s.draft_id = p_draft;
  if v_state.decision <> 'pending' then
    r_status := 'already-decided'; r_decision := v_state.decision; r_decided_by := v_state.decided_by;
    return next; return;
  end if;

  if p_choice = 'approve' then
    if v_draft.created_at < pg_catalog.now() - interval '72 hours' then
      r_status := 'expired'; return next; return;
    end if;
    if not private.own_findings(v_draft.org_id, v_draft.site_id, v_draft.finding_ids) then
      r_status := 'invalid-payload'; return next; return;
    end if;
    if exists (select 1 from private.closed_findings(v_draft.site_id, v_draft.finding_ids)) then
      r_status := 'open-inbox'; return next; return;
    end if;
  end if;

  v_decision := case p_choice when 'approve' then 'approved' else 'declined' end;
  insert into public.decisions (org_id, draft_id, decision, decided_by)
    values (v_draft.org_id, p_draft, v_decision, v_user)
    on conflict (draft_id) where decision in ('approved', 'edited', 'declined') do nothing
    returning id, payload_sha256 into v_id, v_sha;
  if v_id is null then
    select s.decision, s.decided_by into v_state from public.draft_state s where s.draft_id = p_draft;
    r_status := 'already-decided'; r_decision := v_state.decision; r_decided_by := v_state.decided_by;
    return next; return;
  end if;

  r_status := 'recorded'; r_decision := v_decision; r_decision_id := v_id; r_user_id := v_user;
  r_kind := v_draft.kind; r_org_id := v_draft.org_id; r_payload := v_draft.payload::text; r_sha := v_sha;
  -- A weekly client update is sent by its own job after approval and never becomes an apply job (inbox.ts).
  r_enqueue := v_decision = 'approved'
    and not exists (select 1 from public.weekly_updates w where w.draft_id = p_draft);
  return next;
end
$$;

revoke all on function private.chat_connection(uuid), private.chat_signing_secret(uuid),
  private.chat_claim_request(uuid, text), private.chat_decide(uuid, text, uuid, text)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker;
grant usage on schema private to gaugeline_chat;
grant execute on function private.chat_connection(uuid), private.chat_signing_secret(uuid),
  private.chat_claim_request(uuid, text), private.chat_decide(uuid, text, uuid, text)
  to gaugeline_chat;
