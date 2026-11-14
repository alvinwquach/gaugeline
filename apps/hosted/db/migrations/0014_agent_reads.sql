-- Agent reads (AG-08; ADR-0014): the two reserved scopes become real. Run as the schema owner ("postgres"
-- on Supabase). The file takes the next free number when it merges (the migrator refuses gaps and repeats).
--
-- An agent may now READ two things, each through one SECURITY DEFINER function that only gaugeline_agent may
-- run (the role still holds no privilege on any table):
--   private.agent_list_pending(token, ...)   the drafts of the token's organisation waiting for a decision
--                                            (scope read:pending)
--   private.agent_list_runs(token, site, ...) the run history of one site of that organisation (read:runs)
-- The organisation comes from the token, never from the caller. Each call goes through
-- private.agent_authorize EXACTLY ONCE, with its own scope, before anything is read: a refused call reads
-- nothing, returns {"allowed": false, "reason": ...} and leaves its row in the deny log. Nothing here
-- decides, approves or changes a draft: assistants plan, people approve.
--
-- Both return one jsonb value (not rows), so a refusal and an empty page cannot be confused.

-- Pending: a draft with no decision row at all, created less than 72 hours ago (an approval after 72 hours
-- is refused: 0010's chat_decide; ADR-0010). Newest first, by (created_at, id), so a page is deterministic
-- and the cursor is the last row's pair. Only safe fields: ids, the kind, the title words, a bounded
-- excerpt of the body (never a file's content or a field's value), the SHA-256 of the exact payload (the
-- hash an approval would record, 0005), times and finding ids. The excerpt is the agent's own text, which
-- may quote a page: the API sanitises it, scans it for keys and marks it untrusted.
create function private.agent_list_pending(
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
      return pg_catalog.jsonb_build_object('allowed', false, 'reason', v_reason);
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
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'timeout');
  end;
  update public.agents a set last_used_at = pg_catalog.now() where a.id = v_agent;
  return pg_catalog.jsonb_build_object('allowed', true,
    'more', pg_catalog.jsonb_array_length(v_rows) > p_limit,
    'drafts', case when pg_catalog.jsonb_array_length(v_rows) > p_limit
                   then v_rows - p_limit else v_rows end);
end
$$;
revoke all on function private.agent_list_pending(text, integer, timestamptz, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant execute on function private.agent_list_pending(text, integer, timestamptz, uuid, uuid, uuid)
  to gaugeline_agent;

-- Run history of ONE site of the token's organisation: the same fields GET /api/v1/runs returns for a
-- site's own token (id, start, finish, the CLI's summary counts), newest first by (started_at, id). A site
-- of another organisation, or none, is "found": false, exactly like a site that does not exist. The runs'
-- findings are not here: a finding's title and evidence quote the page, and the per-site token still
-- reads them (GET /api/v1/runs/:id/findings).
create function private.agent_list_runs(
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
      return pg_catalog.jsonb_build_object('allowed', false, 'reason', v_reason);
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
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'timeout');
  end;
  update public.agents a set last_used_at = pg_catalog.now() where a.id = v_agent;
  if not v_found then
    return pg_catalog.jsonb_build_object('allowed', true, 'found', false);
  end if;
  return pg_catalog.jsonb_build_object('allowed', true, 'found', true,
    'more', pg_catalog.jsonb_array_length(v_rows) > p_limit,
    'runs', case when pg_catalog.jsonb_array_length(v_rows) > p_limit
                 then v_rows - p_limit else v_rows end);
end
$$;
revoke all on function private.agent_list_runs(text, uuid, integer, timestamptz, uuid, timestamptz)
  from public, anon, authenticated, service_role, gaugeline_agent, gaugeline_worker, gaugeline_chat;
grant execute on function private.agent_list_runs(text, uuid, integer, timestamptz, uuid, timestamptz)
  to gaugeline_agent;
