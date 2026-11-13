-- Agent token expiry (AG-02b; ADR-0014 threat T10). Run as the schema owner ("postgres" on Supabase). The
-- file takes the next free number when it merges (the migrator refuses gaps and repeats).
--
-- An agent row gets a nullable `expires_at`. Null means the token never expires, which is every agent that
-- exists now: nothing about an existing agent changes. An agent whose `expires_at` has passed is refused
-- exactly like a disabled one, on every path that authenticates a token: they all go through
-- private.agent_authorize (0013), which is the only place a token's hash is looked up. The refusal is the
-- existing reason `disabled`, so the eleven reason codes of the deny log and the trace stay as they are and
-- nothing in an answer says that a token has expired.
--
-- Who sets it: an owner or admin of the agent's organisation, through private.set_agent_expiry, one call
-- (like private.revoke_agent). Nobody signed in can write the column any other way, and the agent's own
-- role cannot call the function. No new role, no new login, no new table, no new reason code.

alter table public.agents add column expires_at timestamptz;

-- Read by owners and admins (the registry listing and the scorecard show it); written only by the function
-- below, so no column is added to the UPDATE grant of 0012.
grant select (expires_at) on public.agents to authenticated;

-- Set or clear an agent's expiry, in one call. For an owner or admin of the agent's organisation; any other
-- agent id, including another organisation's, is "not found". A time that has already passed is refused
-- unless the caller passes p_allow_past = true: that ends the token now, which is a thing to do on purpose
-- and not by a mistyped date. Null clears the expiry (the token never expires, and an expired agent works
-- again): clearing is explicit too, so it is a separate value, not a default. A revoked agent cannot change.
-- The database's clock decides what is past: clock_timestamp(), as in agent_authorize, never the
-- transaction's start time, so a long transaction cannot slip a past time through.
create function private.set_agent_expiry(p_agent uuid, p_expires_at timestamptz,
  p_allow_past boolean default false)
returns table (agent_id uuid, agent_expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_status text;
begin
  if v_uid is null then
    raise exception 'sign in to set an agent''s expiry' using errcode = '28000';
  end if;
  select a.status into v_status from public.agents a
    where a.id = p_agent
      and exists (select 1 from public.members m
                  where m.org_id = a.org_id and m.user_id = v_uid and m.role in ('owner', 'admin'))
    for update;
  if not found then
    raise exception 'agent not found' using errcode = 'P0002';
  end if;
  if v_status = 'revoked' then
    raise exception 'a revoked agent cannot change; register a new one' using errcode = '42501';
  end if;
  if p_expires_at in ('infinity'::timestamptz, '-infinity'::timestamptz) then
    raise exception 'an expiry is a date and time; clear it (null) for a token that never expires'
      using errcode = '22023';
  end if;
  if p_expires_at <= pg_catalog.clock_timestamp() and not coalesce(p_allow_past, false) then
    raise exception 'that expiry is in the past and would end the token now; pass p_allow_past = true to do that on purpose'
      using errcode = '22023';
  end if;
  update public.agents a set expires_at = p_expires_at where a.id = p_agent;
  return query select a.id, a.expires_at from public.agents a where a.id = p_agent;
end
$$;
revoke all on function private.set_agent_expiry(uuid, timestamptz, boolean)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant execute on function private.set_agent_expiry(uuid, timestamptz, boolean) to authenticated;

-- THE enforcement point (0013), with one change: the registry row is read with its expiry, and an agent
-- whose expiry has passed on the call's own clock (clock_timestamp(), read once the row is locked, so a long
-- transaction cannot use a stale now()) is refused like a disabled one. Everything else is as in 0013:
-- revoked still wins, the operator's global switch still comes before `disabled`, and a refused call uses
-- no slot, no cost and does not set "last used".
create or replace function private.agent_authorize(p_token text, p_tool text, p_cost_micros bigint default 0,
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
  v_expires timestamptz;
  v_expired boolean;
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
    select a.status, a.scopes, a.expires_at into v_status, v_scopes, v_expires from public.agents a
      where a.id = v_agent for no key update;
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
  v_expired := v_expires is not null and v_expires <= v_now;
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
    when v_status <> 'active' or v_expired then 'disabled'
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
