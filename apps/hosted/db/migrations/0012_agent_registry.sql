-- The agent registry (AG-02; ADR-0014 "registered agents only"). Run as the schema owner ("postgres" on
-- Supabase). The file takes the next free number when it merges (the migrator refuses gaps and repeats).
--
-- Every agent identity in the hosted workspace is one row of public.agents: a name, an owner (a staff member
-- of the same organisation), scopes from a closed list, the SHA-256 of its token and an 8-character prefix
-- that finds it, when it was created and last used, and a status. The database mints the token
-- (private.register_agent), returns it once and never stores it: nobody chooses a token, a hash or a prefix.
-- 0005's private.agent_tokens moves in here, and private.agent_insert_draft keeps its signature but looks the
-- token up here.
--
-- Who reaches what:
--   agents, agent_events, agent_shadow_inventory   owners and admins of the organisation, through RLS
--   a member, a client viewer, anon, the server, the worker, the chat login and the agent role   nothing
-- An agent role holds no privilege on any table (0005); a new agent has no scope until a person grants one.

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  -- One line, by the same character rule as a client's name (0008).
  name text not null constraint agents_name_one_line check (length(name) between 1 and 80
    and name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufffe\uffff]'),
  -- Null only for a token migrated from 0005, or once the owner has left: both are flagged below.
  owner_id uuid,
  -- The closed list: one "draft:" scope per draft kind (0005) and two read scopes for AG-08. Nothing that
  -- writes: the only writes are ADR-0010's, after a person's approval, in the customer's worker. A flat
  -- list that starts at 1 (see drafts_finding_ids_cap in 0005 for why); no scope twice (the triggers below:
  -- a check constraint cannot hold a subquery).
  scopes text[] not null default '{}' constraint agents_scopes_known check (
    scopes <@ array['draft:pull_request', 'draft:email', 'draft:sanity_draft', 'read:runs', 'read:pending']
    and coalesce(array_ndims(scopes), 1) = 1 and coalesce(array_lower(scopes, 1), 1) = 1
    and cardinality(scopes) <= 5),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  -- The 8 hex characters after "gla_" that find the row in a list. Null only for a migrated 0005 token,
  -- whose prefix was never recorded.
  token_prefix text unique check (token_prefix ~ '^[0-9a-f]{8}$'),
  -- 'migrated_0005' only for the rows this migration moves in; every later row is 'registered' (forced by
  -- the insert trigger), so a new agent always has a prefix.
  origin text not null default 'registered' check (origin in ('registered', 'migrated_0005')),
  constraint agents_prefix_unless_migrated check ((token_prefix is null) = (origin = 'migrated_0005')),
  status text not null default 'active' check (status in ('active', 'disabled', 'revoked')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  unique (id, org_id),
  unique (org_id, name),
  check ((status = 'revoked') = (revoked_at is not null)),
  -- The owner is a member of THIS organisation; when they leave, the agent keeps running without an owner
  -- and the shadow inventory flags it.
  foreign key (org_id, owner_id) references public.members (org_id, user_id) on delete set null (owner_id)
);
create index agents_org_idx on public.agents (org_id, created_at desc);

-- Every status an agent has had, who set it and when: append-only, like the decisions log (0002). Written
-- only by the trigger below; nobody inserts, changes or removes a row.
create table public.agent_events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  agent_id uuid not null,
  from_status text check (from_status in ('active', 'disabled', 'revoked')),
  to_status text not null check (to_status in ('active', 'disabled', 'revoked')),
  -- The signed-in person, or null for the migration of a 0005 token.
  changed_by uuid,
  changed_at timestamptz not null default now(),
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade
);
create index agent_events_agent_idx on public.agent_events (agent_id, id);

alter table public.agents enable row level security;
alter table public.agent_events enable row level security;

create policy agents_select on public.agents for select to authenticated
  using (org_id in (select private.admin_org_ids()));
create policy agents_update on public.agents for update to authenticated
  using (org_id in (select private.admin_org_ids()))
  with check (org_id in (select private.admin_org_ids()));
create policy agent_events_select on public.agent_events for select to authenticated
  using (org_id in (select private.admin_org_ids()));

-- Grants: take back the defaults, then name the columns. Nobody signed in inserts a row (only
-- private.register_agent does, with a token the database minted), sets created_at, last_used_at, revoked_at
-- or revoked_by, or reads a token's hash (like invites, 0008).
revoke all on public.agents, public.agent_events
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant select (id, org_id, name, owner_id, scopes, token_prefix, origin, status, created_at, last_used_at,
  revoked_at, revoked_by) on public.agents to authenticated;
grant update (name, owner_id, scopes, status) on public.agents to authenticated;
grant select on public.agent_events to authenticated;

create trigger agent_events_append_only before update or delete on public.agent_events
  for each row execute function private.refuse_change();
create trigger agent_events_no_truncate before truncate on public.agent_events
  for each statement execute function private.refuse_change();

-- The history row for a new agent and for every change of status. SECURITY DEFINER: nobody else may insert.
create function private.agents_record_status() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.agent_events (org_id, agent_id, from_status, to_status, changed_by)
      values (new.org_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status,
              (select auth.uid()));
  end if;
  return null;
end
$$;
revoke all on function private.agents_record_status() from public;
create trigger agents_record_status after insert or update of status on public.agents
  for each row execute function private.agents_record_status();

-- 0005's tokens move in: same organisation, hash, creation time and revocation; no name, owner or prefix
-- was ever recorded, so each gets a plain name, no owner (flagged) and the three draft scopes it could use
-- before, so private.agent_insert_draft keeps working for it.
insert into public.agents (org_id, name, owner_id, scopes, token_sha256, origin, status, created_at,
    revoked_at)
  select t.org_id, 'Agent token ' || t.id, null,
         array['draft:pull_request', 'draft:email', 'draft:sanity_draft'],
         pg_catalog.encode(t.token_sha256, 'hex'), 'migrated_0005',
         case when t.revoked_at is null then 'active' else 'revoked' end, t.created_at, t.revoked_at
  from private.agent_tokens t order by t.id;
drop table private.agent_tokens;

-- From here on, a new agent needs an owner who is staff (owner, admin or member, not a client viewer) of its
-- organisation, names no scope twice, and starts registered, active and unused, whoever inserts it.
create function private.agents_check_insert() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.owner_id is null or not exists (
    select 1 from public.members m
    where m.org_id = new.org_id and m.user_id = new.owner_id and m.role in ('owner', 'admin', 'member'))
  then
    raise exception 'an agent''s owner must be a staff member of its organisation' using errcode = '42501';
  end if;
  if cardinality(array(select distinct pg_catalog.unnest(new.scopes))) <> cardinality(new.scopes) then
    raise exception 'an agent names each scope once' using errcode = '23514';
  end if;
  new.origin := 'registered';
  new.status := 'active';
  new.created_at := pg_catalog.now();
  new.last_used_at := null;
  new.revoked_at := null;
  new.revoked_by := null;
  return new;
end
$$;
revoke all on function private.agents_check_insert() from public;
create trigger agents_check_insert before insert on public.agents
  for each row execute function private.agents_check_insert();

-- A change: the organisation, token, origin and creation time never change; the owner is cleared only once
-- they are no longer staff (they left, through the foreign key, or became a client viewer), never by hand
-- while they still answer for it; revoking is final (the only change a revoked agent takes is losing its
-- owner that way); revoked_at and revoked_by are stamped here, from the clock and the signed-in person, never
-- supplied; a new owner must be staff of the organisation; no scope twice.
create function private.agents_check_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.org_id <> old.org_id or new.token_sha256 <> old.token_sha256 or new.origin <> old.origin
     or new.token_prefix is distinct from old.token_prefix or new.created_at <> old.created_at then
    raise exception 'an agent''s organisation, token and creation time cannot change' using errcode = '42501';
  end if;
  if new.owner_id is null and old.owner_id is not null and exists (
    select 1 from public.members m
    where m.org_id = old.org_id and m.user_id = old.owner_id and m.role in ('owner', 'admin', 'member'))
  then
    raise exception 'an agent keeps its owner while they are staff; name another owner instead'
      using errcode = '42501';
  end if;
  if old.status = 'revoked' then
    if (new.name, new.scopes, new.status, new.last_used_at, new.revoked_at, new.revoked_by)
         is distinct from (old.name, old.scopes, old.status, old.last_used_at, old.revoked_at, old.revoked_by)
       or (new.owner_id is not null and new.owner_id is distinct from old.owner_id) then
      raise exception 'a revoked agent cannot change; register a new one' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status = 'revoked' then
    new.revoked_at := pg_catalog.now();
    new.revoked_by := (select auth.uid());
  else
    new.revoked_at := null;
    new.revoked_by := null;
  end if;
  if new.owner_id is distinct from old.owner_id and new.owner_id is not null and not exists (
    select 1 from public.members m
    where m.org_id = new.org_id and m.user_id = new.owner_id and m.role in ('owner', 'admin', 'member'))
  then
    raise exception 'an agent''s owner must be a staff member of its organisation' using errcode = '42501';
  end if;
  if cardinality(array(select distinct pg_catalog.unnest(new.scopes))) <> cardinality(new.scopes) then
    raise exception 'an agent names each scope once' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.agents_check_update() from public;
create trigger agents_check_update before update on public.agents
  for each row execute function private.agents_check_update();

-- Revoke in one action: one call sets the status, revoked_at and revoked_by in one statement, writes the
-- history row, and the token stops working for the next call (agent_insert_draft reads only active agents
-- and waits on this row's lock). For an owner or admin of the agent's organisation only; any other agent
-- id, including another organisation's, is "not found". Revoking a revoked agent changes nothing.
create function private.revoke_agent(p_agent uuid)
returns table (agent_id uuid, agent_status text, agent_revoked_at timestamptz, agent_revoked_by uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'sign in to revoke an agent' using errcode = '28000';
  end if;
  perform 1 from public.agents a
    where a.id = p_agent
      and exists (select 1 from public.members m
                  where m.org_id = a.org_id and m.user_id = v_uid and m.role in ('owner', 'admin'))
    for update;
  if not found then
    raise exception 'agent not found' using errcode = 'P0002';
  end if;
  update public.agents a set status = 'revoked' where a.id = p_agent and a.status <> 'revoked';
  return query select a.id, a.status, a.revoked_at, a.revoked_by from public.agents a where a.id = p_agent;
end
$$;
revoke all on function private.revoke_agent(uuid)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant execute on function private.revoke_agent(uuid) to authenticated;

-- A new token: gla_<8 hex>_<43 base64url characters>. The 43 characters are the SHA-256 (32 bytes, so about
-- 256 bits of secret) of three gen_random_uuid() values, which feed it 366 random bits from the server's
-- strong random source (core Postgres, so no extension schema is needed on Supabase or in the tests). The
-- prefix comes from a fourth value, so the secret cannot be worked out from it. Not callable by anyone but
-- its owner: only register_agent calls it.
create function private.agent_token_candidate() returns text
language sql volatile set search_path = ''
as $$
  select 'gla_'
    || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.gen_random_uuid()::text, 'UTF8')), 'hex'), 8)
    || '_'
    || pg_catalog.translate(pg_catalog.rtrim(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text,
         'UTF8')), 'base64'), '='), '+/', '-_')
$$;
revoke all on function private.agent_token_candidate()
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;

-- Register an agent: the ONLY way a row is added after this migration. For an owner or admin of p_org (any
-- other organisation reads "organisation not found"); the owner must be staff of p_org and the scopes on the
-- list, once each (the table's checks and triggers). The database mints the token, stores its SHA-256 and
-- prefix, and returns the token ONCE in the result: it is in no table, log or later answer. A token or
-- prefix that collides with any existing agent's (in any organisation) is retried here, never reported, so
-- no answer says whether another organisation's prefix or hash exists; after three collisions in a row the
-- call fails with a message that names neither.
create function private.register_agent(p_org uuid, p_name text, p_owner uuid, p_scopes text[] default '{}')
returns table (agent_id uuid, token text, token_prefix text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_token text;
  v_id uuid;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'sign in to register an agent' using errcode = '28000';
  end if;
  if not exists (select 1 from public.members m
                 where m.org_id = p_org and m.user_id = v_uid and m.role in ('owner', 'admin')) then
    raise exception 'organisation not found' using errcode = '42501';
  end if;
  -- A missing value is refused here, by name, before anything is minted: Postgres's own not-null error
  -- would print the whole row, minted hash and prefix included.
  if p_name is null then
    raise exception 'an agent needs a name' using errcode = '23502';
  end if;
  if p_owner is null then
    raise exception 'an agent''s owner must be a staff member of its organisation' using errcode = '42501';
  end if;
  if exists (select 1 from public.agents a where a.org_id = p_org and a.name = p_name) then
    raise exception 'this organisation already has an agent with that name' using errcode = '23505';
  end if;
  for attempt in 1 .. 3 loop
    v_token := private.agent_token_candidate();
    begin
      insert into public.agents (org_id, name, owner_id, scopes, token_sha256, token_prefix)
        values (p_org, p_name, p_owner, coalesce(p_scopes, '{}'),
                pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_token, 'UTF8')), 'hex'),
                pg_catalog.substr(v_token, 5, 8))
        returning id into v_id;
      agent_id := v_id; token := v_token; token_prefix := pg_catalog.substr(v_token, 5, 8);
      return next;
      return;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'agents_org_id_name_key' then
          raise exception 'this organisation already has an agent with that name' using errcode = '23505';
        end if;
      -- A rule of the table (the scope list, the name): named, without the row, which runs as the function's
      -- owner and so would otherwise be printed whole, minted hash and prefix included.
      when not_null_violation then
        raise exception 'an agent needs a name, an owner and a list of scopes' using errcode = '23502';
      when check_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if coalesce(v_constraint, '') = '' then
          raise;  -- raised by a trigger of the table with its own message, which names no row
        end if;
        raise exception 'the agent breaks the registry rule %', v_constraint using errcode = '23514';
    end;
  end loop;
  raise exception 'could not mint a new agent token; try again' using errcode = '40001';
end
$$;
revoke all on function private.register_agent(uuid, text, uuid, text[])
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant execute on function private.register_agent(uuid, text, uuid, text[]) to authenticated;

-- The shadow-agent inventory: agents that can still act (active or disabled) and that nobody answers for,
-- or that nobody has used in 30 days (SHADOW_IDLE_DAYS in apps/hosted/agents/registry.ts; a test keeps the
-- two equal). security_invoker: it reads as the caller, so only owners and admins see their own rows.
create view public.agent_shadow_inventory with (security_invoker = true) as
  select a.id, a.org_id, a.name, a.token_prefix, a.owner_id, a.status, a.created_at, a.last_used_at,
    f.reasons
  from public.agents a
  cross join lateral (
    select array_remove(array[
      case when a.owner_id is null then 'no-owner' end,
      case when a.owner_id is not null and not exists (
        select 1 from public.members m
        where m.org_id = a.org_id and m.user_id = a.owner_id and m.role in ('owner', 'admin', 'member'))
        then 'owner-not-staff' end,
      case when coalesce(a.last_used_at, a.created_at) < now() - interval '30 days'
        then 'unused-30-days' end
    ], null) as reasons
  ) f
  where a.status <> 'revoked' and cardinality(f.reasons) > 0;
revoke all on public.agent_shadow_inventory
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant select on public.agent_shadow_inventory to authenticated;

-- The agent's one way in, as in 0005 (same signature, same checks, same messages), with three changes: the
-- token is looked up in the registry and only an ACTIVE agent is recognised (a disabled or revoked one reads
-- as unknown); the agent needs the "draft:<kind>" scope; a successful draft sets last_used_at. The registry
-- row is locked for the call, so a revoke that commits first refuses this call, and one that comes later
-- waits for it.
create or replace function private.agent_insert_draft(
  agent_token text, p_site_id uuid, p_kind text, p_payload jsonb, p_finding_ids uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_agent uuid;
  v_org uuid;
  v_scopes text[];
  v_id uuid;
begin
  if pg_catalog.current_setting('transaction_isolation') = 'repeatable read' then
    raise exception 'agent drafts need READ COMMITTED or SERIALIZABLE, not REPEATABLE READ'
      using errcode = '25000';
  end if;
  if agent_token is null or length(agent_token) < 32 or length(agent_token) > 200 then
    raise exception 'agent token not recognised' using errcode = '28000';
  end if;
  select a.id, a.org_id, a.scopes into v_agent, v_org, v_scopes from public.agents a
    where a.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(agent_token, 'UTF8')), 'hex')
      and a.status = 'active'
    for no key update;
  if v_org is null then
    raise exception 'agent token not recognised' using errcode = '28000';
  end if;
  if not (('draft:' || coalesce(p_kind, '')) = any (v_scopes)) then
    raise exception 'this agent has no scope to draft this kind' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sites s where s.id = p_site_id and s.org_id = v_org) then
    raise exception 'site not found for this agent' using errcode = '42501';
  end if;
  if cardinality(coalesce(p_finding_ids, '{}')) > 50 then
    raise exception 'a draft names at most 50 findings' using errcode = '54000';
  end if;
  if (select count(*) from public.findings f
      where f.id = any(coalesce(p_finding_ids, '{}')) and f.org_id = v_org and f.site_id = p_site_id)
     <> cardinality(array(select distinct pg_catalog.unnest(coalesce(p_finding_ids, '{}'::uuid[])))) then
    raise exception 'finding not found for this site' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_site_id::text, 0));
  if (select count(*) from public.drafts d
      where d.site_id = p_site_id
        and not exists (select 1 from public.decisions x where x.draft_id = d.id
                        and x.decision in ('approved', 'edited', 'declined'))) >= 200 then
    raise exception 'this site already has 200 drafts waiting for a decision; decide or decline some first'
      using errcode = '53400';
  end if;
  insert into public.drafts (org_id, site_id, kind, payload, finding_ids, created_by)
    values (v_org, p_site_id, p_kind, p_payload, coalesce(p_finding_ids, '{}'), null)
    returning id into v_id;
  update public.agents a set last_used_at = pg_catalog.now() where a.id = v_agent;
  return v_id;
end
$$;
revoke all on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[]) to gaugeline_agent;
