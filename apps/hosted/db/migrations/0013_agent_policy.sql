-- Agent policy and limits (AG-03; ADR-0014 "deny by default"). Run as the schema owner ("postgres" on
-- Supabase). The file takes the next free number when it merges (the migrator refuses gaps and repeats).
--
-- Every agent call goes through ONE function, private.agent_authorize(token, tool, cost), before it does
-- anything: it finds the agent, checks the kill switches, the tool against the agent's scopes, the deadline,
-- the rate limit and the cost ceiling, and either counts the call or writes one row to the deny log and
-- refuses. Deny by default: a new agent has no scope, so no tool, and low limits. A refused call returns
-- null with a WARNING that names the reason (it does not raise, so the deny row is kept), and inserts
-- nothing.
--
-- Who reaches what:
--   agent_limits (read; change the four limits), agent_limit_events, agent_denies   owners and admins of the
--                                                    organisation, through RLS
--   private.agent_switches (the operator's kill switches)   the schema owner only
--   private.agent_authorize, private.agent_deny       no login: only the agent's functions call them
-- The agent role still holds no privilege on any table and runs one function (agent_insert_draft).

-- One row per agent: the limits a person sets, and the counters the policy keeps. Integers throughout:
-- cost is in integer micro-units (no floats, no rounding), time in whole seconds and milliseconds.
create table public.agent_limits (
  agent_id uuid primary key,
  org_id uuid not null,
  calls_per_window integer not null default 10
    constraint agent_limits_calls check (calls_per_window between 0 and 10000),
  window_seconds integer not null default 60
    constraint agent_limits_window check (window_seconds between 1 and 86400),
  -- Per UTC day. Today no agent call runs a model, so a draft declares 0 units; the ceiling counts whatever
  -- a call declares (AG-22's model calls will declare theirs).
  cost_ceiling_micros bigint not null default 1000000
    constraint agent_limits_cost check (cost_ceiling_micros between 0 and 1000000000000),
  timeout_ms integer not null default 5000
    constraint agent_limits_timeout check (timeout_ms between 100 and 60000),
  window_started_at timestamptz,
  window_calls integer not null default 0 check (window_calls >= 0),
  cost_day date,
  cost_day_micros bigint not null default 0 check (cost_day_micros >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade
);

-- Every value the limits have had, who set them and when: append-only, written by the trigger below.
create table public.agent_limit_events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  agent_id uuid not null,
  calls_per_window integer not null,
  window_seconds integer not null,
  cost_ceiling_micros bigint not null,
  timeout_ms integer not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade
);
create index agent_limit_events_agent_idx on public.agent_limit_events (agent_id, id);

-- Every refused call: ids, the reason from a closed list, the tool (only a name on the closed tool list,
-- never what the caller typed), the declared cost and the counters. No token, prefix, payload or text. A
-- token that matches no agent belongs to no organisation, so only the schema owner reads that row.
create table public.agent_denies (
  id bigint generated always as identity primary key,
  org_id uuid,
  agent_id uuid,
  tool text check (tool in ('draft:pull_request', 'draft:email', 'draft:sanity_draft', 'read:runs',
    'read:pending')),
  reason text not null constraint agent_denies_reason_known check (reason in ('unknown-agent', 'revoked',
    'disabled', 'scope', 'tool-not-allowed', 'rate-limit', 'cost-ceiling', 'timeout', 'kill-switch-agent',
    'kill-switch-global', 'bad-input')),
  cost_micros bigint check (cost_micros >= 0),
  window_calls integer,
  cost_day_micros bigint,
  denied_at timestamptz not null default now(),
  check ((org_id is null) = (agent_id is null)),
  check ((agent_id is null) = (reason = 'unknown-agent')),
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade
);
create index agent_denies_org_idx on public.agent_denies (org_id, id desc);

-- The operator's kill switches: a row with no agent stops every agent of every organisation; a row with an
-- agent stops that one. Set by the schema owner (an incident), apart from the organisation's own switch
-- (the registry status, `disabled`). Nobody else reads or writes it.
create table private.agent_switches (
  id bigint generated always as identity primary key,
  agent_id uuid unique nulls not distinct references public.agents (id) on delete cascade,
  set_at timestamptz not null default now()
);
alter table private.agent_switches enable row level security;
revoke all on private.agent_switches
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;

alter table public.agent_limits enable row level security;
alter table public.agent_limit_events enable row level security;
alter table public.agent_denies enable row level security;

create policy agent_limits_select on public.agent_limits for select to authenticated
  using (org_id in (select private.admin_org_ids()));
create policy agent_limits_update on public.agent_limits for update to authenticated
  using (org_id in (select private.admin_org_ids()))
  with check (org_id in (select private.admin_org_ids()));
create policy agent_limit_events_select on public.agent_limit_events for select to authenticated
  using (org_id in (select private.admin_org_ids()));
create policy agent_denies_select on public.agent_denies for select to authenticated
  using (org_id in (select private.admin_org_ids()));

-- Grants: take back the defaults, then name the columns. A person changes the four limits only; the
-- counters, timestamps and history are the database's.
revoke all on public.agent_limits, public.agent_limit_events, public.agent_denies
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant select on public.agent_limits, public.agent_limit_events, public.agent_denies to authenticated;
grant update (calls_per_window, window_seconds, cost_ceiling_micros, timeout_ms)
  on public.agent_limits to authenticated;

create trigger agent_limit_events_append_only before update or delete on public.agent_limit_events
  for each row execute function private.refuse_change();
create trigger agent_limit_events_no_truncate before truncate on public.agent_limit_events
  for each statement execute function private.refuse_change();
create trigger agent_denies_append_only before update or delete on public.agent_denies
  for each row execute function private.refuse_change();
create trigger agent_denies_no_truncate before truncate on public.agent_denies
  for each statement execute function private.refuse_change();

-- A change of limits: never for a revoked agent; stamped from the clock and the signed-in person. A change
-- of counters only (the policy's own update) leaves the stamp alone.
create function private.agent_limits_check_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.agent_id <> old.agent_id or new.org_id <> old.org_id then
    raise exception 'an agent''s limits stay with that agent' using errcode = '42501';
  end if;
  if (new.calls_per_window, new.window_seconds, new.cost_ceiling_micros, new.timeout_ms)
       is distinct from (old.calls_per_window, old.window_seconds, old.cost_ceiling_micros, old.timeout_ms)
  then
    if exists (select 1 from public.agents a where a.id = new.agent_id and a.status = 'revoked') then
      raise exception 'a revoked agent cannot change; register a new one' using errcode = '42501';
    end if;
    new.updated_at := pg_catalog.now();
    new.updated_by := (select auth.uid());
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end
$$;
revoke all on function private.agent_limits_check_update() from public;
create trigger agent_limits_check_update before update on public.agent_limits
  for each row execute function private.agent_limits_check_update();

create function private.agent_limits_record() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
     or (new.calls_per_window, new.window_seconds, new.cost_ceiling_micros, new.timeout_ms)
        is distinct from (old.calls_per_window, old.window_seconds, old.cost_ceiling_micros, old.timeout_ms)
  then
    insert into public.agent_limit_events (org_id, agent_id, calls_per_window, window_seconds,
        cost_ceiling_micros, timeout_ms, changed_by)
      values (new.org_id, new.agent_id, new.calls_per_window, new.window_seconds, new.cost_ceiling_micros,
              new.timeout_ms, (select auth.uid()));
  end if;
  return null;
end
$$;
revoke all on function private.agent_limits_record() from public;
create trigger agent_limits_record after insert or update of calls_per_window, window_seconds,
    cost_ceiling_micros, timeout_ms on public.agent_limits
  for each row execute function private.agent_limits_record();

-- Every agent gets its limits row, with the defaults, when it is registered; the agents that exist now get
-- theirs here.
create function private.agent_limits_create() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.agent_limits (agent_id, org_id) values (new.id, new.org_id);
  return null;
end
$$;
revoke all on function private.agent_limits_create() from public;
create trigger agent_limits_create after insert on public.agents
  for each row execute function private.agent_limits_create();
insert into public.agent_limits (agent_id, org_id) select a.id, a.org_id from public.agents a;

-- One deny: the row, then a WARNING the caller sees with the reason (and nothing else).
create function private.agent_deny(p_org uuid, p_agent uuid, p_tool text, p_reason text, p_cost bigint,
  p_calls integer, p_day_cost bigint) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.agent_denies (org_id, agent_id, tool, reason, cost_micros, window_calls, cost_day_micros)
    values (p_org, p_agent, p_tool, p_reason, p_cost, p_calls, p_day_cost);
  raise warning 'agent call denied: %', p_reason;
end
$$;
revoke all on function private.agent_deny(uuid, uuid, text, text, bigint, integer, bigint)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;

-- THE enforcement point. Deny by default: every branch that is not the last one refuses. In order (the
-- first that applies is the reason): unknown-agent, revoked (revoke wins), kill-switch-global, disabled,
-- kill-switch-agent, bad-input (no tool, or a cost that is missing, negative or over 10^12), tool-not-allowed
-- (not on the closed tool list), scope (the agent's scopes do not name it), timeout, rate-limit,
-- cost-ceiling. The agent's registry row and limits row are locked for the rest of the transaction (in that
-- order, always), so two calls cannot both take the last place, and a revoke that commits first wins. The
-- deadline is the agent's timeout from the start of the statement; waiting for a lock past it is a timeout.
-- A fixed window: a burst at a window's edge can reach twice the limit (one row, no log of every call).
create function private.agent_authorize(p_token text, p_tool text, p_cost_micros bigint default 0,
  out allowed boolean, out reason text, out agent_id uuid, out org_id uuid, out deadline timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  c_tools constant text[] := array['draft:pull_request', 'draft:email', 'draft:sanity_draft', 'read:runs', 'read:pending'];
  v_tool text := case when p_tool = any (c_tools) then p_tool end;
  v_cost bigint := case when p_cost_micros between 0 and 1000000000000 then p_cost_micros end;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_agent uuid;
  v_org uuid;
  v_status text;
  v_scopes text[];
  v_lim public.agent_limits;
  v_now timestamptz;
  v_start timestamptz;
  v_calls integer;
  v_day date;
  v_spent bigint;
begin
  allowed := false;
  if p_token is not null and pg_catalog.length(p_token) between 32 and 200 then
    select a.id, a.org_id into v_agent, v_org from public.agents a
      where a.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
  end if;
  if v_agent is null then
    reason := 'unknown-agent';
    perform private.agent_deny(null, null, v_tool, reason, v_cost, null, null);
    return;
  end if;
  agent_id := v_agent;
  org_id := v_org;
  deadline := pg_catalog.statement_timestamp() + pg_catalog.make_interval(secs => coalesce(
    (select l.timeout_ms from public.agent_limits l where l.agent_id = v_agent), 100) / 1000.0);
  begin
    perform pg_catalog.set_config('lock_timeout', greatest(1, ceil(extract(epoch from
      deadline - pg_catalog.clock_timestamp()) * 1000))::bigint || 'ms', true);
    select a.status, a.scopes into v_status, v_scopes from public.agents a where a.id = v_agent
      for no key update;
    -- Close to redundant: the registry row lock above already serialises the calls of one agent, and no
    -- test tells the two apart. Kept so the counters stay safe if another writer of this row is added.
    select * into v_lim from public.agent_limits l where l.agent_id = v_agent for update;
    perform pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
  exception when lock_not_available then
    reason := 'timeout';
    perform private.agent_deny(v_org, v_agent, v_tool, reason, v_cost, null, null);
    return;
  end;
  if v_lim.agent_id is null then
    raise exception 'agent has no limits' using errcode = '42501';  -- cannot happen (trigger); fail closed
  end if;
  v_now := pg_catalog.clock_timestamp();
  if v_lim.window_started_at is null
     or v_now >= v_lim.window_started_at + pg_catalog.make_interval(secs => v_lim.window_seconds) then
    v_start := v_now;
    v_calls := 0;
  else
    v_start := v_lim.window_started_at;
    v_calls := v_lim.window_calls;
  end if;
  v_day := (v_now at time zone 'UTC')::date;
  v_spent := case when v_lim.cost_day = v_day then v_lim.cost_day_micros else 0 end;
  reason := case
    when v_status = 'revoked' then 'revoked'
    when exists (select 1 from private.agent_switches s where s.agent_id is null) then 'kill-switch-global'
    when v_status <> 'active' then 'disabled'
    when exists (select 1 from private.agent_switches s where s.agent_id = v_agent) then 'kill-switch-agent'
    when p_tool is null or pg_catalog.length(p_tool) > 64 or v_cost is null then 'bad-input'
    when v_tool is null then 'tool-not-allowed'
    when not (v_tool = any (v_scopes)) then 'scope'
    when v_now > deadline then 'timeout'
    when v_calls >= v_lim.calls_per_window then 'rate-limit'
    when v_spent + v_cost > v_lim.cost_ceiling_micros then 'cost-ceiling'
  end;
  if reason is not null then
    perform private.agent_deny(v_org, v_agent, v_tool, reason, v_cost, v_calls, v_spent);
    return;
  end if;
  update public.agent_limits l
    set window_started_at = v_start, window_calls = v_calls + 1, cost_day = v_day,
        cost_day_micros = v_spent + v_cost
    where l.agent_id = v_agent;
  allowed := true;
end
$$;
revoke all on function private.agent_authorize(text, text, bigint)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;

-- The agent's one way in, as in 0012 (same signature, same checks and messages after the policy), with
-- the policy first: private.agent_authorize decides on the token and the tool ("draft:<kind>") alone,
-- before the site, the findings or the payload are looked at. A refused call returns null and inserts
-- nothing. The rest of the call keeps to the deadline: waiting for the site's lock past it, or a draft that
-- lands after it, is undone and logged as a timeout. The policy's call and the draft run in one block, so
-- a timeout undoes the counted call with the draft (a refused call uses no slot and no cost), and the
-- timeout's deny row carries the counters as they are once it is undone.
create or replace function private.agent_insert_draft(
  agent_token text, p_site_id uuid, p_kind text, p_payload jsonb, p_finding_ids uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_allowed boolean;
  v_agent uuid;
  v_org uuid;
  v_deadline timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_id uuid;
  v_calls integer;
  v_spent bigint;
begin
  if pg_catalog.current_setting('transaction_isolation') = 'repeatable read' then
    raise exception 'agent drafts need READ COMMITTED or SERIALIZABLE, not REPEATABLE READ'
      using errcode = '25000';
  end if;
  begin
    select z.allowed, z.agent_id, z.org_id, z.deadline into v_allowed, v_agent, v_org, v_deadline
      from private.agent_authorize(agent_token, 'draft:' || p_kind, 0) z;
    if not v_allowed then
      return null;  -- leaves the block normally: the deny row stays
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
    perform pg_catalog.set_config('lock_timeout', greatest(1, ceil(extract(epoch from
      v_deadline - pg_catalog.clock_timestamp()) * 1000))::bigint || 'ms', true);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_site_id::text, 0));
    perform pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
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
    if pg_catalog.clock_timestamp() > v_deadline then
      raise exception 'past the deadline' using errcode = 'GLT01';
    end if;
  exception when lock_not_available or sqlstate 'GLT01' then
    -- The block is undone, the policy's count with it; the variables keep their values.
    select case when l.window_started_at is null or pg_catalog.clock_timestamp()
                  >= l.window_started_at + pg_catalog.make_interval(secs => l.window_seconds)
                then 0 else l.window_calls end,
           case when l.cost_day = (pg_catalog.clock_timestamp() at time zone 'UTC')::date
                then l.cost_day_micros else 0 end
      into v_calls, v_spent
      from public.agent_limits l where l.agent_id = v_agent;
    perform private.agent_deny(v_org, v_agent, 'draft:' || p_kind, 'timeout', 0, v_calls, v_spent);
    return null;
  end;
  update public.agents a set last_used_at = pg_catalog.now() where a.id = v_agent;
  return v_id;
end
$$;
revoke all on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[]) to gaugeline_agent;
