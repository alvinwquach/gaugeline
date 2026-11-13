-- The agent trace (AG-05; ADR-0014 "every agent call is traced"). Run as the schema owner ("postgres" on
-- Supabase). The file takes the next free number when it merges (the migrator refuses gaps and repeats).
--
-- One append-only row per agent call: the agent's registry id, the tool (a name on the closed list), the
-- SHA-256 of the call's input and of its output (never the input or output), the latency in whole
-- milliseconds, the tokens and cost (integers; 0 today, because no agent call runs a model), the decision
-- (allowed, denied, approved, declined), the deny reason from 0013's closed list, the approver (a member id)
-- of an approved or declined draft, and the draft's id. No token, payload, text, address or name.
--
-- Bounded: a token that matches no agent belongs to no organisation, and a flood of them must not grow a
-- table without limit, so those calls are counted per minute in ONE row of agent_trace_overflow; and an
-- agent's refused calls past 60 in one minute are counted there too, per reason, instead of one row each.
--
-- Accepted risk (independent review of AG-05): a trace is written in the caller's transaction; a holder of
-- the agent database login who rolls back a read leaves none (nor a counted call); the login can reach only
-- its own organisation's pending drafts and run history. The app's own path (lib/api/db.ts withAgent)
-- commits every call, so its calls are always traced.
--
-- Who reaches what:
--   agent_trace, agent_trace_overflow     owners and admins of the organisation, through RLS (read only)
--   private.agent_trace_record            no login: only the agent's draft entry and the decisions trigger
-- The agent role still holds no privilege on any table and runs its three functions (agent_insert_draft and
-- AG-08's two reads, 0014), each now writing its trace row.

create table public.agent_trace (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  agent_id uuid not null,
  tool text check (tool in ('draft:pull_request', 'draft:email', 'draft:sanity_draft', 'read:runs',
    'read:pending')),
  input_sha256 text check (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 text check (output_sha256 ~ '^[0-9a-f]{64}$'),
  -- Whole milliseconds. For a call, how long it ran; for an approval or a decline, how long the draft
  -- waited for the person (bigint: a draft may wait longer than an integer's 24 days).
  latency_ms bigint not null check (latency_ms between 0 and 31536000000),
  -- Integers, as in 0013: tokens counted, cost in micro-units. 0 until a call runs a model (AG-19+).
  tokens bigint not null default 0 check (tokens between 0 and 1000000000000),
  cost_micros bigint not null default 0 check (cost_micros between 0 and 1000000000000),
  decision text not null constraint agent_trace_decision_known
    check (decision in ('allowed', 'denied', 'approved', 'declined')),
  reason text constraint agent_trace_reason_known check (reason in ('unknown-agent', 'revoked',
    'disabled', 'scope', 'tool-not-allowed', 'rate-limit', 'cost-ceiling', 'timeout', 'kill-switch-agent',
    'kill-switch-global', 'bad-input')),
  approver_id uuid,
  draft_id uuid,
  at timestamptz not null default now(),
  constraint agent_trace_reason_iff_denied check ((decision = 'denied') = (reason is not null)),
  constraint agent_trace_approver_iff_decided
    check ((decision in ('approved', 'declined')) = (approver_id is not null)),
  constraint agent_trace_draft_iff_decided
    check (decision not in ('approved', 'declined') or draft_id is not null),
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade
);
create index agent_trace_org_idx on public.agent_trace (org_id, id desc);
create index agent_trace_agent_idx on public.agent_trace (agent_id, at);
create index agent_trace_draft_idx on public.agent_trace (draft_id) where draft_id is not null;

-- The counters that keep the trace bounded: per minute, per agent (none for an unknown token) and reason.
create table public.agent_trace_overflow (
  minute timestamptz not null check (minute = pg_catalog.date_trunc('minute', minute)),
  org_id uuid,
  agent_id uuid,
  reason text not null check (reason in ('unknown-agent', 'revoked', 'disabled', 'scope',
    'tool-not-allowed', 'rate-limit', 'cost-ceiling', 'timeout', 'kill-switch-agent', 'kill-switch-global',
    'bad-input')),
  calls bigint not null check (calls >= 1),
  check ((org_id is null) = (agent_id is null)),
  check ((agent_id is null) = (reason = 'unknown-agent')),
  unique nulls not distinct (minute, agent_id, reason),
  foreign key (agent_id, org_id) references public.agents (id, org_id) on delete cascade
);

alter table public.agent_trace enable row level security;
alter table public.agent_trace_overflow enable row level security;
create policy agent_trace_select on public.agent_trace for select to authenticated
  using (org_id in (select private.admin_org_ids()));
create policy agent_trace_overflow_select on public.agent_trace_overflow for select to authenticated
  using (org_id in (select private.admin_org_ids()));

revoke all on public.agent_trace, public.agent_trace_overflow
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant select on public.agent_trace, public.agent_trace_overflow to authenticated;

create trigger agent_trace_append_only before update or delete on public.agent_trace
  for each row execute function private.refuse_change();
create trigger agent_trace_no_truncate before truncate on public.agent_trace
  for each statement execute function private.refuse_change();

-- THE one writer. Checks everything it is handed (fail closed: a bad value raises, and the caller's call is
-- undone with it), scopes the agent, the approver and the draft to the organisation, then writes one row,
-- or counts the call in the minute's overflow row. Messages name the rule, never a value.
create function private.agent_trace_record(
  p_org uuid, p_agent uuid, p_tool text, p_input_sha256 text, p_output_sha256 text, p_latency_ms bigint,
  p_tokens bigint, p_cost_micros bigint, p_decision text, p_reason text, p_approver uuid, p_draft uuid
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_minute timestamptz := pg_catalog.date_trunc('minute', pg_catalog.now());
  v_rule text;
begin
  if p_decision is null or p_decision not in ('allowed', 'denied', 'approved', 'declined') then
    raise exception 'agent trace: unknown decision' using errcode = '22023';
  end if;
  if (p_decision = 'denied') <> (p_reason is not null) then
    raise exception 'agent trace: a reason goes with a deny, and only with a deny' using errcode = '22023';
  end if;
  if p_latency_ms is null or p_tokens is null or p_cost_micros is null
     or p_latency_ms not between 0 and 31536000000 or p_tokens not between 0 and 1000000000000
     or p_cost_micros not between 0 and 1000000000000 then
    raise exception 'agent trace: latency, tokens and cost are whole numbers in range' using errcode = '22023';
  end if;
  if p_agent is null then
    if p_org is not null or p_reason is distinct from 'unknown-agent' then
      raise exception 'agent trace: only an unknown token has no agent' using errcode = '22023';
    end if;
    insert into public.agent_trace_overflow as o (minute, org_id, agent_id, reason, calls)
      values (v_minute, null, null, 'unknown-agent', 1)
      on conflict (minute, agent_id, reason) do update set calls = o.calls + 1;
    return;
  end if;
  if not exists (select 1 from public.agents a where a.id = p_agent and a.org_id = p_org) then
    raise exception 'agent trace: agent not found in this organisation' using errcode = '42501';
  end if;
  if p_approver is not null and not exists (select 1 from public.members m
      where m.org_id = p_org and m.user_id = p_approver and m.role in ('owner', 'admin', 'member')) then
    raise exception 'agent trace: the approver is not staff of this organisation' using errcode = '42501';
  end if;
  if p_draft is not null and not exists (select 1 from public.drafts d where d.id = p_draft and d.org_id = p_org)
  then
    raise exception 'agent trace: draft not found in this organisation' using errcode = '42501';
  end if;
  if p_decision = 'denied' and (select count(*) from public.agent_trace t
      where t.agent_id = p_agent and t.decision = 'denied' and t.at >= v_minute) >= 60 then
    insert into public.agent_trace_overflow as o (minute, org_id, agent_id, reason, calls)
      values (v_minute, p_org, p_agent, p_reason, 1)
      on conflict (minute, agent_id, reason) do update set calls = o.calls + 1;
    return;
  end if;
  insert into public.agent_trace (org_id, agent_id, tool, input_sha256, output_sha256, latency_ms, tokens,
      cost_micros, decision, reason, approver_id, draft_id)
    values (p_org, p_agent, p_tool, p_input_sha256, p_output_sha256, p_latency_ms, p_tokens, p_cost_micros,
            p_decision, p_reason, p_approver, p_draft);
exception
  -- A table rule (a hash that is not 64 hex characters, a tool off the list): named, never the row, which
  -- runs as the owner and would otherwise be printed whole.
  when check_violation then
    get stacked diagnostics v_rule = constraint_name;
    raise exception 'agent trace: a value breaks the rule %', coalesce(v_rule, '?') using errcode = '23514';
end
$$;
revoke all on function private.agent_trace_record(uuid, uuid, text, text, text, bigint, bigint, bigint, text,
  text, uuid, uuid)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;

-- The input hash: every argument but the token, as one jsonb object (keys in jsonb's own order, so the
-- same call always gives the same text), Unicode NFC, UTF-8, SHA-256, hex.
create function private.agent_trace_input(p_site_id uuid, p_kind text, p_payload jsonb, p_finding_ids uuid[])
returns text
language sql immutable set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.normalize(
    pg_catalog.jsonb_build_object('site_id', p_site_id, 'kind', p_kind, 'payload', p_payload,
      'finding_ids', p_finding_ids)::text, 'NFC'), 'UTF8')), 'hex')
$$;
-- Whole milliseconds since p_start, never negative.
create function private.agent_trace_ms(p_start timestamptz) returns bigint
language sql volatile set search_path = ''
as $$
  select greatest(0, pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp() - p_start) * 1000))::bigint
$$;
revoke all on function private.agent_trace_input(uuid, text, jsonb, uuid[]), private.agent_trace_ms(timestamptz)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;

-- The agent's one way in, as in 0013 (same signature, same checks, messages and deny rows), and now one
-- trace row per call in the same transaction: allowed with the new draft's id, or denied with the reason.
-- A refused call still writes its trace and still inserts no draft. A call that raises is undone whole:
-- nothing of it is stored (not even the policy's count). The input hash is the SHA-256 of the call's
-- arguments but the token, as one jsonb object in Unicode NFC (`{"finding_ids": [...], "kind": ...,
-- "payload": {...}, "site_id": ...}`, Postgres's own jsonb text); the output hash is the SHA-256 of the
-- draft id's text. A call runs no model: tokens and cost are 0.
create or replace function private.agent_insert_draft(
  agent_token text, p_site_id uuid, p_kind text, p_payload jsonb, p_finding_ids uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_tool text := case when ('draft:' || p_kind) in ('draft:pull_request', 'draft:email', 'draft:sanity_draft')
                      then 'draft:' || p_kind end;
  v_allowed boolean;
  v_reason text;
  v_agent uuid;
  v_org uuid;
  v_deadline timestamptz;
  v_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_id uuid;
  v_calls integer;
  v_spent bigint;
  v_input text;
begin
  if pg_catalog.current_setting('transaction_isolation') = 'repeatable read' then
    raise exception 'agent drafts need READ COMMITTED or SERIALIZABLE, not REPEATABLE READ'
      using errcode = '25000';
  end if;
  begin
    select z.allowed, z.reason, z.agent_id, z.org_id, z.deadline
      into v_allowed, v_reason, v_agent, v_org, v_deadline
      from private.agent_authorize(agent_token, 'draft:' || p_kind, 0) z;
    if not v_allowed then
      -- Leaves the block normally: the deny row and this trace row stay. No hash for an unknown token.
      if v_agent is not null then
        v_input := private.agent_trace_input(p_site_id, p_kind, p_payload, p_finding_ids);
      end if;
      perform private.agent_trace_record(v_org, v_agent, v_tool, v_input, null,
        private.agent_trace_ms(v_start), 0, 0, 'denied', v_reason, null, null);
      return null;
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
    perform private.agent_trace_record(v_org, v_agent, v_tool,
      private.agent_trace_input(p_site_id, p_kind, p_payload, p_finding_ids), null,
      private.agent_trace_ms(v_start), 0, 0, 'denied', 'timeout', null, null);
    return null;
  end;
  update public.agents a set last_used_at = pg_catalog.now() where a.id = v_agent;
  perform private.agent_trace_record(v_org, v_agent, v_tool,
    private.agent_trace_input(p_site_id, p_kind, p_payload, p_finding_ids),
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_id::text, 'UTF8')), 'hex'),
    private.agent_trace_ms(v_start), 0, 0, 'allowed', null, null, v_id);
  return v_id;
end
$$;
revoke all on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[]) to gaugeline_agent;

-- An approval or a decline of a draft an AGENT proposed (it has an allowed trace row), from the inbox or
-- from chat (both write public.decisions): one trace row with the person who decided. "edited" is an
-- approval of an edited draft, so it is traced as approved; its input hash is the approved payload's
-- (0005's payload_sha256). A person's own draft has no agent and no trace row.
create function private.agent_trace_decision() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_agent uuid;
  v_tool text;
  v_created timestamptz;
begin
  select t.agent_id, t.tool into v_agent, v_tool from public.agent_trace t
    where t.draft_id = new.draft_id and t.org_id = new.org_id and t.decision = 'allowed'
    order by t.id limit 1;
  if v_agent is null then
    return null;
  end if;
  select d.created_at into v_created from public.drafts d where d.id = new.draft_id;
  perform private.agent_trace_record(new.org_id, v_agent, v_tool, new.payload_sha256, null,
    greatest(0, least(31536000000, pg_catalog.floor(extract(epoch from new.decided_at - v_created) * 1000)))::bigint,
    0, 0, case when new.decision = 'declined' then 'declined' else 'approved' end, null, new.decided_by,
    new.draft_id);
  return null;
end
$$;
revoke all on function private.agent_trace_decision()
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
create trigger decisions_agent_trace after insert on public.decisions
  for each row execute function private.agent_trace_decision();

-- One trace row for an agent read (AG-08's two functions): the input hash is the SHA-256 of the call's
-- arguments but the token (one jsonb object, NFC), the output hash that of the jsonb answer when the call
-- was allowed. Tokens and cost are 0: a read runs no model.
create function private.agent_trace_read(p_org uuid, p_agent uuid, p_tool text, p_input jsonb, p_out jsonb,
  p_start timestamptz, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.agent_trace_record(p_org, p_agent, p_tool,
    case when p_agent is not null then pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.normalize(p_input::text, 'NFC'), 'UTF8')), 'hex') end,
    case when p_reason is null then pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      p_out::text, 'UTF8')), 'hex') end,
    private.agent_trace_ms(p_start), 0, 0, case when p_reason is null then 'allowed' else 'denied' end,
    p_reason, null, null);
end
$$;
revoke all on function private.agent_trace_read(uuid, uuid, text, jsonb, jsonb, timestamptz, text)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;

-- AG-08's two reads (0014), unchanged but for one trace row at each way out: refused, timed out, or answered.
create or replace function private.agent_list_pending(
  p_token text,
  p_limit integer default 20,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null,
  p_draft uuid default null,
  p_site uuid default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_out jsonb;
  v_allowed boolean;
  v_reason text;
  v_agent uuid;
  v_org uuid;
  v_deadline timestamptz;
  v_rows jsonb;
  v_calls integer;
  v_spent bigint;
begin
  -- The caller's own mistakes, refused before the policy (no count, no deny row): a page of 1 to 50, and a
  -- cursor that is both halves or neither.
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'limit must be 1 to 50' using errcode = '22023';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'a cursor has a time and an id' using errcode = '22023';
  end if;
  begin
    select z.allowed, z.reason, z.agent_id, z.org_id, z.deadline
      into v_allowed, v_reason, v_agent, v_org, v_deadline
      from private.agent_authorize(p_token, 'read:pending', 0) z;
    if not v_allowed then
      v_out := pg_catalog.jsonb_build_object('allowed', false, 'reason', v_reason);
      perform private.agent_trace_read(v_org, v_agent, 'read:pending', pg_catalog.jsonb_build_object('limit', p_limit, 'cursor_at', p_cursor_at, 'cursor_id', p_cursor_id, 'draft', p_draft, 'site', p_site), v_out, v_start, v_reason);
      return v_out;
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'site_id', p.site_id, 'kind', p.kind, 'title', p.title, 'excerpt', p.excerpt,
        'payload_sha256', p.sha, 'created_at', p.created, 'expires_at', p.expires, 'cursor_at', p.cursor_at,
        'finding_ids', p.finding_ids) order by p.created_at desc, p.id desc), '[]'::jsonb)
      into v_rows
      from (
        select d.id, d.site_id, d.kind, d.created_at, d.created_at::text as cursor_at,
          pg_catalog.to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created,
          pg_catalog.to_char((d.created_at + interval '72 hours') at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires,
          case d.kind
            when 'email' then d.payload ->> 'subject'
            when 'pull_request' then d.payload ->> 'title'
            when 'sanity_draft' then (d.payload ->> 'documentType') || ' ' || (d.payload ->> 'documentId')
          end as title,
          -- At most 600 characters of the body; for a Sanity draft, the names of the fields it sets (not
          -- their values). The API cuts it shorter.
          case d.kind
            when 'sanity_draft' then 'fields: ' || (select pg_catalog.string_agg(k, ', ' order by k)
              from pg_catalog.jsonb_object_keys(d.payload -> 'set') k)
            else pg_catalog.left(d.payload ->> 'body', 600)
          end as excerpt,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.payload::text, 'UTF8')), 'hex') as sha,
          d.finding_ids
        from public.drafts d
        where d.org_id = v_org
          and d.created_at > pg_catalog.now() - interval '72 hours'
          and not exists (select 1 from public.decisions x where x.draft_id = d.id)
          and (p_draft is null or d.id = p_draft)
          and (p_site is null or d.site_id = p_site)
          and (p_cursor_at is null or (d.created_at, d.id) < (p_cursor_at, p_cursor_id))
        order by d.created_at desc, d.id desc
        limit p_limit + 1
      ) p;
    if pg_catalog.clock_timestamp() > v_deadline then
      raise exception 'past the deadline' using errcode = 'GLT01';
    end if;
  exception when sqlstate 'GLT01' then
    -- As in agent_insert_draft (0013): the block is undone, the policy's count with it, and the deny row
    -- carries the counters as they are once it is undone.
    select case when l.window_started_at is null or pg_catalog.clock_timestamp()
                  >= l.window_started_at + pg_catalog.make_interval(secs => l.window_seconds)
                then 0 else l.window_calls end,
           case when l.cost_day = (pg_catalog.clock_timestamp() at time zone 'UTC')::date
                then l.cost_day_micros else 0 end
      into v_calls, v_spent
      from public.agent_limits l where l.agent_id = v_agent;
    perform private.agent_deny(v_org, v_agent, 'read:pending', 'timeout', 0, v_calls, v_spent);
    v_out := pg_catalog.jsonb_build_object('allowed', false, 'reason', 'timeout');
    perform private.agent_trace_read(v_org, v_agent, 'read:pending', pg_catalog.jsonb_build_object('limit', p_limit, 'cursor_at', p_cursor_at, 'cursor_id', p_cursor_id, 'draft', p_draft, 'site', p_site), v_out, v_start, 'timeout');
    return v_out;
  end;
  update public.agents a set last_used_at = pg_catalog.now() where a.id = v_agent;
  v_out := pg_catalog.jsonb_build_object('allowed', true,
    'more', pg_catalog.jsonb_array_length(v_rows) > p_limit,
    'drafts', case when pg_catalog.jsonb_array_length(v_rows) > p_limit
                   then v_rows - p_limit else v_rows end);
  perform private.agent_trace_read(v_org, v_agent, 'read:pending', pg_catalog.jsonb_build_object('limit', p_limit, 'cursor_at', p_cursor_at, 'cursor_id', p_cursor_id, 'draft', p_draft, 'site', p_site), v_out, v_start, null);
  return v_out;
end
$$;

create or replace function private.agent_list_runs(
  p_token text,
  p_site uuid,
  p_limit integer default 20,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null,
  p_since timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_out jsonb;
  v_allowed boolean;
  v_reason text;
  v_agent uuid;
  v_org uuid;
  v_deadline timestamptz;
  v_rows jsonb;
  v_found boolean;
  v_calls integer;
  v_spent bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'limit must be 1 to 50' using errcode = '22023';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'a cursor has a time and an id' using errcode = '22023';
  end if;
  begin
    select z.allowed, z.reason, z.agent_id, z.org_id, z.deadline
      into v_allowed, v_reason, v_agent, v_org, v_deadline
      from private.agent_authorize(p_token, 'read:runs', 0) z;
    if not v_allowed then
      v_out := pg_catalog.jsonb_build_object('allowed', false, 'reason', v_reason);
      perform private.agent_trace_read(v_org, v_agent, 'read:runs', pg_catalog.jsonb_build_object('site', p_site, 'limit', p_limit, 'cursor_at', p_cursor_at, 'cursor_id', p_cursor_id, 'since', p_since), v_out, v_start, v_reason);
      return v_out;
    end if;
    v_found := exists (select 1 from public.sites s where s.id = p_site and s.org_id = v_org);
    if v_found then
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', r.id, 'started_at', r.started, 'finished_at', r.finished, 'summary', r.summary,
          'cursor_at', r.cursor_at) order by r.started_at desc, r.id desc), '[]'::jsonb)
        into v_rows
        from (
          select x.id, x.started_at, x.started_at::text as cursor_at, x.summary,
            pg_catalog.to_char(x.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started,
            pg_catalog.to_char(x.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished
          from public.runs x
          where x.org_id = v_org and x.site_id = p_site
            and (p_since is null or x.started_at > p_since)
            and (p_cursor_at is null or (x.started_at, x.id) < (p_cursor_at, p_cursor_id))
          order by x.started_at desc, x.id desc
          limit p_limit + 1
        ) r;
    end if;
    if pg_catalog.clock_timestamp() > v_deadline then
      raise exception 'past the deadline' using errcode = 'GLT01';
    end if;
  exception when sqlstate 'GLT01' then
    select case when l.window_started_at is null or pg_catalog.clock_timestamp()
                  >= l.window_started_at + pg_catalog.make_interval(secs => l.window_seconds)
                then 0 else l.window_calls end,
           case when l.cost_day = (pg_catalog.clock_timestamp() at time zone 'UTC')::date
                then l.cost_day_micros else 0 end
      into v_calls, v_spent
      from public.agent_limits l where l.agent_id = v_agent;
    perform private.agent_deny(v_org, v_agent, 'read:runs', 'timeout', 0, v_calls, v_spent);
    v_out := pg_catalog.jsonb_build_object('allowed', false, 'reason', 'timeout');
    perform private.agent_trace_read(v_org, v_agent, 'read:runs', pg_catalog.jsonb_build_object('site', p_site, 'limit', p_limit, 'cursor_at', p_cursor_at, 'cursor_id', p_cursor_id, 'since', p_since), v_out, v_start, 'timeout');
    return v_out;
  end;
  update public.agents a set last_used_at = pg_catalog.now() where a.id = v_agent;
  if not v_found then
    v_out := pg_catalog.jsonb_build_object('allowed', true, 'found', false);
    perform private.agent_trace_read(v_org, v_agent, 'read:runs', pg_catalog.jsonb_build_object('site', p_site, 'limit', p_limit, 'cursor_at', p_cursor_at, 'cursor_id', p_cursor_id, 'since', p_since), v_out, v_start, null);
    return v_out;
  end if;
  v_out := pg_catalog.jsonb_build_object('allowed', true, 'found', true,
    'more', pg_catalog.jsonb_array_length(v_rows) > p_limit,
    'runs', case when pg_catalog.jsonb_array_length(v_rows) > p_limit
                 then v_rows - p_limit else v_rows end);
  perform private.agent_trace_read(v_org, v_agent, 'read:runs', pg_catalog.jsonb_build_object('site', p_site, 'limit', p_limit, 'cursor_at', p_cursor_at, 'cursor_id', p_cursor_id, 'since', p_since), v_out, v_start, null);
  return v_out;
end
$$;
